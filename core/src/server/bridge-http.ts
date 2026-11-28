import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parse, stringify } from 'devalue';
import { ShuttingDownError } from '../kernel.js';
import type { CoreApi } from '../model/api.js';
import type { CoreEvent } from '../model/protocol.js';
import { AccessError, CORE_ACCESS } from './access.js';
import type { ServerConfig } from './config.js';
import type { Host } from './host.js';
import { checkOrigin, readBody, rejectBody } from './session.js';

const BODY_LIMIT = 32 * 1024 * 1024;
const EVENT_BUFFER_LIMIT = 8 * 1024 * 1024;
const coreRoute = /^\/api\/core\/([^/]+)$/;

interface Stream {
  token: string;
  res: ServerResponse;
  ping: NodeJS.Timeout;
  expiration?: NodeJS.Timeout;
}

const allStreams = new Set<Stream>();

function send(res: ServerResponse, status: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': contentType }).end(body);
}

function sendValue(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, stringify(value), 'application/json; charset=utf-8');
}

function sendCoreError(res: ServerResponse, status: number, code: string, message: string): void {
  sendValue(res, status, { ok: false, error: { code, message } });
}

function requestToken(req: IncomingMessage): string {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator !== -1 && part.slice(0, separator).trim() === 'pf_session') return part.slice(separator + 1).trim();
  }
  return '';
}

function closeStream(stream: Stream): void {
  clearInterval(stream.ping);
  if (stream.expiration) clearTimeout(stream.expiration);
  if (!stream.res.destroyed) stream.res.end();
}

export function closeSessionStreams(token: string): void {
  for (const stream of allStreams) if (stream.token === token) closeStream(stream);
}

export function closeAllStreams(): void {
  for (const stream of allStreams) closeStream(stream);
}

function publicSettings(config: ServerConfig): Record<string, unknown> {
  const settings = config.settings;
  return {
    toolPaths: settings.toolPaths,
    models: settings.models,
    efforts: settings.efforts,
    agents: settings.agents,
    enabledAgents: settings.enabledAgents,
    agentTimeoutMin: settings.agentTimeoutMin,
    testTimeoutMin: settings.testTimeoutMin,
    maxParallel: settings.maxParallel,
    claudeAuth: settings.claudeAuth,
    userConfig: settings.userConfig,
    proxy: {
      baseUrl: settings.proxy.baseUrl,
      codexBaseUrl: settings.proxy.codexBaseUrl ?? '',
      hasKey: settings.proxy.apiKey.length > 0,
    },
  };
}

function eventText(id: string, event: CoreEvent): string {
  return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function createBridgeHandler(
  config: ServerConfig,
  host: Host,
  opts: { expiresAt?: (token: string) => number | undefined; now?: () => number } = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const epoch = randomBytes(16).toString('hex');
  const streams = new Set<Stream>();
  const buffer: { sequence: number; text: string; bytes: number }[] = [];
  let sequence = 0;
  let bufferBytes = 0;

  host.onCoreEvent((event) => {
    sequence++;
    const text = eventText(`${epoch}-${sequence}`, event);
    if (event.type !== 'visual.frame') {
      const bytes = Buffer.byteLength(text);
      buffer.push({ sequence, text, bytes });
      bufferBytes += bytes;
      while (bufferBytes > EVENT_BUFFER_LIMIT && buffer.length > 0) {
        bufferBytes -= buffer.shift()!.bytes;
      }
    }
    for (const stream of streams) if (!stream.res.destroyed && !stream.res.writableEnded) stream.res.write(text);
  });

  const openEvents = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.headers.origin !== undefined && req.headers.origin !== config.publicOrigin) {
      send(res, 403, 'Запрещено');
      return;
    }
    if (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin') {
      send(res, 403, 'Запрещено');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    const lastEventId = req.headers['last-event-id'];
    if (lastEventId !== undefined) {
      const match = typeof lastEventId === 'string' ? new RegExp(`^${epoch}-(\\d+)$`).exec(lastEventId) : null;
      const replayAfter = match ? Number(match[1]) : 0;
      if (match && buffer.some((event) => event.sequence === replayAfter)) {
        for (const event of buffer) if (event.sequence > replayAfter) res.write(event.text);
      } else {
        res.write('event: reset\ndata: {}\n\n');
      }
    }

    const token = requestToken(req);
    const stream: Stream = {
      token,
      res,
      ping: setInterval(() => {
        if (!res.destroyed) res.write(': ping\n\n');
      }, 25_000),
    };
    stream.ping.unref();
    const expiresAt = opts.expiresAt?.(token);
    if (expiresAt !== undefined) {
      const delay = Math.max(0, expiresAt - (opts.now?.() ?? Date.now()));
      stream.expiration = setTimeout(() => closeStream(stream), delay);
      stream.expiration.unref();
    }
    streams.add(stream);
    allStreams.add(stream);
    res.once('close', () => {
      clearInterval(stream.ping);
      if (stream.expiration) clearTimeout(stream.expiration);
      streams.delete(stream);
      allStreams.delete(stream);
    });
  };

  return async (req, res) => {
    const route = new URL(req.url ?? '/', 'http://localhost').pathname;
    const method = req.method ?? '';
    if (route === '/api/settings' && method === 'GET') {
      send(res, 200, JSON.stringify(publicSettings(config)), 'application/json; charset=utf-8');
      return true;
    }
    if (route === '/api/events' && method === 'GET') {
      openEvents(req, res);
      return true;
    }
    const match = coreRoute.exec(route);
    if (!match || method !== 'POST') return false;
    const coreMethod = match[1]!;
    if (!checkOrigin(req, config.publicOrigin)) {
      send(res, 403, 'Запрещено');
      return true;
    }
    if (!Object.hasOwn(CORE_ACCESS, coreMethod)) {
      send(res, 404, 'Не найдено');
      return true;
    }
    const body = await readBody(req, { limit: BODY_LIMIT });
    if (body.kind === 'bodyTooLarge' || body.kind === 'timeout') {
      rejectBody(res, body.kind);
      return true;
    }
    if (body.kind === 'aborted') return true;

    let args: unknown;
    try {
      args = parse(body.body);
    } catch {
      send(res, 400, 'Некорректное тело');
      return true;
    }
    if (!Array.isArray(args)) {
      send(res, 400, 'Некорректное тело');
      return true;
    }
    try {
      const result = await host.callCore(coreMethod as keyof CoreApi, args);
      sendValue(res, 200, { ok: true, result });
    } catch (error) {
      if (error instanceof AccessError) sendCoreError(res, 403, error.code, error.message);
      else if (error instanceof ShuttingDownError) sendCoreError(res, 503, 'shutting-down', error.message);
      else sendCoreError(res, 200, 'error', error instanceof Error ? error.message : String(error));
    }
    return true;
  };
}
