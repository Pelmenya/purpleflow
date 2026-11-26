import http, { type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { buildAgentEnv, loadServerConfig, readSecret } from './config.js';
import type { ServerConfig } from './config.js';
import { startHost as startServerHost } from './host.js';
import type { Host, HostSnapshot } from './host.js';
import { checkOrigin, createSessions, isReturnRoute, readBody, rejectBody } from './session.js';
import type { Sessions } from './session.js';

export interface Service {
  ready: Promise<void>;
  stop(): Promise<void>;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function send(
  res: ServerResponse,
  status: number,
  body: string,
  contentType = 'text/plain; charset=utf-8',
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'Content-Type': contentType, ...headers }).end(body);
}

function html(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  send(
    res,
    status,
    `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>PurpleFlow</title></head><body>${body}</body></html>`,
    'text/html; charset=utf-8',
    headers,
  );
}

function loginPage(returnTo: string, error = ''): string {
  return `<h1>Вход в PurpleFlow</h1>${error ? `<p>${escapeHtml(error)}</p>` : ''}<form method="post" action="/login"><input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}"><label>Секрет <input type="password" name="secret" required autofocus></label><button type="submit">Войти</button></form>`;
}

function logoutForm(): string {
  return '<form method="post" action="/logout"><button type="submit">Выйти</button></form>';
}

function overviewPage(snapshot: HostSnapshot): string {
  const projects = snapshot.projects
    .map((project) => `<li data-project-id="${escapeHtml(project.id)}">${escapeHtml(project.name)}</li>`)
    .join('');
  const runs = snapshot.runs
    .map(
      (run) =>
        `<tr><td><a href="/runs/${encodeURIComponent(run.id)}">${escapeHtml(run.title)}</a></td><td>${escapeHtml(run.projectId)}</td><td>${escapeHtml(run.status)}</td><td>${escapeHtml(run.next)}</td></tr>`,
    )
    .join('');
  return `<h1>Проекты и прогоны</h1>${logoutForm()}<h2>Проекты</h2><ul>${projects}</ul><h2>Прогоны</h2><table><thead><tr><th>Прогон</th><th>Проект</th><th>Статус</th><th>Стадия</th></tr></thead><tbody>${runs}</tbody></table>`;
}

function runPage(snapshot: HostSnapshot, id: string): string | undefined {
  const run = snapshot.runs.find((item) => item.id === id);
  if (!run) return undefined;
  const project = snapshot.projects.find((item) => item.id === run.projectId);
  return `<p><a href="/">Все проекты и прогоны</a></p><h1>${escapeHtml(run.title)}</h1>${logoutForm()}<dl><dt>Проект</dt><dd>${escapeHtml(project?.name ?? run.projectId)}</dd><dt>Статус</dt><dd>${escapeHtml(run.status)}</dd><dt>Стадия</dt><dd>${escapeHtml(run.next)}</dd></dl>`;
}

function sessionToken(req: IncomingMessage): string {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator !== -1 && part.slice(0, separator).trim() === 'pf_session') return part.slice(separator + 1).trim();
  }
  return '';
}

export function createServerApp(config: ServerConfig, host: Host, opts: { now?: () => number; sessions?: Sessions } = {}): RequestListener {
  const sessions = opts.sessions ?? createSessions({ secret: readSecret(config.secretFile), now: opts.now });
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'");
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      send(res, 404, 'Не найдено');
      return;
    }
    const route = url.pathname;
    const method = req.method ?? '';
    const publicLogin = route === '/login' && (method === 'GET' || method === 'POST');
    if (!publicLogin && !sessions.guard(req, res)) return;

    try {
      if (route === '/login' && method === 'GET') {
        html(res, 200, loginPage(isReturnRoute(url.searchParams.get('returnTo') ?? '/')));
        return;
      }
      if (route === '/login' && method === 'POST') {
        if (!checkOrigin(req, config.publicOrigin)) {
          send(res, 403, 'Запрещено');
          return;
        }
        const body = await readBody(req);
        if (body.kind === 'bodyTooLarge' || body.kind === 'timeout') {
          rejectBody(res, body.kind);
          return;
        }
        if (body.kind === 'aborted') return;
        const form = new URLSearchParams(body.body);
        const returnTo = isReturnRoute(form.get('returnTo') ?? '/');
        const result = sessions.login(form.get('secret') ?? '');
        if (result.kind === 'invalid') {
          html(res, 401, loginPage(returnTo, 'Неверный секрет'));
          return;
        }
        if (result.kind === 'rateLimited') {
          html(res, 429, loginPage(returnTo, 'Слишком много попыток'), { 'Retry-After': String(result.retryAfterSec) });
          return;
        }
        res
          .writeHead(303, {
            Location: returnTo,
            'Set-Cookie': `pf_session=${result.token}; HttpOnly; Secure; SameSite=Strict; Path=/`,
          })
          .end();
        return;
      }
      if (route === '/logout' && method === 'POST') {
        if (!checkOrigin(req, config.publicOrigin)) {
          send(res, 403, 'Запрещено');
          return;
        }
        sessions.logout(sessionToken(req));
        res.writeHead(303, { Location: '/', 'Set-Cookie': 'pf_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0' }).end();
        return;
      }
      if (route === '/' && method === 'GET') {
        html(res, 200, overviewPage(await host.snapshot()));
        return;
      }
      if (route === '/api/overview' && method === 'GET') {
        send(res, 200, JSON.stringify(await host.snapshot()), 'application/json; charset=utf-8');
        return;
      }
      const runMatch = /^\/runs\/([^/]+)$/.exec(route);
      if (runMatch && method === 'GET') {
        const page = runPage(await host.snapshot(), runMatch[1]!);
        if (page === undefined) send(res, 404, 'Прогон не найден');
        else html(res, 200, page);
        return;
      }
      const knownRoute = route === '/' || route === '/login' || route === '/logout' || route === '/api/overview' || runMatch !== null;
      send(res, knownRoute ? 405 : 404, knownRoute ? 'Метод не поддерживается' : 'Не найдено', 'text/plain; charset=utf-8', {
        Allow: knownRoute && route !== '/login' && route !== '/logout' ? 'GET' : 'POST',
      });
    } catch {
      if (!res.headersSent) send(res, 500, 'Внутренняя ошибка');
      else res.destroy();
    }
  };
}

export async function startService(
  config: ServerConfig,
  deps: { startHost?: typeof startServerHost; now?: () => number } = {},
): Promise<Service> {
  const now = deps.now;
  const sessions = createSessions({ secret: readSecret(config.secretFile), now });
  const agentEnv = buildAgentEnv();
  const starter = deps.startHost ?? startServerHost;
  let handler: RequestListener = (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'");
    send(res, 503, 'Служба запускается', 'text/plain; charset=utf-8', { 'Retry-After': '1' });
  };
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(config.port, '127.0.0.1');
  });

  let stopping = false;
  const launching = Promise.resolve().then(() =>
    starter({
      dataDir: config.dataDir,
      promptsDir: config.promptsDir,
      projects: config.projects,
      settings: config.settings,
      agentEnv,
    }),
  );
  const ready = launching.then((host) => {
    if (stopping) return new Promise<void>(() => {});
    handler = createServerApp(config, host, { sessions, now });
  });
  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopping = true;
    const serverClosed = new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    stopPromise = (async () => {
      let firstError: unknown;
      try {
        const host = await launching.catch(() => undefined);
        if (host) {
          try {
            await host.close();
          } catch (error) {
            firstError = error;
          }
        }
      } finally {
        server.closeAllConnections();
        try {
          await serverClosed;
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError !== undefined) throw firstError;
    })();
    return stopPromise;
  };
  return { ready, stop };
}

export async function main(argv: string[]): Promise<void> {
  let starting: Promise<Service> | undefined;
  let failed = false;
  let signaled = false;
  let completion: Promise<void> | undefined;
  const report = (error: unknown): void => {
    failed = true;
    console.error(error instanceof Error ? error.message : String(error));
  };
  const finish = (): Promise<void> => {
    completion ??= (async () => {
      let service: Service | undefined;
      if (starting) {
        try {
          service = await starting;
        } catch (error) {
          report(error);
        }
      }
      if (service) {
        try {
          await service.stop();
        } catch (error) {
          report(error);
        }
      }
      process.exitCode = failed ? 1 : 0;
    })();
    return completion;
  };
  const onSignal = (): void => {
    signaled = true;
    void finish();
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  try {
    if (argv.length !== 2 || argv[0] !== '--config' || !argv[1]) {
      throw new Error('Использование: main.js --config <файл>');
    }
    const config = loadServerConfig(argv[1]);
    starting = startService(config);
    const service = await starting;
    void service.ready.catch((error) => {
      report(error);
      return finish();
    });
    if (signaled) await finish();
  } catch (error) {
    report(error);
    await finish();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2));
}
