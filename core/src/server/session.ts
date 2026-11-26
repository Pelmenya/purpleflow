import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface Sessions {
  login(candidate: string): LoginResult;
  validate(token: string): boolean;
  logout(token: string): void;
  guard(req: IncomingMessage, res: ServerResponse): boolean;
}

export type LoginResult =
  { kind: 'token'; token: string; maxAgeSec: number } | { kind: 'invalid' } | { kind: 'rateLimited'; retryAfterSec: number };

export type BodyResult = { kind: 'ok'; body: string } | { kind: 'bodyTooLarge' } | { kind: 'timeout' } | { kind: 'aborted' };

export interface CreateSessionsOptions {
  secret: string;
  ttlMs?: number;
  now?: () => number;
}

export interface ReadBodyOptions {
  limit?: number;
  timeoutMs?: number;
}

export function createSessions(options: CreateSessionsOptions): Sessions {
  const ttlMs = options.ttlMs ?? 12 * 60 * 60 * 1000;
  const now = options.now ?? Date.now;
  const secretDigest = createHash('sha256').update(options.secret).digest();
  const sessions = new Map<string, number>();
  const failures: number[] = [];
  const validate = (token: string): boolean => {
    const expiresAt = sessions.get(token);
    if (expiresAt === undefined) return false;
    if (now() >= expiresAt) {
      sessions.delete(token);
      return false;
    }
    return true;
  };

  return {
    login(candidate) {
      const current = now();
      while (failures[0] !== undefined && failures[0] <= current - 60_000) failures.shift();
      if (failures.length >= 5) {
        return { kind: 'rateLimited', retryAfterSec: Math.max(1, Math.ceil(((failures[0] ?? current) + 60_000 - current) / 1000)) };
      }

      const candidateDigest = createHash('sha256').update(candidate).digest();
      if (!timingSafeEqual(candidateDigest, secretDigest)) {
        failures.push(current);
        return { kind: 'invalid' };
      }

      let token = randomBytes(32).toString('base64url');
      while (sessions.has(token)) token = randomBytes(32).toString('base64url');
      sessions.set(token, current + ttlMs);
      return { kind: 'token', token, maxAgeSec: Math.max(1, Math.ceil(ttlMs / 1000)) };
    },
    validate,
    logout(token) {
      sessions.delete(token);
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

function sessionToken(req: IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator !== -1 && part.slice(0, separator).trim() === 'pf_session') return part.slice(separator + 1).trim();
  }
  return undefined;
}

function requestPath(url: string | undefined): string {
  try {
    return new URL(url ?? '/', 'http://localhost').pathname;
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

const returnRoutes = [/^\/$/, /^\/runs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i];

export function isReturnRoute(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('..')) return '/';
  for (const route of returnRoutes) {
    route.lastIndex = 0;
    const matches = route.test(path);
    route.lastIndex = 0;
    if (matches) return path;
  }
  return '/';
}

export function registerReturnRoute(re: RegExp): void {
  returnRoutes.push(re);
}
