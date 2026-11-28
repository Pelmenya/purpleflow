import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { ServerConfig } from './config.js';
import { hashSecret, readLoginSecret, verifySecret } from './secret.js';
import { WINDOW_ROUTES } from './web-assets.js';

export interface Sessions {
  login(candidate: string): LoginResult;
  validate(token: string): boolean;
  expiresAt(token: string): number | undefined;
  logout(token: string): void;
  logoutAll(): void;
  guard(req: IncomingMessage, res: ServerResponse): boolean;
}

export type LoginResult =
  | { kind: 'token'; token: string; maxAgeSec: number }
  | { kind: 'invalid' }
  | { kind: 'rateLimited'; retryAfterSec: number }
  | { kind: 'unavailable' };

export type BodyResult = { kind: 'ok'; body: string } | { kind: 'bodyTooLarge' } | { kind: 'timeout' } | { kind: 'aborted' };

export interface CreateSessionsOptions {
  secret?: string;
  secretHash?: string;
  file?: string;
  ttlMs?: number;
  now?: () => number;
}

export interface ReadBodyOptions {
  limit?: number;
  timeoutMs?: number;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function writeSessions(file: string, secretTag: string, sessions: Map<string, number>): void {
  const data = JSON.stringify({
    secretTag,
    sessions: [...sessions].map(([hash, expiresAt]) => ({ hash, expiresAt })),
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function readSessions(file: string | undefined, secretTag: string, now: () => number): Map<string, number> {
  const sessions = new Map<string, number>();
  if (!file) return sessions;
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      secretTag?: unknown;
      sessions?: { hash?: unknown; expiresAt?: unknown }[];
    };
    if (stored.secretTag !== secretTag || !Array.isArray(stored.sessions)) return sessions;
    const current = now();
    for (const entry of stored.sessions) {
      if (
        entry &&
        typeof entry.hash === 'string' &&
        /^[a-f0-9]{64}$/.test(entry.hash) &&
        typeof entry.expiresAt === 'number' &&
        Number.isFinite(entry.expiresAt) &&
        entry.expiresAt > current
      ) {
        sessions.set(entry.hash, entry.expiresAt);
      }
    }
  } catch {
    return new Map();
  }
  return sessions;
}

export function createSessions(options: CreateSessionsOptions): Sessions {
  const ttlMs = options.ttlMs ?? 12 * 60 * 60 * 1000;
  const now = options.now ?? Date.now;
  const storedSecret = options.secretHash ?? hashSecret(options.secret ?? '');
  const secretTag = createHash('sha256').update(storedSecret).digest('hex');
  let sessions = readSessions(options.file, secretTag, now);
  let failures = 0;
  let lockedUntil = 0;
  const commit = (next: Map<string, number>): void => {
    if (options.file) writeSessions(options.file, secretTag, next);
    sessions = next;
  };
  const validate = (token: string): boolean => {
    const hash = tokenHash(token);
    const expiresAt = sessions.get(hash);
    if (expiresAt === undefined) return false;
    if (now() >= expiresAt) {
      sessions.delete(hash);
      return false;
    }
    return true;
  };

  return {
    login(candidate) {
      const current = now();
      if (current < lockedUntil) {
        return { kind: 'rateLimited', retryAfterSec: Math.max(1, Math.ceil((lockedUntil - current) / 1000)) };
      }
      if (lockedUntil !== 0) {
        failures = 0;
        lockedUntil = 0;
      }
      if (!verifySecret(candidate, storedSecret)) {
        failures++;
        if (failures >= 10) {
          lockedUntil = current + 15 * 60 * 1000;
          return { kind: 'rateLimited', retryAfterSec: 15 * 60 };
        }
        return { kind: 'invalid' };
      }
      let token = randomBytes(32).toString('base64url');
      let hash = tokenHash(token);
      while (sessions.has(hash)) {
        token = randomBytes(32).toString('base64url');
        hash = tokenHash(token);
      }
      const next = new Map(sessions);
      next.set(hash, current + ttlMs);
      try {
        commit(next);
      } catch {
        return { kind: 'unavailable' };
      }
      failures = 0;
      return { kind: 'token', token, maxAgeSec: Math.max(1, Math.ceil(ttlMs / 1000)) };
    },
    validate,
    expiresAt(token) {
      return validate(token) ? sessions.get(tokenHash(token)) : undefined;
    },
    logout(token) {
      const next = new Map(sessions);
      next.delete(tokenHash(token));
      commit(next);
    },
    logoutAll() {
      commit(new Map());
    },
    guard(req, res) {
      const token = sessionToken(req);
      if (token !== undefined && validate(token)) return true;

      const path = requestPath(req.url);
      if (path.startsWith('/api/')) {
        res.writeHead(401).end();
        return false;
      }
      const returnTo = isReturnRoute(path);
      res.writeHead(303, { Location: `/login?returnTo=${encodeURIComponent(returnTo)}` }).end();
      return false;
    },
  };
}

export function sessionsFor(config: ServerConfig, now?: () => number): Sessions {
  return createSessions({
    secretHash: readLoginSecret(config.secretFile),
    file: path.join(config.dataDir, 'server', 'sessions.json'),
    now,
  });
}

function sessionToken(req: IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator !== -1 && part.slice(0, separator).trim() === 'pf_session') return part.slice(separator + 1).trim();
  }
  return undefined;
}

function requestPath(url: string | undefined): string {
  try {
    const parsed = new URL(url ?? '/', 'http://localhost');
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return '/';
  }
}

export function readBody(req: IncomingMessage, options: ReadBodyOptions = {}): Promise<BodyResult> {
  const limit = options.limit ?? 16_384;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const swallowError = () => {};
    const removeSwallowError = () => {
      req.off('error', swallowError);
      req.off('close', removeSwallowError);
    };

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      req.off('close', onClose);
    };
    const settle = (result: BodyResult, drain = false) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cleanup();
      if (drain) req.resume();
      resolve(result);
    };
    const armTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => settle({ kind: 'timeout' }, true), timeoutMs);
    };
    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      armTimer();
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = limit - size;
      if (data.length > remaining) {
        if (remaining > 0) chunks.push(data.subarray(0, remaining));
        size = limit;
        settle({ kind: 'bodyTooLarge' }, true);
        return;
      }
      chunks.push(data);
      size += data.length;
    };
    const onEnd = () => settle({ kind: 'ok', body: Buffer.concat(chunks, size).toString('utf8') });
    const onError = () => settle({ kind: 'aborted' });
    const onAborted = () => settle({ kind: 'aborted' });
    const onClose = () => {
      if (!req.readableEnded) settle({ kind: 'aborted' });
    };

    req.on('error', swallowError);
    req.once('close', removeSwallowError);
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
    req.once('close', onClose);
    armTimer();
  });
}

export function rejectBody(res: ServerResponse, kind: 'bodyTooLarge' | 'timeout'): void {
  res.writeHead(kind === 'bodyTooLarge' ? 413 : 408, { Connection: 'close' }).end();
}

export function checkOrigin(req: IncomingMessage, publicOrigin: string): boolean {
  return req.headers.origin !== undefined && req.headers.origin === publicOrigin;
}

const returnRoutes = [...WINDOW_ROUTES];

export function isReturnRoute(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return '/';
  try {
    const rawPath = path.split(/[?#]/, 1)[0] ?? '';
    for (const segment of rawPath.split('/')) {
      const decoded = decodeURIComponent(segment);
      if (decoded === '.' || decoded === '..') return '/';
    }
    const url = new URL(path, 'http://localhost');
    decodeURIComponent(url.search);
    const matches = returnRoutes.some((route) => {
      route.lastIndex = 0;
      const result = route.test(url.pathname);
      route.lastIndex = 0;
      return result;
    });
    if (!matches) return '/';
    const [key, value] = url.searchParams.entries().next().value ?? [];
    const keepProject = key === 'project' && Boolean(value) && url.searchParams.size === 1;
    return `${url.pathname}${keepProject ? url.search : ''}`;
  } catch {
    return '/';
  }
}

export function registerReturnRoute(re: RegExp): void {
  returnRoutes.push(re);
}
