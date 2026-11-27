import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { AgentRunOptions } from './agents/common.js';
import type { StartRunInput } from './model/protocol.js';
import type { Orchestrator } from './orchestrator.js';
import type { CoreOptions } from './runtime.js';
import { loadServerConfig, SERVER_DEFAULTS, type ServerConfig, type ServerProject } from './server/config.js';
import { createServerApp } from './server/main.js';
import { fakeClaude, makeRepo, ROOT, serverTestsSkip, startTestHost, untilGate } from './server-testkit.test.js';

const PUBLIC_ORIGIN = 'https://purpleflow.example';
const SECRET = 'секрет владельца';

function deferred(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

function configFor(dataDir: string, project: ServerProject): ServerConfig {
  const secretFile = path.join(dataDir, 'secret');
  fs.writeFileSync(secretFile, SECRET, { mode: 0o600 });
  return {
    dataDir,
    promptsDir: path.join(ROOT, 'core', 'prompts'),
    projects: [project],
    publicOrigin: PUBLIC_ORIGIN,
    port: 0,
    secretFile,
    settings: structuredClone(SERVER_DEFAULTS),
  };
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

class Browser {
  private cookie = '';

  async request(origin: string, route: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set('Cookie', this.cookie);
    if ((init.method ?? 'GET').toUpperCase() === 'POST') headers.set('Origin', PUBLIC_ORIGIN);
    const response = await fetch(`${origin}${route}`, { redirect: 'manual', ...init, headers });
    const cookie = response.headers.get('set-cookie');
    if (cookie) this.cookie = cookie.split(';', 1)[0] ?? '';
    return response;
  }

  login(origin: string, returnTo = '/'): Promise<Response> {
    return this.request(origin, '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: SECRET, returnTo }),
    });
  }
}

function submissionIdOf(html: string): string {
  const id = /name="submissionId" value="([0-9a-f-]+)"/.exec(html)?.[1];
  assert.ok(id);
  return id;
}

function postTask(browser: Browser, origin: string, submissionId: string, task = 'Добавь mul', signal?: AbortSignal) {
  return browser.request(origin, '/projects/p1/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ submissionId, task }),
    signal,
  });
}

test('старт: задача из браузера продолжается после закрытия клиента', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const plannerStarted = deferred();
  const plannerGate = deferred();
  const redirectStarted = deferred();
  const redirectGate = deferred();
  const fake = fakeClaude({ implement: () => {}, review: () => ({ blocking: [], notes: [] }) });
  const fixture = await startTestHost({
    runners: {
      claude: (async (o: AgentRunOptions) => {
        if (/планировщик/.test(o.systemPrompt ?? '')) {
          plannerStarted.open();
          await plannerGate.promise;
        }
        return fake.fn(o);
      }) as never,
    },
  });
  t.after(() => fixture.close());
  const config = configFor(fixture.dataDir, fixture.project);
  const origin = await listen(
    t,
    createServerApp(config, fixture.host, {
      testHooks: {
        beforeStartRedirect: async () => {
          redirectStarted.open();
          await redirectGate.promise;
        },
      },
    }),
  );
  const clientA = new Browser();
  const clientB = new Browser();

  try {
    const anonymous = await clientA.request(origin, '/projects/p1');
    assert.equal(anonymous.status, 303);
    const loginLocation = new URL(anonymous.headers.get('location') ?? '', origin);
    assert.equal(loginLocation.searchParams.get('returnTo'), '/projects/p1');
    const entered = await clientA.login(origin, '/projects/p1');
    assert.equal(entered.status, 303);
    assert.equal(entered.headers.get('location'), '/projects/p1');

    const overview = await (await clientA.request(origin, '/')).text();
    assert.match(overview, /href="\/projects\/p1"/);
    const form = await clientA.request(origin, '/projects/p1');
    assert.equal(form.status, 200);
    const submissionId = submissionIdOf(await form.text());
    const controller = new AbortController();
    const posting = postTask(clientA, origin, submissionId, undefined, controller.signal);
    const early = await Promise.race([
      posting.then((response) => ({ kind: 'response' as const, response })),
      redirectStarted.promise.then(() => ({ kind: 'redirect' as const })),
    ]);
    if (early.kind === 'response') {
      assert.equal(early.response.status, 303);
    } else {
      controller.abort();
      await assert.rejects(posting);
    }
    await plannerStarted.promise;
    const runs = await fixture.core.listRuns();
    assert.equal(runs.length, 1);
    const runId = runs[0]!.id;
    plannerGate.open();
    redirectGate.open();
    await untilGate(fixture.core, runId, 'gate1');

    await clientB.login(origin);
    const page = await clientB.request(origin, `/runs/${runId}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, new RegExp(runId));
    assert.match(html, /gate1/);
  } finally {
    plannerGate.open();
    redirectGate.open();
  }
});

type Fixture = Awaited<ReturnType<typeof startTestHost>>;

function runnersFor(fake: ReturnType<typeof fakeClaude>): CoreOptions['runners'] {
  return { claude: fake.fn as never };
}

function defaultRunners(): CoreOptions['runners'] {
  return runnersFor(fakeClaude({ implement: () => {}, review: () => ({ blocking: [], notes: [] }) }));
}

function watchStarts(core: Orchestrator): StartRunInput[] {
  const starts: StartRunInput[] = [];
  const dispatch = core.dispatch.bind(core);
  core.dispatch = async (cmd) => {
    if (cmd.type === 'run.start') starts.push(cmd.input);
    return dispatch(cmd);
  };
  return starts;
}

async function appFor(t: TestContext, fixture: Fixture, opts: Parameters<typeof createServerApp>[2] = {}) {
  const config = configFor(fixture.dataDir, fixture.project);
  const origin = await listen(t, createServerApp(config, fixture.host, opts));
  const browser = new Browser();
  assert.equal((await browser.login(origin)).status, 303);
  return { browser, config, origin };
}

async function startOne(fixture: Fixture, submissionId = crypto.randomUUID(), task = 'Добавь mul'): Promise<string> {
  const result = await fixture.host.startTask('p1', { submissionId, task });
  assert.equal(result.status, 'started');
  if (result.status !== 'started') throw new Error('Задача не запущена');
  return result.runId;
}

test('старт: команды проекта из файла конфигурации', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-server-start-config-'));
  const dataDir = path.join(root, 'data');
  const projectPath = makeRepo();
  const file = path.join(root, 'server.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      dataDir,
      projects: [
        {
          id: 'p1',
          path: projectPath,
          testCommand: ' node --test test/ ',
          setupCommand: ' npm ci ',
          lintCommand: ' npm run lint ',
        },
      ],
      publicOrigin: PUBLIC_ORIGIN,
      port: 4173,
      secretFile: path.join(root, 'secret'),
    }),
  );
  const config = loadServerConfig(file);
  let starts: StartRunInput[] = [];
  const fixture = await startTestHost({
    dataDir,
    project: config.projects[0],
    runners: defaultRunners(),
    onCore: (core) => {
      starts = watchStarts(core);
    },
  });
  t.after(() => fixture.close());

  const runId = await startOne(fixture);

  assert.ok(runId);
  assert.equal(starts.length, 1);
  assert.equal(starts[0]!.testCommand, 'node --test test/');
  assert.equal(starts[0]!.setupCommand, ' npm ci ');
  assert.equal(starts[0]!.lintCommand, ' npm run lint ');
  const saved = await fixture.core.getRun(runId);
  assert.equal(saved?.setupCommand, 'npm ci');
  assert.equal(saved?.lintCommand, 'npm run lint');
  assert.equal(starts[0]!.mode, 'task');
  assert.equal(starts[0]!.workspace, 'worktree');
  assert.equal(starts[0]!.autopilot, undefined);
});

test('старт: повтор после обрыва ответа даёт один прогон', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const redirectStarted = deferred();
  const redirectGate = deferred();
  const fixture = await startTestHost({ runners: defaultRunners() });
  t.after(() => fixture.close());
  const starts = watchStarts(fixture.core);
  const { browser, origin } = await appFor(t, fixture, {
    testHooks: {
      beforeStartRedirect: async () => {
        redirectStarted.open();
        await redirectGate.promise;
      },
    },
  });
  const submissionId = crypto.randomUUID();
  const controller = new AbortController();
  const posting = postTask(browser, origin, submissionId, undefined, controller.signal);
  try {
    await redirectStarted.promise;
    controller.abort();
    await assert.rejects(posting);
  } finally {
    redirectGate.open();
  }

  const runs = await fixture.core.listRuns();
  assert.equal(runs.length, 1);
  const repeated = await postTask(browser, origin, submissionId);
  assert.equal(repeated.status, 303);
  assert.equal(repeated.headers.get('location'), `/runs/${runs[0]!.id}`);
  assert.equal(starts.length, 1);
  assert.equal((await fixture.core.listRuns()).length, 1);
});

test('старт: два одновременных запроса с одним ключом', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const fixture = await startTestHost({ runners: defaultRunners() });
  t.after(() => fixture.close());
  const starts = watchStarts(fixture.core);
  const submissionId = crypto.randomUUID();

  const [first, second] = await Promise.all([
    fixture.host.startTask('p1', { submissionId, task: 'Добавь mul' }),
    fixture.host.startTask('p1', { submissionId, task: 'Добавь mul' }),
  ]);

  assert.deepEqual(second, first);
  assert.equal(first.status, 'started');
  assert.equal(starts.length, 1);
  assert.equal((await fixture.core.listRuns()).length, 1);
});

test('старт: повтор после удаления прогона без рестарта', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const fixture = await startTestHost({ runners: defaultRunners() });
  t.after(() => fixture.close());
  const starts = watchStarts(fixture.core);
  const { browser, origin } = await appFor(t, fixture);
  const submissionId = crypto.randomUUID();
  const runId = await startOne(fixture, submissionId);
  await fixture.core.dispatch({ type: 'run.delete', runId, deleteBranch: false });

  const repeated = await postTask(browser, origin, submissionId);

  assert.equal(repeated.status, 409);
  assert.match(await repeated.text(), /href="\/"/);
  assert.equal(await fixture.core.getRun(runId), null);
  assert.equal(starts.length, 1);
  assert.deepEqual(await fixture.core.listRuns(), []);
});

test('старт: тот же ключ с другим текстом — конфликт', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const fake = fakeClaude({ implement: () => {}, review: () => ({ blocking: [], notes: [] }) });
  const first = await startTestHost({ runners: runnersFor(fake) });
  t.after(() => first.close());
  const submissionId = crypto.randomUUID();
  const starting = first.host.startTask('p1', { submissionId, task: 'Добавь mul' });
  const inFlight = await first.host.startTask('p1', { submissionId, task: 'Другая задача' });
  assert.deepEqual(inFlight, { status: 'conflict' });
  const started = await starting;
  assert.equal(started.status, 'started');
  if (started.status !== 'started') return;
  await untilGate(first.core, started.runId, 'gate1');
  await first.close();

  const second = await startTestHost({
    dataDir: first.dataDir,
    project: { path: first.project.path },
    runners: defaultRunners(),
  });
  t.after(() => second.close());
  const starts = watchStarts(second.core);
  const completed = await second.host.startTask('p1', { submissionId, task: 'Другая задача' });
  assert.deepEqual(completed, { status: 'conflict' });
  assert.equal(starts.length, 0);
  assert.equal((await second.core.listRuns()).length, 1);
});

test('старт: повтор того же ключа после рестарта — прежний прогон', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const first = await startTestHost({ runners: defaultRunners() });
  t.after(() => first.close());
  const submissionId = crypto.randomUUID();
  const runId = await startOne(first, submissionId);
  await untilGate(first.core, runId, 'gate1');
  await first.close();

  const second = await startTestHost({
    dataDir: first.dataDir,
    project: { path: first.project.path },
    runners: defaultRunners(),
  });
  t.after(() => second.close());
  const starts = watchStarts(second.core);
  const result = await second.host.startTask('p1', { submissionId, task: 'Добавь mul' });

  assert.deepEqual(result, { status: 'started', runId });
  assert.equal(starts.length, 0);
  assert.equal((await second.core.listRuns()).length, 1);
});

function postProjectTask(browser: Browser, origin: string, projectId: string, submissionId: string, task = 'Добавь mul') {
  return browser.request(origin, `/projects/${projectId}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ submissionId, task }),
  });
}

function submissionPath(fixture: Fixture, submissionId: string): string {
  return path.join(fixture.dataDir, 'server', 'submissions', `${submissionId}.json`);
}

test('старт: отказ до dispatch', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const missingCommand = await startTestHost({ project: { testCommand: '' }, runners: defaultRunners() });
  t.after(() => missingCommand.close());
  const missingStarts = watchStarts(missingCommand.core);
  const { browser, origin } = await appFor(t, missingCommand);
  const unknownId = crypto.randomUUID();
  const notFound = await missingCommand.host.startTask('missing', { submissionId: unknownId, task: 'Добавь mul' });
  assert.deepEqual(notFound, { status: 'notFound' });
  const notFoundPage = await postProjectTask(browser, origin, 'missing', crypto.randomUUID());
  assert.equal(notFoundPage.status, 404);

  const submissionId = crypto.randomUUID();
  const rejected = await missingCommand.host.startTask('p1', { submissionId, task: 'Добавь mul' });
  assert.equal(rejected.status, 'rejected');
  const otherProject = await missingCommand.host.startTask('missing', { submissionId, task: 'Добавь mul' });
  assert.deepEqual(otherProject, { status: 'conflict' });
  assert.equal(missingStarts.length, 0);
  assert.deepEqual(await missingCommand.core.listRuns(), []);

  const multiRepo = await startTestHost({ runners: defaultRunners() });
  t.after(() => multiRepo.close());
  await multiRepo.core.saveProjectConfig(multiRepo.project.path, {
    setupCommand: '',
    lintCommand: '',
    testCommand: 'node --test',
    notes: { setup: '', lint: '', test: '' },
    multiRepo: { root: multiRepo.project.path, repos: [] },
  });
  const multiStarts = watchStarts(multiRepo.core);
  const multiResult = await multiRepo.host.startTask('p1', { submissionId: crypto.randomUUID(), task: 'Добавь mul' });
  assert.equal(multiResult.status, 'rejected');
  assert.equal(multiStarts.length, 0);
  assert.deepEqual(await multiRepo.core.listRuns(), []);
});

test('старт: неопределённый исход после рестарта', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const first = await startTestHost({ runners: defaultRunners() });
  t.after(() => first.close());
  const submissionId = crypto.randomUUID();
  const task = 'Добавь mul';
  const hash = createHash('sha256')
    .update(JSON.stringify({ projectId: 'p1', task }))
    .digest('hex');
  fs.mkdirSync(path.dirname(submissionPath(first, submissionId)), { recursive: true });
  fs.writeFileSync(
    submissionPath(first, submissionId),
    JSON.stringify({ submissionId, hash, projectId: 'p1', createdAt: new Date().toISOString() }),
  );
  await first.close();

  const second = await startTestHost({
    dataDir: first.dataDir,
    project: { path: first.project.path },
    runners: defaultRunners(),
  });
  t.after(() => second.close());
  const starts = watchStarts(second.core);
  const result = await second.host.startTask('p1', { submissionId, task });
  assert.deepEqual(result, { status: 'unknown' });
  assert.equal(starts.length, 0);
  assert.deepEqual(await second.core.listRuns(), []);
});

test('старт: чужой прогон по id', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const first = await startTestHost({ runners: defaultRunners() });
  t.after(() => first.close());
  const runId = await startOne(first);
  await untilGate(first.core, runId, 'gate1');
  await first.close();

  const second = await startTestHost({
    dataDir: first.dataDir,
    project: { path: makeRepo() },
    runners: defaultRunners(),
  });
  t.after(() => second.close());
  assert.equal(await second.host.readRun(runId), null);
  const { browser, origin } = await appFor(t, second);
  const page = await browser.request(origin, `/runs/${runId}`);
  assert.equal(page.status, 404);
});

test('старт: сохранённый runId без прогона — unknown', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const first = await startTestHost({ runners: defaultRunners() });
  t.after(() => first.close());
  const submissionId = crypto.randomUUID();
  await startOne(first, submissionId);
  const runId = (await first.core.listRuns())[0]!.id;
  await untilGate(first.core, runId, 'gate1');
  await first.close();

  const second = await startTestHost({
    dataDir: first.dataDir,
    project: { path: makeRepo() },
    runners: defaultRunners(),
  });
  t.after(() => second.close());
  const starts = watchStarts(second.core);
  const result = await second.host.startTask('p1', { submissionId, task: 'Добавь mul' });
  assert.deepEqual(result, { status: 'unknown' });
  assert.equal(starts.length, 0);
});

test('старт: отклонённая заявка после рестарта', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const first = await startTestHost({ project: { testCommand: '' }, runners: defaultRunners() });
  t.after(() => first.close());
  const submissionId = crypto.randomUUID();
  const rejected = await first.host.startTask('p1', { submissionId, task: 'Добавь mul' });
  assert.equal(rejected.status, 'rejected');
  const file = submissionPath(first, submissionId);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).error, rejected.status === 'rejected' ? rejected.message : undefined);
  await first.close();

  const second = await startTestHost({
    dataDir: first.dataDir,
    project: { path: first.project.path },
    runners: defaultRunners(),
  });
  t.after(() => second.close());
  const starts = watchStarts(second.core);
  const conflict = await second.host.startTask('p1', { submissionId, task: 'Другая задача' });
  const repeated = await second.host.startTask('p1', { submissionId, task: 'Добавь mul' });
  assert.deepEqual(conflict, { status: 'conflict' });
  assert.deepEqual(repeated, rejected);
  assert.equal(starts.length, 0);
  assert.deepEqual(await second.core.listRuns(), []);
});

test('старт: testCommand из пробелов — отказ', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const fixture = await startTestHost({ project: { testCommand: '   ' }, runners: defaultRunners() });
  t.after(() => fixture.close());
  const starts = watchStarts(fixture.core);

  const result = await fixture.host.startTask('p1', { submissionId: crypto.randomUUID(), task: 'Добавь mul' });

  assert.equal(result.status, 'rejected');
  assert.equal(starts.length, 0);
  assert.deepEqual(await fixture.core.listRuns(), []);
});

test('старт: остановка службы до первой записи прогона', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const toolsStarted = deferred();
  const toolsGate = deferred();
  const first = await startTestHost({
    runners: defaultRunners(),
    onCore: (core) => {
      const tools = core.kernel.tools.bind(core.kernel);
      core.kernel.tools = async (need) => {
        toolsStarted.open();
        await toolsGate.promise;
        return tools(need);
      };
    },
  });
  t.after(() => first.close());
  const { browser, origin } = await appFor(t, first);
  const submissionId = crypto.randomUUID();
  const posting = postTask(browser, origin, submissionId);
  await toolsStarted.promise;
  const closing = first.close();
  toolsGate.open();

  const response = await posting;
  assert.equal(response.status, 503);
  await closing;
  const submission = JSON.parse(fs.readFileSync(submissionPath(first, submissionId), 'utf8')) as { runId?: string; error?: string };
  assert.equal(submission.runId, undefined);
  assert.equal(submission.error, undefined);
  assert.deepEqual(await first.core.listRuns(), []);

  const second = await startTestHost({
    dataDir: first.dataDir,
    project: { path: first.project.path },
    runners: defaultRunners(),
  });
  t.after(() => second.close());
  const starts = watchStarts(second.core);
  const repeated = await second.host.startTask('p1', { submissionId, task: 'Добавь mul' });
  assert.deepEqual(repeated, { status: 'unknown' });
  assert.equal(starts.length, 0);
  assert.deepEqual(await second.core.listRuns(), []);
});

test('старт: запрос, вошедший после начала close, не трогает заявку', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const beforeStart = deferred();
  const beforeStartGate = deferred();
  const first = await startTestHost({ runners: defaultRunners() });
  t.after(() => first.close());
  const oldApp = await appFor(t, first, {
    testHooks: {
      beforeStartTask: async () => {
        beforeStart.open();
        await beforeStartGate.promise;
      },
    },
  });
  const submissionId = crypto.randomUUID();
  const oldPosting = postTask(oldApp.browser, oldApp.origin, submissionId);
  await beforeStart.promise;
  await first.close();

  const second = await startTestHost({
    dataDir: first.dataDir,
    project: { path: first.project.path },
    runners: defaultRunners(),
  });
  t.after(() => second.close());
  const newApp = await appFor(t, second);
  const newResponse = await postTask(newApp.browser, newApp.origin, submissionId);
  assert.equal(newResponse.status, 303);
  const runId = newResponse.headers.get('location')?.split('/').at(-1);
  assert.ok(runId);
  const before = fs.readFileSync(submissionPath(first, submissionId), 'utf8');

  beforeStartGate.open();
  const oldResponse = await oldPosting;
  assert.equal(oldResponse.status, 503);
  assert.equal(fs.readFileSync(submissionPath(first, submissionId), 'utf8'), before);
  assert.equal(JSON.parse(before).runId, runId);
});

test('старт: close ждёт заявку до dispatch', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const configRead = deferred();
  const configGate = deferred();
  const fixture = await startTestHost({
    project: { testCommand: '' },
    runners: defaultRunners(),
    onCore: (core) => {
      const getProjectConfig = core.getProjectConfig.bind(core);
      core.getProjectConfig = async (dir) => {
        configRead.open();
        await configGate.promise;
        return getProjectConfig(dir);
      };
    },
  });
  t.after(() => fixture.close());
  const { browser, origin } = await appFor(t, fixture);
  const submissionId = crypto.randomUUID();
  const posting = postTask(browser, origin, submissionId);
  await configRead.promise;
  let closed = false;
  const closing = fixture.close().then(() => {
    closed = true;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(closed, false);
  } finally {
    configGate.open();
  }

  const response = await posting;
  assert.equal(response.status, 400);
  await closing;
  const file = submissionPath(fixture, submissionId);
  const before = fs.readFileSync(file, 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
