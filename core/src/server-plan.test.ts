import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { ServerConfig, ServerProject } from './server/config.js';
import { createServerApp } from './server/main.js';
import { fakeClaude, makeRepo, ROOT, serverTestsSkip, startTestHost, untilGate, waitingRunFixture } from './server-testkit.test.js';
import { RunStore } from './store.js';

const PUBLIC_ORIGIN = 'https://purpleflow.example';
const SECRET = 'секрет владельца';

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

  login(origin: string): Promise<Response> {
    return this.request(origin, '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: SECRET, returnTo: '/' }),
    });
  }
}

function postDecision(browser: Browser, origin: string, runId: string, fields: Record<string, string>): Promise<Response> {
  return browser.request(origin, `/runs/${runId}/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
}

function expectedWaitIdOf(html: string): string {
  const waitId = /name="expectedWaitId" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(waitId);
  return waitId;
}

test('план: уточнение, возврат и утверждение из браузера', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const fake = fakeClaude({
    questions: [{ q: 'Какие числа поддерживать?', options: ['Целые', 'Дробные'], why: 'От этого зависит реализация' }],
    implement: () => {},
    review: () => ({ blocking: [], notes: [] }),
  });
  const fixture = await startTestHost({ runners: { claude: fake.fn as never } });
  t.after(() => fixture.close());
  const origin = await listen(t, createServerApp(configFor(fixture.dataDir, fixture.project), fixture.host));
  const clientA = new Browser();
  const clientB = new Browser();
  assert.equal((await clientA.login(origin)).status, 303);
  assert.equal((await clientB.login(origin)).status, 303);

  const project = await clientA.request(origin, '/projects/p1');
  const submissionId = /name="submissionId" value="([0-9a-f-]+)"/.exec(await project.text())?.[1];
  assert.ok(submissionId);
  const started = await clientA.request(origin, '/projects/p1/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ submissionId, task: 'Добавь mul' }),
  });
  assert.equal(started.status, 303);
  const runId = started.headers.get('location')?.split('/').at(-1);
  assert.ok(runId);
  const gate0 = await untilGate(fixture.core, runId, 'gate0');
  const clarifyPage = await (await clientA.request(origin, `/runs/${runId}`)).text();
  assert.match(clarifyPage, /Какие числа поддерживать\?/);
  assert.match(clarifyPage, /Целые/);
  assert.match(clarifyPage, /От этого зависит реализация/);
  assert.equal(expectedWaitIdOf(clarifyPage), gate0.waitId);
  assert.match(clarifyPage, />Ответить</);
  assert.match(clarifyPage, />Продолжить без ответов</);

  const answered = await postDecision(clientA, origin, runId, {
    expectedWaitId: gate0.waitId!,
    action: 'answer',
    'answers[0][q]': 'Какие числа поддерживать?',
    'answers[0][a]': 'Целые и дробные',
  });
  assert.equal(answered.status, 303);
  const gate1 = await untilGate(fixture.core, runId, 'gate1');
  assert.ok(fake.plans().some((prompt) => prompt.includes('Какие числа поддерживать? — Целые и дробные')));

  const planPage = await (await clientA.request(origin, `/runs/${runId}`)).text();
  assert.match(planPage, /# Умножение/);
  assert.match(planPage, /1\.1 mul в src\/math\.js/);
  assert.equal(expectedWaitIdOf(planPage), gate1.waitId);
  const rejected = await postDecision(clientA, origin, runId, {
    expectedWaitId: gate1.waitId!,
    action: 'reject',
    comment: 'Добавь отрицательные числа',
  });
  assert.equal(rejected.status, 303);
  const returned = await untilGate(fixture.core, runId, 'gate1');
  assert.notEqual(returned.waitId, gate1.waitId);

  const otherClientPage = await (await clientB.request(origin, `/runs/${runId}`)).text();
  assert.match(otherClientPage, /Добавь отрицательные числа/);
  assert.equal(expectedWaitIdOf(otherClientPage), returned.waitId);
  const drive = t.mock.method(fixture.core.kernel.engine, 'drive');
  const approved = await postDecision(clientB, origin, runId, {
    expectedWaitId: returned.waitId!,
    action: 'approve',
  });
  assert.equal(approved.status, 303);
  assert.ok(drive.mock.calls.some((call) => call.arguments[0].next === 'implement'));
});

async function browserFixture(t: TestContext, fake = fakeClaude({ implement: () => {}, review: () => ({ blocking: [], notes: [] }) })) {
  const fixture = await startTestHost({ runners: { claude: fake.fn as never } });
  t.after(() => fixture.close());
  const origin = await listen(t, createServerApp(configFor(fixture.dataDir, fixture.project), fixture.host));
  const browser = new Browser();
  assert.equal((await browser.login(origin)).status, 303);
  return { ...fixture, fake, origin, browser };
}

test('план: пустой возврат и чужой прогон', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const fixture = await browserFixture(t);
  const own = waitingRunFixture(fixture.dataDir, fixture.project.path, { next: 'gate1', waitId: 'own-plan' });
  const foreignPath = makeRepo();
  const foreign = waitingRunFixture(fixture.dataDir, foreignPath, { next: 'gate1', waitId: 'foreign-plan' });
  const readDocs = t.mock.method(fixture.core, 'getChangeDocs');

  const rejected = await postDecision(fixture.browser, fixture.origin, own.id, {
    expectedWaitId: own.waitId!,
    action: 'reject',
    comment: '   ',
  });
  assert.equal(rejected.status, 400);
  assert.deepEqual((await fixture.core.getRun(own.id))!.gates, []);

  const foreignPage = await fixture.browser.request(fixture.origin, `/runs/${foreign.id}`);
  assert.equal(foreignPage.status, 404);
  assert.equal(readDocs.mock.callCount(), 0);

  const gate2 = waitingRunFixture(fixture.dataDir, fixture.project.path, { next: 'gate2' });
  const gate2Page = await (await fixture.browser.request(fixture.origin, `/runs/${gate2.id}`)).text();
  assert.match(gate2Page, /Посмотрите дифф и замечания ревью/);
  assert.doesNotMatch(gate2Page, /name="action"/);
});

test('план: повтор формы после обрыва', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const fixture = await browserFixture(t);
  const answerRun = waitingRunFixture(fixture.dataDir, fixture.project.path, {
    next: 'gate0',
    waitId: 'answer-gate0',
    clarify: { questions: [{ q: 'Какие числа поддерживать?' }] },
  });
  const answerFields = {
    expectedWaitId: answerRun.waitId!,
    action: 'answer',
    'answers[0][q]': 'Какие числа поддерживать?',
    'answers[0][a]': 'Целые числа',
  };
  assert.equal((await postDecision(fixture.browser, fixture.origin, answerRun.id, answerFields)).status, 303);
  const answerGate1 = await untilGate(fixture.core, answerRun.id, 'gate1');
  const repeatedAnswer = await postDecision(fixture.browser, fixture.origin, answerRun.id, answerFields);
  assert.equal(repeatedAnswer.status, 409);
  assert.equal(expectedWaitIdOf(await repeatedAnswer.text()), answerGate1.waitId);
  let current = (await fixture.core.getRun(answerRun.id))!;
  assert.equal(current.gates.filter((gate) => gate.gate === 'gate0').length, 1);
  assert.equal(current.gates.filter((gate) => gate.gate === 'gate1').length, 0);
  assert.equal(current.waitDecided, undefined);

  const rejectFields = { expectedWaitId: answerGate1.waitId!, action: 'reject', comment: 'Переработай план' };
  assert.equal((await postDecision(fixture.browser, fixture.origin, answerRun.id, rejectFields)).status, 303);
  const returnedGate1 = await untilGate(fixture.core, answerRun.id, 'gate1');
  assert.notEqual(returnedGate1.waitId, answerGate1.waitId);
  const repeatedReject = await postDecision(fixture.browser, fixture.origin, answerRun.id, rejectFields);
  assert.equal(repeatedReject.status, 409);
  assert.equal(expectedWaitIdOf(await repeatedReject.text()), returnedGate1.waitId);
  current = (await fixture.core.getRun(answerRun.id))!;
  assert.equal(current.gates.filter((gate) => gate.gate === 'gate1').length, 1);
  assert.equal(current.waitId, returnedGate1.waitId);
  assert.equal(current.waitDecided, undefined);

  const skipRun = waitingRunFixture(fixture.dataDir, fixture.project.path, {
    next: 'gate0',
    waitId: 'skip-gate0',
    clarify: { questions: [{ q: 'Нужен ли новый интерфейс?' }] },
  });
  const skipFields = { expectedWaitId: skipRun.waitId!, action: 'skip' };
  assert.equal((await postDecision(fixture.browser, fixture.origin, skipRun.id, skipFields)).status, 303);
  const skipGate1 = await untilGate(fixture.core, skipRun.id, 'gate1');
  const repeatedSkip = await postDecision(fixture.browser, fixture.origin, skipRun.id, skipFields);
  assert.equal(repeatedSkip.status, 409);
  assert.equal(expectedWaitIdOf(await repeatedSkip.text()), skipGate1.waitId);
  current = (await fixture.core.getRun(skipRun.id))!;
  assert.equal(current.gates.filter((gate) => gate.gate === 'gate0').length, 1);
  assert.equal(current.gates.filter((gate) => gate.gate === 'gate1').length, 0);
  assert.equal(current.waitDecided, undefined);
});

test('план: экранирование', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const fixture = await browserFixture(t);
  const run = waitingRunFixture(fixture.dataDir, fixture.project.path, { next: 'gate1', waitId: 'escaped-plan' });
  const docsDir = path.join(fixture.project.path, 'openspec', 'changes', run.changeId);
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'proposal.md'), "<script>alert('x')</script>\n**не разметка**");
  fs.writeFileSync(path.join(docsDir, 'tasks.md'), '<img src=x onerror=alert(1)>');

  const page = await (await fixture.browser.request(fixture.origin, `/runs/${run.id}`)).text();
  assert.match(page, /&lt;script&gt;alert\(&#39;x&#39;\)&lt;\/script&gt;/);
  assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(page, /\*\*не разметка\*\*/);
  assert.doesNotMatch(page, /<script>alert/);
  assert.doesNotMatch(page, /<img src=x/);
});

test('план: документы и версия из одного снимка', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-plan-snapshot-'));
  const projectPath = makeRepo();
  const stable = waitingRunFixture(dataDir, projectPath, { next: 'gate1', waitId: 'A' });
  const store = new RunStore(dataDir);
  let stableDocsCalls = 0;
  const fixture = await startTestHost({
    dataDir,
    project: { path: projectPath },
    onCore: (core) => {
      core.getChangeDocs = async () => {
        stableDocsCalls++;
        if (stableDocsCalls === 1) {
          const current = store.load(stable.id)!;
          store.save({ ...current, waitId: 'B' });
        }
        return {
          proposal: stableDocsCalls === 1 ? 'План A' : 'План B',
          tasks: stableDocsCalls === 1 ? 'Задачи A' : 'Задачи B',
          design: '',
          specs: [],
        };
      };
    },
  });
  t.after(() => fixture.close());
  const origin = await listen(t, createServerApp(configFor(dataDir, fixture.project), fixture.host));
  const browser = new Browser();
  assert.equal((await browser.login(origin)).status, 303);

  const stablePage = await (await browser.request(origin, `/runs/${stable.id}`)).text();
  assert.equal(expectedWaitIdOf(stablePage), 'B');
  assert.match(stablePage, /План B/);
  assert.match(stablePage, /Задачи B/);
  assert.doesNotMatch(stablePage, /План A/);
  assert.equal(stableDocsCalls, 2);

  const unstable = waitingRunFixture(dataDir, projectPath, { next: 'gate1', waitId: 'C' });
  let unstableDocsCalls = 0;
  fixture.core.getChangeDocs = async () => {
    unstableDocsCalls++;
    const current = store.load(unstable.id)!;
    store.save({ ...current, waitId: `W${unstableDocsCalls}` });
    return { proposal: 'Нестабильный план', tasks: 'Нестабильные задачи', design: '', specs: [] };
  };
  const unstablePage = await (await browser.request(origin, `/runs/${unstable.id}`)).text();
  assert.match(unstablePage, /План меняется — обновите страницу/);
  assert.doesNotMatch(unstablePage, /name="action"/);
  assert.doesNotMatch(unstablePage, /Нестабильный план/);
  assert.equal(unstableDocsCalls, 3);
});

test('лимит: ещё попытка и остановка', { skip: serverTestsSkip, timeout: 120_000 }, async (t) => {
  const fake = fakeClaude({
    implement: (n, cwd) =>
      fs.writeFileSync(
        path.join(cwd, 'src/math.js'),
        `export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n// Попытка ${n}\n`,
      ),
    review: () => ({ blocking: [{ file: 'src/math.js', line: 2, message: 'Нужна другая реализация', origin: 'new' }], notes: [] }),
  });
  const fixture = await browserFixture(t, fake);
  const toLimit = async () => {
    const started = await fixture.host.startTask('p1', { task: 'Добавь mul', submissionId: crypto.randomUUID() });
    assert.equal(started.status, 'started');
    const runId = started.status === 'started' ? started.runId : '';
    const gate1 = await untilGate(fixture.core, runId, 'gate1');
    assert.equal(
      (await postDecision(fixture.browser, fixture.origin, runId, { expectedWaitId: gate1.waitId!, action: 'approve' })).status,
      303,
    );
    return untilGate(fixture.core, runId, 'limit');
  };

  const first = await toLimit();
  assert.equal(first.implAttemptsUsed, 3);
  assert.equal(first.implAttemptsLimit, 3);
  assert.equal(first.stuck, undefined);
  assert.ok(first.reviews.at(-1)!.blocking.every((item) => item.origin === 'new'));
  const firstPage = await (await fixture.browser.request(fixture.origin, `/runs/${first.id}`)).text();
  assert.match(firstPage, /3 из 3/);
  assert.match(firstPage, />Ещё попытка</);
  assert.match(firstPage, />Остановить</);

  const retryFields = { expectedWaitId: first.waitId!, action: 'approve', comment: 'Попробуй ещё раз' };
  assert.equal((await postDecision(fixture.browser, fixture.origin, first.id, retryFields)).status, 303);
  const deadline = Date.now() + 10_000;
  while (fake.prompts().length < 4 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fake.prompts().length, 4);
  const retried = (await fixture.core.getRun(first.id))!;
  assert.equal(retried.implAttemptsUsed, 4);
  assert.equal(retried.implAttemptsLimit, 4);
  await untilGate(fixture.core, first.id, 'limit');

  const second = await toLimit();
  const stopFields = { expectedWaitId: second.waitId!, action: 'cancel' };
  assert.equal((await postDecision(fixture.browser, fixture.origin, second.id, stopFields)).status, 303);
  const stopped = (await fixture.core.getRun(second.id))!;
  assert.equal(stopped.status, 'stopped');
  const stoppedPage = await (await fixture.browser.request(fixture.origin, `/runs/${second.id}`)).text();
  assert.match(stoppedPage, /Остановлен/);
  assert.match(stoppedPage, /Лимит попыток: Отменено/);
  const repeatedStop = await postDecision(fixture.browser, fixture.origin, second.id, stopFields);
  assert.equal(repeatedStop.status, 409);
  assert.match(await repeatedStop.text(), /Остановлен/);
  assert.equal((await fixture.core.getRun(second.id))!.gates.filter((gate) => gate.gate === 'limit').length, 1);

  const attempts = waitingRunFixture(fixture.dataDir, fixture.project.path, {
    next: 'limit',
    waitId: 'attempts-fixture',
    implAttemptsUsed: 3,
    implAttemptsLimit: 3,
    message: 'Попытки реализации исчерпаны',
  });
  const attemptsPage = await (await fixture.browser.request(fixture.origin, `/runs/${attempts.id}`)).text();
  assert.match(attemptsPage, /3 из 3/);
  assert.match(attemptsPage, /Попытки реализации исчерпаны/);

  const loop = waitingRunFixture(fixture.dataDir, fixture.project.path, {
    next: 'limit',
    waitId: 'loop-fixture',
    implAttemptsUsed: 2,
    implAttemptsLimit: 3,
    stuck: { items: [{ file: null, line: null, message: 'Те же замечания' }] },
    message: 'Исполнитель и ревьюер ходят по кругу',
  });
  const loopPage = await (await fixture.browser.request(fixture.origin, `/runs/${loop.id}`)).text();
  assert.match(loopPage, /Исполнитель и ревьюер ходят по кругу/);
  assert.doesNotMatch(loopPage, /2 из 3/);
});
