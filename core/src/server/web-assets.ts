import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';

export const WINDOW_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; form-action 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'";
export const LOGIN_CSP = WINDOW_CSP.replace("form-action 'none'", "form-action 'self'");
export const WINDOW_ROUTES = [
  /^\/$/,
  /^\/runs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^\/runs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/log$/i,
];

export const DEFAULT_WEB_DIR = fileURLToPath(new URL('../../../app/out/web', import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

type ResolvedFile = { kind: 'ok'; file: string; contentType: string } | { kind: 'missing' | 'forbidden' };

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveFile(webDir: string, route: string): ResolvedFile {
  let decoded: string;
  try {
    decoded = decodeURIComponent(route);
  } catch {
    return { kind: 'forbidden' };
  }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').includes('..')) return { kind: 'forbidden' };

  let root: string;
  try {
    root = fs.realpathSync(webDir);
  } catch {
    return { kind: 'missing' };
  }
  const candidate = path.resolve(root, `.${decoded}`);
  if (!inside(root, candidate)) return { kind: 'forbidden' };

  let file: string;
  try {
    file = fs.realpathSync(candidate);
    if (!inside(root, file) || !fs.statSync(file).isFile()) return { kind: 'forbidden' };
  } catch {
    return { kind: 'missing' };
  }
  const contentType = CONTENT_TYPES[path.extname(file)];
  if (!contentType) return { kind: 'forbidden' };
  return { kind: 'ok', file, contentType };
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Не найдено');
}

export function isWindowRoute(route: string): boolean {
  return WINDOW_ROUTES.some((pattern) => pattern.test(route));
}

export function createWebAssets(webDir = DEFAULT_WEB_DIR) {
  const serve = (route: string, res: ServerResponse, immutable: boolean): ResolvedFile => {
    const result = resolveFile(webDir, route);
    if (result.kind !== 'ok') return result;
    const extension = path.extname(result.file);
    res.writeHead(200, {
      'Content-Type': result.contentType,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
      ...(extension === '.html' ? { 'Content-Security-Policy': WINDOW_CSP } : {}),
    });
    res.end(fs.readFileSync(result.file));
    return result;
  };

  return {
    serve(route: string, method: string, res: ServerResponse): boolean {
      const asset = route.startsWith('/assets/');
      if ((!asset && !isWindowRoute(route)) || method !== 'GET') return false;
      const result = serve(asset ? route : '/index.html', res, asset);
      if (result.kind === 'ok') return true;
      if (!asset && result.kind === 'missing') {
        res
          .writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
          .end('Окно не собрано: выполните npm run build:web');
      } else notFound(res);
      return true;
    },

    login(res: ServerResponse): boolean {
      const result = serve('/login.html', res, false);
      if (result.kind === 'missing') return false;
      if (result.kind === 'forbidden') notFound(res);
      return true;
    },
  };
}
