import http, { type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { gateMessage } from '../gates.js';
import { ShuttingDownError } from '../kernel.js';
import type { ChangeDocs, RunFile } from '../types.js';
import { buildAgentEnv, loadServerConfig, readSecret } from './config.js';
import type { ServerConfig } from './config.js';
import { startHost as startServerHost } from './host.js';
import type { Host, HostSnapshot, StartTaskResult } from './host.js';
import type { ExpectedDecision } from './decisions.js';
import { checkOrigin, createSessions, isReturnRoute, readBody, registerReturnRoute, rejectBody } from './session.js';
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
    .map(
      (project) => `<li data-project-id="${escapeHtml(project.id)}"><a href="/projects/${project.id}">${escapeHtml(project.name)}</a></li>`,
    )
    .join('');
  const runs = snapshot.runs
    .map(
      (run) =>
        `<tr><td><a href="/runs/${encodeURIComponent(run.id)}">${escapeHtml(run.title)}</a></td><td>${escapeHtml(run.projectId)}</td><td>${escapeHtml(run.status)}</td><td>${escapeHtml(run.next)}</td></tr>`,
    )
    .join('');
  const waiting = snapshot.runs
    .filter((run) => run.status === 'waiting' && run.gate)
    .map((run) => `<li><a href="/runs/${encodeURIComponent(run.id)}">${escapeHtml(run.title)}</a>: ${escapeHtml(run.reason ?? '')}</li>`)
    .join('');
  return `<h1>Проекты и прогоны</h1>${logoutForm()}<h2>Проекты</h2><ul>${projects}</ul><h2>Ожидают решения</h2><ul>${waiting}</ul><h2>Прогоны</h2><table><thead><tr><th>Прогон</th><th>Проект</th><th>Статус</th><th>Стадия</th></tr></thead><tbody>${runs}</tbody></table>`;
}

function projectPage(project: HostSnapshot['projects'][number], submissionId: string): string {
  return `<p><a href="/">Все проекты и прогоны</a></p><h1>${escapeHtml(project.name)}</h1>${logoutForm()}<form method="post" action="/projects/${project.id}/runs"><input type="hidden" name="submissionId" value="${submissionId}"><label>Задача <textarea name="task" required></textarea></label><button type="submit">Запустить</button></form>`;
}

function decisionForm(run: RunFile, action: string, label: string, fields = ''): string {
  return `<form method="post" action="/runs/${encodeURIComponent(run.id)}/decision"><input type="hidden" name="expectedWaitId" value="${escapeHtml(run.waitId ?? '')}">${fields}<button type="submit" name="action" value="${action}">${label}</button></form>`;
}

function waitingSections(run: RunFile, docs: ChangeDocs | null | undefined): string {
  if (run.status !== 'waiting') return '';
  const reason = escapeHtml(gateMessage(run) ?? run.message ?? '');
  if (run.next === 'gate0') {
    const fields = (run.clarify?.questions ?? [])
      .map((question, index) => {
        const options = question.options?.length
          ? `<p>Варианты:</p><ul>${question.options.map((option) => `<li>${escapeHtml(option)}</li>`).join('')}</ul>`
          : '';
        return `<fieldset><legend>Вопрос ${index + 1}</legend><pre>${escapeHtml(question.q)}</pre>${question.why ? `<p>${escapeHtml(question.why)}</p>` : ''}${options}<input type="hidden" name="answers[${index}][q]" value="${escapeHtml(question.q)}"><label>Ответ <textarea name="answers[${index}][a]" required></textarea></label></fieldset>`;
      })
      .join('');
    return `<section><h2>Уточнение перед планированием</h2><p>${reason}</p>${decisionForm(run, 'answer', 'Ответить', fields)}${decisionForm(run, 'skip', 'Продолжить без ответов')}</section>`;
  }
  if (run.next === 'gate1') {
    if (docs === null) return '<section><h2>План изменения</h2><p>План меняется — обновите страницу</p></section>';
    if (docs === undefined) return '';
    const comment = '<label>Комментарий <textarea name="comment" required></textarea></label>';
    return `<section><h2>План изменения</h2><p>${reason}</p><h3>Proposal</h3><pre>${escapeHtml(docs.proposal)}</pre><h3>Задачи</h3><pre>${escapeHtml(docs.tasks)}</pre>${decisionForm(run, 'approve', 'Принять')}${decisionForm(run, 'reject', 'Вернуть с комментарием', comment)}${decisionForm(run, 'cancel', 'Отменить')}</section>`;
  }
  if (run.next === 'limit') {
    const cause = run.stuck ? 'loop' : 'attempts';
    const title = cause === 'loop' ? 'Исполнитель и ревьюер ходят по кругу' : 'Попытки реализации исчерпаны';
    const detail = cause === 'attempts' ? `<p>${run.implAttemptsUsed} из ${run.implAttemptsLimit}</p>` : '';
    const comment = '<label>Комментарий (необязательно) <textarea name="comment"></textarea></label>';
    return `<section><h2>${title}</h2><p>${reason}</p>${detail}${decisionForm(run, 'approve', 'Ещё попытка', comment)}${decisionForm(run, 'cancel', 'Остановить')}</section>`;
  }
  if (run.next === 'gate2') return `<section><h2>Приёмка</h2><p>${reason}</p></section>`;
  return '';
}

function decisionHistory(run: RunFile): string {
  const gateTitles: Record<string, string> = { gate0: 'Уточнение', gate1: 'План', gate2: 'Приёмка', limit: 'Лимит попыток' };
  const decisionTitles: Record<RunFile['gates'][number]['decision'], string> = {
    approve: 'Принято',
    reject: 'Возвращено',
    cancel: 'Отменено',
    accept: 'Принято как есть',
    fix: 'Быстрая правка',
  };
  const entries = run.gates
    .map(
      (gate) =>
        `<li><strong>${escapeHtml(gateTitles[gate.gate] ?? gate.gate)}: ${escapeHtml(decisionTitles[gate.decision])}</strong>${gate.comment ? `<pre>${escapeHtml(gate.comment)}</pre>` : ''}<time datetime="${escapeHtml(gate.at)}">${escapeHtml(gate.at)}</time></li>`,
    )
    .join('');
  return `<section><h2>История решений</h2>${entries ? `<ol>${entries}</ol>` : '<p>Решений пока нет.</p>'}</section>`;
}

async function readRunView(host: Host, initial: RunFile): Promise<{ run: RunFile; docs: ChangeDocs | null | undefined } | null> {
  if (initial.status !== 'waiting' || initial.next !== 'gate1') return { run: initial, docs: undefined };
  const result = await host.readChangeDocs(initial.id);
  return result ? { run: result.run, docs: result.docs } : null;
}

function runPage(snapshot: HostSnapshot, run: RunFile, notice = '', docs?: ChangeDocs | null): string {
  const listed = snapshot.runs.find((item) => item.id === run.id);
  const project = snapshot.projects.find((item) => item.id === listed?.projectId);
  const statuses: Record<RunFile['status'], string> = {
    queued: 'В очереди',
    running: 'Выполняется',
    waiting: 'Ожидает решения',
    stopped: 'Остановлен',
    cancelled: 'Отменён',
    finished: 'Завершён',
  };
  return `<p><a href="/">Все проекты и прогоны</a></p><h1>${escapeHtml(run.title)}</h1>${notice ? `<p>${escapeHtml(notice)}</p>` : ''}${logoutForm()}<dl><dt>Прогон</dt><dd>${escapeHtml(run.id)}</dd><dt>Проект</dt><dd>${escapeHtml(project?.name ?? listed?.projectId ?? '')}</dd><dt>Статус</dt><dd data-status="${escapeHtml(run.status)}">${escapeHtml(statuses[run.status])}</dd><dt>Стадия</dt><dd>${escapeHtml(run.next)}</dd></dl>${waitingSections(run, docs)}${decisionHistory(run)}`;
}

function startResultPage(result: StartTaskResult, projectId: string): string {
  if (result.status === 'rejected') {
    return `<h1>Задача не запущена</h1><p>${escapeHtml(result.message)}</p><p><a href="/projects/${projectId}">Вернуться к задаче</a></p>`;
  }
  const message =
    result.status === 'conflict' ? 'Этот идентификатор уже использован для другой задачи' : 'Исход предыдущего запуска неизвестен';
  return `<h1>Задача не запущена повторно</h1><p>${message}</p><p><a href="/">Проверьте список прогонов</a></p>`;
}

function sessionToken(req: IncomingMessage): string {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator !== -1 && part.slice(0, separator).trim() === 'pf_session') return part.slice(separator + 1).trim();
  }
  return '';
}

function decisionFromForm(form: URLSearchParams): ExpectedDecision {
  const answers = new Map<number, { q: string; a: string }>();
  for (const [name, value] of form) {
    const match = /^answers\[(\d+)\]\[(q|a)\]$/.exec(name);
    if (!match) continue;
    const index = Number(match[1]);
    const answer = answers.get(index) ?? { q: '', a: '' };
    if (match[2] === 'q') answer.q = value;
    else answer.a = value;
    answers.set(index, answer);
  }
  return {
    expectedWaitId: form.get('expectedWaitId') ?? '',
    action: form.get('action'),
    comment: form.get('comment') ?? '',
    answers: [...answers.entries()].sort(([a], [b]) => a - b).map(([, answer]) => answer),
  } as ExpectedDecision;
}

const runRoute = /^\/runs\/([^/]+)$/;
const runDecisionRoute = /^\/runs\/([^/]+)\/decision$/;
const projectRoute = /^\/projects\/([A-Za-z0-9_-]+)$/;
const projectRunsRoute = /^\/projects\/([A-Za-z0-9_-]+)\/runs$/;
const readMethods = ['GET'] as const;
const routeMethods: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ['/', readMethods],
  ['/api/overview', readMethods],
  ['/login', ['GET', 'POST']],
  ['/logout', ['POST']],
]);
registerReturnRoute(/^\/projects\/[A-Za-z0-9_-]+$/);

function allowedMethods(route: string): readonly string[] | undefined {
  if (runRoute.test(route) || projectRoute.test(route)) return readMethods;
  if (runDecisionRoute.test(route) || projectRunsRoute.test(route)) return ['POST'];
  return routeMethods.get(route);
}

export function createServerApp(
  config: ServerConfig,
  host: Host,
  opts: {
    now?: () => number;
    sessions?: Sessions;
    testHooks?: { beforeStartTask?: () => Promise<void>; beforeStartRedirect?: () => Promise<void> };
  } = {},
): RequestListener {
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
    const methods = allowedMethods(route);
    const publicLogin = route === '/login' && methods?.includes(method) === true;
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
            'Set-Cookie': `pf_session=${result.token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${result.maxAgeSec}`,
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
      const projectMatch = projectRoute.exec(route);
      if (projectMatch && method === 'GET') {
        const project = (await host.snapshot()).projects.find((item) => item.id === projectMatch[1]);
        if (project) html(res, 200, projectPage(project, crypto.randomUUID()));
        else send(res, 404, 'Проект не найден');
        return;
      }
      const projectRunsMatch = projectRunsRoute.exec(route);
      if (projectRunsMatch && method === 'POST') {
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
        const projectId = projectRunsMatch[1]!;
        await opts.testHooks?.beforeStartTask?.();
        const result = await host.startTask(projectId, {
          task: form.get('task') ?? '',
          submissionId: form.get('submissionId') ?? '',
        });
        if (result.status === 'started') {
          await opts.testHooks?.beforeStartRedirect?.();
          res.writeHead(303, { Location: `/runs/${encodeURIComponent(result.runId)}` }).end();
          return;
        }
        if (result.status === 'notFound') send(res, 404, 'Проект не найден');
        else html(res, result.status === 'rejected' ? 400 : 409, startResultPage(result, projectId));
        return;
      }
      const runDecisionMatch = runDecisionRoute.exec(route);
      if (runDecisionMatch && method === 'POST') {
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
        const runId = runDecisionMatch[1]!;
        const result = await host.decide(runId, decisionFromForm(new URLSearchParams(body.body)));
        if (result.status === 'ok') {
          res.writeHead(303, { Location: `/runs/${encodeURIComponent(runId)}` }).end();
          return;
        }
        if (result.status === 'notFound') send(res, 404, 'Прогон не найден');
        else if (result.status === 'invalid') send(res, 400, result.message);
        else {
          const view = await readRunView(host, result.snapshot);
          if (view) html(res, 409, runPage(await host.snapshot(), view.run, 'Решение уже принято на другом устройстве', view.docs));
          else send(res, 404, 'Прогон не найден');
        }
        return;
      }
      const runMatch = runRoute.exec(route);
      if (runMatch && method === 'GET') {
        const initial = await host.readRun(runMatch[1]!);
        const view = initial ? await readRunView(host, initial) : null;
        if (view) html(res, 200, runPage(await host.snapshot(), view.run, '', view.docs));
        else send(res, 404, 'Прогон не найден');
        return;
      }
      send(
        res,
        methods ? 405 : 404,
        methods ? 'Метод не поддерживается' : 'Не найдено',
        'text/plain; charset=utf-8',
        methods ? { Allow: methods.join(', ') } : {},
      );
    } catch (error) {
      if (!res.headersSent)
        send(
          res,
          error instanceof ShuttingDownError ? 503 : 500,
          error instanceof ShuttingDownError ? 'Служба останавливается' : 'Внутренняя ошибка',
        );
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
    if (starting === undefined) report(error);
    await finish();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2));
}
