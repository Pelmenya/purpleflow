import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyUsage } from './agents/common.js';
import type { ServerConfig } from './server/config.js';
import { startHost, type Host, type HostSnapshot, type StartHostOptions } from './server/host.js';
import { createServerApp, startService } from './server/main.js';
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
  const firstLogin = await first.login(origin);
  assert.equal(firstLogin.status, 303);
  assert.match(
    firstLogin.headers.get('set-cookie') ?? '',
    /^pf_session=[\w-]+; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=43200$/,
  );
  assert.equal((await second.login(origin)).status, 303);

  const firstResponse = await first.request(origin, '/api/overview');
  const secondResponse = await second.request(origin, '/api/overview');
  const firstSnapshot = (await firstResponse.json()) as HostSnapshot;
  const secondSnapshot = (await secondResponse.json()) as HostSnapshot;
  assert.equal(firstResponse.status, 200);
  assert.deepEqual(firstSnapshot, secondSnapshot);
  assert.equal(firstSnapshot.projects.length, 1);
  assert.deepEqual(
    firstSnapshot.runs.map((item) => item.id),
    [run.id],
  );

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
    async startTask() {
      throw new Error('не реализовано');
    },
    async decide() {
      return { status: 'notFound' };
    },
    async readRun() {
      return null;
    },
    async readChangeDocs() {
      return null;
    },
    async readDiff() {
      return null;
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
  const { host, origin, run } = await overviewFixture(t);
  let coreCalls = 0;
  const snapshot = host.snapshot.bind(host);
  host.snapshot = async () => {
    coreCalls++;
    return snapshot();
  };
  const jar = new CookieJar();
  await jar.login(origin);

  for (const route of ['/missing', '/constructor']) {
    const missing = await jar.request(origin, route);
    assert.equal(missing.status, 404, route);
    assert.equal(missing.headers.get('allow'), null, route);
  }
  const wrongMethods = [
    { route: '/', allow: 'GET' },
    { route: '/api/overview', allow: 'GET' },
    { route: `/runs/${run.id}`, allow: 'GET' },
    { route: '/login', allow: 'GET, POST' },
    { route: '/logout', allow: 'POST' },
  ];
  for (const { route, allow } of wrongMethods) {
    const response = await jar.request(origin, route, { method: 'PUT', headers: { Origin: PUBLIC_ORIGIN } });
    assert.equal(response.status, 405, route);
    assert.equal(response.headers.get('allow'), allow, route);
  }
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

test(
  'вход: чужой Origin 403, неверный секрет 401, тело больше лимита 413 у клиента, шестой неверный вход 429 — ядро не вызвано',
  linux,
  async (t) => {
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
  },
);

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function assertPortFree(port: number): Promise<void> {
  const server = net.createServer();
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function stubHost(overrides: Partial<Host> = {}): Host {
  return {
    async snapshot() {
      return { projects: [], runs: [] };
    },
    async startTask() {
      throw new Error('не реализовано');
    },
    async decide() {
      return { status: 'notFound' };
    },
    async readRun() {
      return null;
    },
    async readChangeDocs() {
      return null;
    },
    async readDiff() {
      return null;
    },
    async close() {},
    ...overrides,
  };
}

async function withinFiveSeconds<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('Остановка заняла больше 5 секунд')), 5_000))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function partialPost(port: number): Promise<net.Socket> {
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => {});
  await once(socket, 'connect');
  await new Promise<void>((resolve) => {
    socket.write('POST /login HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 16384\r\n\r\n1234567890', () => resolve());
  });
  return socket;
}

test('служба: небезопасный секрет — отказ без привязки порта и без вызова startHost', linux, async (t) => {
  const root = tempRoot(t);
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const port = await freePort();
  const config = configFor(root, project, port);
  fs.chmodSync(config.secretFile, 0o644);
  let hostCalls = 0;

  await assert.rejects(
    startService(config, {
      startHost: async () => {
        hostCalls++;
        return stubHost();
      },
    }),
    /доступен группе или остальным пользователям/,
  );
  assert.equal(hostCalls, 0);
  await assertPortFree(port);
});

test('служба: хост получает agentEnv из buildAgentEnv', linux, async (t) => {
  const root = tempRoot(t);
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const config = configFor(root, project, await freePort());
  const marker = 'PF_SERVICE_TEST_MARKER';
  const previous = process.env[marker];
  process.env[marker] = 'секрет службы';
  t.after(() => {
    if (previous === undefined) delete process.env[marker];
    else process.env[marker] = previous;
  });
  let agentEnv: NodeJS.ProcessEnv | undefined;
  const service = await startService(config, {
    startHost: async (options) => {
      agentEnv = options.agentEnv;
      return stubHost();
    },
  });
  t.after(() => service.stop());
  await service.ready;

  assert.equal(agentEnv?.[marker], undefined);
  assert.equal(agentEnv?.HOME, process.env.HOME);
  await service.stop();
});

test('служба: stop во время запуска хоста', linux, async (t) => {
  const root = tempRoot(t);
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const port = await freePort();
  const config = configFor(root, project, port);
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let closeCalls = 0;
  let readySettled = false;
  const service = await startService(config, {
    startHost: async () => {
      await gate;
      return stubHost({
        async close() {
          closeCalls++;
        },
      });
    },
  });
  t.after(async () => {
    release();
    await service.stop();
  });
  void service.ready.then(
    () => (readySettled = true),
    () => (readySettled = true),
  );

  const waiting = await fetch(`http://127.0.0.1:${port}/api/overview`);
  assert.equal(waiting.status, 503);
  assert.doesNotMatch(await waiting.text(), /project/);
  const firstStop = service.stop();
  assert.strictEqual(firstStop, service.stop());
  release();
  await withinFiveSeconds(firstStop);

  assert.equal(closeCalls, 1);
  assert.equal(readySettled, false);
  await assertPortFree(port);
});

test('служба: зависший POST не задерживает stop', linux, async (t) => {
  const root = tempRoot(t);
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const port = await freePort();
  const config = configFor(root, project, port);
  const service = await startService(config, { startHost: async () => stubHost() });
  t.after(() => service.stop());
  await service.ready;
  const socket = await partialPost(port);
  t.after(() => socket.destroy());
  const closed = new Promise<void>((resolve) => socket.once('close', resolve));

  await withinFiveSeconds(service.stop());
  await withinFiveSeconds(closed.then(() => undefined));
  await assertPortFree(port);
});

test('служба: отказ host.close() всё равно закрывает соединения', linux, async (t) => {
  const root = tempRoot(t);
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const port = await freePort();
  const config = configFor(root, project, port);
  const failure = new Error('Отказ закрытия хоста');
  const service = await startService(config, {
    startHost: async () =>
      stubHost({
        close: () => Promise.reject(failure),
      }),
  });
  t.after(() => service.stop().catch(() => {}));
  await service.ready;
  const socket = await partialPost(port);
  t.after(() => socket.destroy());
  const closed = new Promise<void>((resolve) => socket.once('close', resolve));

  await withinFiveSeconds(
    assert.rejects(service.stop(), (error) => {
      assert.equal(error, failure);
      return true;
    }),
  );
  await withinFiveSeconds(closed.then(() => undefined));
  await assertPortFree(port);
});

const DIST_MAIN = fileURLToPath(new URL('../dist/server/main.js', import.meta.url));
const processLinux = { ...linux, timeout: 45_000 };

interface ServiceProcess {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderr(): string;
}

async function withinProcessTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('Процесс не завершился за 15 секунд')), 15_000))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function spawnService(t: TestContext, configFile: string, nodeArgs: string[] = []): ServiceProcess {
  const child = spawn(process.execPath, [...nodeArgs, DIST_MAIN, '--config', configFile], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  return { child, exited, stderr: () => stderr };
}

function processConfig(root: string, project: string, port: number, toolPaths: ServerConfig['settings']['toolPaths'] = {}) {
  const config = configFor(root, project, port);
  config.settings.toolPaths = toolPaths;
  config.settings.userConfig = false;
  const file = path.join(root, `config-${port}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...config, settings: { ...config.settings, proxy: undefined } }));
  return { config, file };
}

function processTools(root: string, pidFile?: string): ServerConfig['settings']['toolPaths'] {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const claude = path.join(bin, 'claude');
  const pidLine = pidFile ? `echo "$$" >> ${JSON.stringify(pidFile)}\nexec sleep 30\n` : 'exit 0\n';
  fs.writeFileSync(claude, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "claude 1.0.0"; exit 0; fi\n${pidLine}`, { mode: 0o755 });
  const openspec = path.join(bin, 'openspec');
  fs.writeFileSync(
    openspec,
    '#!/bin/sh\n[ "$1" = "--version" ] && echo 1.0.0 && exit 0\n[ "$1" = "init" ] && mkdir -p openspec/changes\nexit 0\n',
    { mode: 0o755 },
  );
  return { claude, openspec };
}

async function waitForStatus(process: ServiceProcess, port: number, status: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (process.child.exitCode !== null || process.child.signalCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/login`, {
        signal: AbortSignal.timeout(Math.min(1_000, deadline - Date.now())),
      });
      await response.arrayBuffer();
      if (response.status === status) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Не получен HTTP ${status}: ${process.stderr()}`);
}

async function stopProcess(process: ServiceProcess, code: number): Promise<void> {
  process.child.kill('SIGTERM');
  const result = await withinProcessTimeout(process.exited);
  assert.equal(result.code, code, process.stderr());
  assert.equal(result.signal, null, process.stderr());
}

function assertSingleDiagnostic(process: ServiceProcess, diagnostic: string): void {
  assert.equal(process.stderr().split(diagnostic).length - 1, 1, process.stderr());
}

function initProject(project: string): string {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
  fs.writeFileSync(path.join(project, 'a.txt'), 'a\n');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: project });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: project });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim();
}

async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Файл не появился: ${file}`);
}

test('служба: нечитаемый конфиг — код 1, порт свободен, каталог данных не создан', processLinux, async (t) => {
  const root = tempRoot(t);
  const port = await freePort();
  const dataDir = path.join(root, 'data');
  const configFile = path.join(root, 'broken.json');
  fs.writeFileSync(configFile, `{"dataDir":${JSON.stringify(dataDir)},"port":${port},`);
  const process = spawnService(t, configFile);

  const result = await withinProcessTimeout(process.exited);
  assert.equal(result.code, 1, process.stderr());
  assert.equal(result.signal, null);
  assert.equal(fs.existsSync(dataDir), false);
  await assertPortFree(port);
});

test('служба: второй запуск на том же порту и на другом порту с тем же каталогом данных — код 1', processLinux, async (t) => {
  const root = tempRoot(t);
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const port = await freePort();
  const otherPort = await freePort();
  const tools = processTools(root);
  const first = spawnService(t, processConfig(root, project, port, tools).file);
  await waitForStatus(first, port, 200);

  const samePort = spawnService(t, processConfig(root, project, port, tools).file);
  const portResult = await withinProcessTimeout(samePort.exited);
  assert.equal(portResult.code, 1, samePort.stderr());
  assertSingleDiagnostic(samePort, 'EADDRINUSE');

  const sameData = spawnService(t, processConfig(root, project, otherPort, tools).file);
  const dataResult = await withinProcessTimeout(sameData.exited);
  assert.equal(dataResult.code, 1, sameData.stderr());
  assertSingleDiagnostic(sameData, 'Каталог данных уже обслуживается');
  await assertPortFree(otherPort);

  await stopProcess(first, 0);
  await assertPortFree(port);
});

test('служба: SIGTERM завершает агента, очередь не стартует', processLinux, async (t) => {
  const root = tempRoot(t);
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const head = initProject(project);
  const port = await freePort();
  const pidFile = path.join(root, 'agent-pids');
  const { config, file } = processConfig(root, project, port, processTools(root, pidFile));
  const store = new RunStore(config.dataDir);
  const active = saveRun(store, project, {
    title: 'Активный A',
    status: 'running',
    next: 'implement',
    baseCommit: head,
    createdAt: '2026-01-01T00:00:00Z',
    testCommand: '',
  });
  const queued = saveRun(store, project, {
    title: 'Ожидающий B',
    status: 'queued',
    next: 'implement',
    baseCommit: head,
    createdAt: '2026-01-01T00:00:01Z',
    workspacePending: true,
    testCommand: '',
  });
  const process = spawnService(t, file);
  await waitForFile(pidFile);
  const agentPid = Number(fs.readFileSync(pidFile, 'utf8').trim().split('\n')[0]);
  assert.ok(Number.isInteger(agentPid) && agentPid > 0);

  await stopProcess(process, 0);
  for (let attempt = 0; attempt < 100; attempt++) {
    let alive = true;
    try {
      globalThis.process.kill(agentPid, 0);
    } catch {
      alive = false;
    }
    if (!alive) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (attempt === 99) assert.fail(`Агент ${agentPid} пережил SIGTERM службы`);
  }
  assert.equal(fs.readFileSync(pidFile, 'utf8').trim().split('\n').length, 1, 'ожидающий прогон запустил второго агента');
  assert.notEqual(store.load(queued.id)?.status, 'running');
  assert.ok(store.load(active.id));
  await assertPortFree(port);
});

test('служба: отказ startHost и SIGTERM — код 1', processLinux, async (t) => {
  const root = tempRoot(t);
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const ownerPort = await freePort();
  const failingPort = await freePort();
  const tools = processTools(root);
  const owner = spawnService(t, processConfig(root, project, ownerPort, tools).file);
  await waitForStatus(owner, ownerPort, 200);

  const delayHost = path.join(root, 'delay-host.mjs');
  fs.writeFileSync(
    delayHost,
    `import net from 'node:net';
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (typeof args[0] === 'string' && args[0].startsWith('\\0purpleflow-data-')) {
    setTimeout(() => listen.apply(this, args), 500);
    return this;
  }
  return listen.apply(this, args);
};
`,
  );
  const failing = spawnService(t, processConfig(root, project, failingPort, tools).file, ['--import', delayHost]);
  await waitForStatus(failing, failingPort, 503);
  await stopProcess(failing, 1);
  assertSingleDiagnostic(failing, 'Каталог данных уже обслуживается');
  await assertPortFree(failingPort);
  await stopProcess(owner, 0);
});
