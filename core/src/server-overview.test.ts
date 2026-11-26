import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyUsage } from './agents/common.js';
import type { ServerConfig } from './server/config.js';
import { startHost, type Host, type HostSnapshot, type StartHostOptions } from './server/host.js';
import { createServerApp } from './server/main.js';
import { RunStore } from './store.js';
import type { RunFile } from './types.js';

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
const linux = { skip: process.platform !== 'linux', timeout: 30_000 };
const SECRET = 'секрет владельца';
const PUBLIC_ORIGIN = 'https://purpleflow.example';

function saveRun(store: RunStore, projectPath: string, over: Partial<RunFile> = {}): RunFile {
  const id = over.id ?? crypto.randomUUID();
  const run = {
    version: 2,
    id,
    title: 'Записанный прогон',
    task: 'Сделай',
    changeId: `c-${id}`,
    mode: 'quick',
    status: 'stopped',
    next: 'implement',
    workspace: 'worktree',
    projectPath,
    worktreePath: projectPath,
    branch: 'main',
    baseCommit: 'base',
    testCommand: 'true',
    agents: { planner: 'claude', executor: 'claude', reviewer: 'claude' },
    models: { planner: '', executor: '', reviewer: '' },
    attempts: [],
    planRetries: 0,
    implAttemptsUsed: 0,
    implAttemptsLimit: 3,
    tests: [],
    reviews: [],
    gates: [],
    totals: emptyUsage(),
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  } as RunFile;
  store.save(run);
  return run;
}

function configFor(root: string, project: string, port = 0): ServerConfig {
  const secretFile = path.join(root, 'secret');
  if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, SECRET, { mode: 0o600 });
  return {
    dataDir: path.join(root, 'data'),
    promptsDir: PROMPTS,
    projects: [{ id: 'project', path: project }],
    publicOrigin: PUBLIC_ORIGIN,
    port,
    secretFile,
    settings: {
      toolPaths: {},
      enabledAgents: ['claude'],
      proxy: { baseUrl: '', apiKey: '' },
      models: { planner: '', executor: '', reviewer: '' },
      agents: { planner: 'claude', executor: 'claude', reviewer: 'claude' },
      agentTimeoutMin: 1,
      testTimeoutMin: 1,
      maxParallel: 1,
    },
  };
}

function tempRoot(t: TestContext): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-server-overview-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}

async function listen(t: TestContext, handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

class CookieJar {
  private cookie = '';

  async request(origin: string, route: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set('Cookie', this.cookie);
    const response = await fetch(`${origin}${route}`, { redirect: 'manual', ...init, headers });
    const cookie = response.headers.get('set-cookie');
    if (cookie) this.cookie = cookie.split(';', 1)[0] ?? '';
    return response;
  }

  async login(origin: string, returnTo = '/', secret = SECRET): Promise<Response> {
    return this.request(origin, '/login', {
      method: 'POST',
      headers: { Origin: PUBLIC_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, returnTo }),
    });
  }
}

async function overviewFixture(t: TestContext) {
  const root = tempRoot(t);
  const project = path.join(root, 'project-visible-name');
  const other = path.join(root, 'other');
  fs.mkdirSync(project);
  fs.mkdirSync(other);
  const config = configFor(root, project);
  const store = new RunStore(config.dataDir);
  const run = saveRun(store, project);
  const foreign = saveRun(store, other, { title: 'Чужой прогон' });
  const options: StartHostOptions = {
    dataDir: config.dataDir,
    promptsDir: config.promptsDir,
    projects: config.projects,
    settings: config.settings,
    agentEnv: { ...process.env },
  };
  const host = await startHost(options);
  t.after(() => host.close());
  const origin = await listen(t, createServerApp(config, host));
  return { config, foreign, host, origin, project, run };
}

test('обзор: две сессии видят одинаковую непустую сводку', linux, async (t) => {
  const { origin, run } = await overviewFixture(t);
  const first = new CookieJar();
  const second = new CookieJar();
  assert.equal((await first.login(origin)).status, 303);
  assert.equal((await second.login(origin)).status, 303);

  const firstResponse = await first.request(origin, '/api/overview');
  const secondResponse = await second.request(origin, '/api/overview');
  const firstSnapshot = (await firstResponse.json()) as HostSnapshot;
  const secondSnapshot = (await secondResponse.json()) as HostSnapshot;
  assert.equal(firstResponse.status, 200);
  assert.deepEqual(firstSnapshot, secondSnapshot);
  assert.equal(firstSnapshot.projects.length, 1);
  assert.deepEqual(firstSnapshot.runs.map((item) => item.id), [run.id]);

  const firstHtml = await (await first.request(origin, '/')).text();
  const secondHtml = await (await second.request(origin, '/')).text();
  assert.equal(firstHtml, secondHtml);
  assert.match(firstHtml, /Записанный прогон/);
});

test('обзор: без входа ни HTML, ни API не раскрывают название проекта', linux, async (t) => {
  const { origin, project } = await overviewFixture(t);
  const page = await fetch(`${origin}/`, { redirect: 'manual' });
  assert.equal(page.status, 303);
  assert.doesNotMatch(await page.text(), new RegExp(path.basename(project)));

  const api = await fetch(`${origin}/api/overview`);
  assert.equal(api.status, 401);
  assert.doesNotMatch(await api.text(), new RegExp(path.basename(project)));
});

test('обзор: прямая ссылка ведёт ко входу и возвращает к тому же прогону', linux, async (t) => {
  const { origin, run } = await overviewFixture(t);
  const jar = new CookieJar();
  const route = `/runs/${run.id}`;
  const anonymous = await jar.request(origin, route);
  assert.equal(anonymous.status, 303);
  const location = new URL(anonymous.headers.get('location') ?? '', origin);
  assert.equal(location.pathname, '/login');
  assert.equal(location.searchParams.get('returnTo'), route);

  const form = await jar.request(origin, `${location.pathname}${location.search}`);
  assert.equal(form.status, 200);
  assert.match(await form.text(), /name="returnTo"[^>]*value="\/runs\//);
  const entered = await jar.login(origin, route);
  assert.equal(entered.status, 303);
  assert.equal(entered.headers.get('location'), route);

  const page = await jar.request(origin, route);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Записанный прогон/);
});


test('обзор: название прогона с <script> выводится текстом', linux, async (t) => {
  const root = tempRoot(t);
  const config = configFor(root, path.join(root, 'project'));
  const host: Host = {
    async snapshot() {
      return {
        projects: [{ id: 'project', name: 'Проект <img src=x onerror=alert(1)>' }],
        runs: [
          {
            id: crypto.randomUUID(),
            projectId: 'project',
            title: '<script>alert("x")</script> & безопасно',
            status: 'stopped',
            next: 'implement',
          },
        ],
      };
    },
    async close() {},
  };
  const origin = await listen(t, createServerApp(config, host));
  const jar = new CookieJar();
  await jar.login(origin);

  const response = await jar.request(origin, '/');
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.doesNotMatch(body, /<script>alert/);
  assert.doesNotMatch(body, /<img src=x/);
  assert.match(body, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; безопасно/);
  assert.match(body, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-security-policy'), "default-src 'self'");
});

test('обзор: неизвестный путь 404, неподдерживаемый метод 405, ядро не вызвано', linux, async (t) => {
  const { host, origin } = await overviewFixture(t);
  let coreCalls = 0;
  const snapshot = host.snapshot.bind(host);
  host.snapshot = async () => {
    coreCalls++;
    return snapshot();
  };
  const jar = new CookieJar();
  await jar.login(origin);

  const missing = await jar.request(origin, '/missing');
  assert.equal(missing.status, 404);
  const wrongMethod = await jar.request(origin, '/', { method: 'POST', headers: { Origin: PUBLIC_ORIGIN } });
  assert.equal(wrongMethod.status, 405);
  const wrongLoginMethod = await jar.request(origin, '/login', { method: 'PUT' });
  assert.equal(wrongLoginMethod.status, 405);
  assert.equal(coreCalls, 0);
});

test('обзор: чужой id прогона — 404', linux, async (t) => {
  const { foreign, origin } = await overviewFixture(t);
  const jar = new CookieJar();
  await jar.login(origin);

  const foreignPage = await jar.request(origin, `/runs/${foreign.id}`);
  assert.equal(foreignPage.status, 404);
  assert.doesNotMatch(await foreignPage.text(), /Чужой прогон/);
  const unknown = await jar.request(origin, `/runs/${crypto.randomUUID()}`);
  assert.equal(unknown.status, 404);
});

test('вход: чужой Origin 403, неверный секрет 401, тело больше лимита 413 у клиента, шестой неверный вход 429 — ядро не вызвано', linux, async (t) => {
  const { host, origin } = await overviewFixture(t);
  let coreCalls = 0;
  const snapshot = host.snapshot.bind(host);
  host.snapshot = async () => {
    coreCalls++;
    return snapshot();
  };
  const jar = new CookieJar();
  const wrongOrigin = await jar.request(origin, '/login', {
    method: 'POST',
    headers: { Origin: 'https://attacker.example' },
    body: new URLSearchParams({ secret: SECRET }),
  });
  assert.equal(wrongOrigin.status, 403);
  assert.equal((await jar.login(origin, '/', 'неверно')).status, 401);

  const tooLarge = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const request = http.request(`${origin}/login`, { method: 'POST', headers: { Origin: PUBLIC_ORIGIN } }, resolve);
    request.on('error', reject);
    request.write(Buffer.alloc(16 * 1024, 'a'));
    request.write(Buffer.alloc(1, 'b'));
    request.end();
  });
  assert.equal(tooLarge.statusCode, 413);
  tooLarge.resume();
  await once(tooLarge, 'end');

  for (let attempt = 0; attempt < 4; attempt++) {
    assert.equal((await jar.login(origin, '/', 'неверно')).status, 401);
  }
  const limited = await jar.login(origin, '/', 'неверно');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.match(await limited.text(), /Слишком много попыток/);
  assert.equal(coreCalls, 0);
});
