import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { HostSnapshot } from './server/host.js';
import { createServerApp } from './server/main.js';
import {
  Browser,
  configFor,
  fakeClaude,
  listen,
  makeRepo,
  openServer,
  postDecision,
  serverTestsSkip,
  startTestHost,
  untilGate,
  waitingRunFixture,
} from './server-testkit.test.js';
import { RunStore } from './store.js';

test('ожидания: две сессии на одном gate1 — одно решение, второе 409', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const fake = fakeClaude({ implement: () => {}, review: () => ({ blocking: [], notes: [] }) });
  const fixture = await startTestHost({ runners: { claude: fake.fn as never } });
  t.after(() => fixture.close());
  const started = await fixture.host.startTask('p1', { task: 'Добавь mul', submissionId: crypto.randomUUID() });
  assert.equal(started.status, 'started');
  const runId = started.status === 'started' ? started.runId : '';
  const waiting = await untilGate(fixture.core, runId, 'gate1');
  assert.ok(waiting.waitId);
  const origin = await listen(t, createServerApp(configFor(fixture.dataDir, fixture.project), fixture.host));
  const first = new Browser();
  const second = new Browser();
  assert.equal((await first.login(origin)).status, 303);
  assert.equal((await second.login(origin)).status, 303);

  const approved = await postDecision(first, origin, runId, { expectedWaitId: waiting.waitId!, action: 'approve' });
  assert.equal(approved.status, 303);
  assert.equal(approved.headers.get('location'), `/runs/${runId}`);
  const repeated = await postDecision(second, origin, runId, { expectedWaitId: waiting.waitId!, action: 'approve' });
  assert.equal(repeated.status, 409);
  const body = await repeated.text();
  const fresh = (await fixture.core.getRun(runId))!;
  assert.match(body, /Решение уже принято на другом устройстве/);
  assert.match(body, new RegExp(fresh.status));
  assert.match(body, new RegExp(fresh.next));
  assert.deepEqual(
    (await fixture.core.getRun(runId))!.gates.map((gate) => gate.gate),
    ['gate1'],
  );
});

async function waitingFixture(t: TestContext) {
  const fake = fakeClaude({ implement: () => {}, review: () => ({ blocking: [], notes: [] }) });
  const fixture = await startTestHost({ runners: { claude: fake.fn as never } });
  t.after(() => fixture.close());
  const started = await fixture.host.startTask('p1', { task: 'Добавь mul', submissionId: crypto.randomUUID() });
  assert.equal(started.status, 'started');
  const runId = started.status === 'started' ? started.runId : '';
  const waiting = await untilGate(fixture.core, runId, 'gate1');
  assert.ok(waiting.waitId);
  const origin = await listen(t, createServerApp(configFor(fixture.dataDir, fixture.project), fixture.host));
  const browser = new Browser();
  assert.equal((await browser.login(origin)).status, 303);
  return { ...fixture, browser, origin, runId, waiting };
}

test('ожидания: недопустимое действие и пустой комментарий', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const fixture = await waitingFixture(t);
  const withRunLock = t.mock.method(fixture.core.kernel, 'withRunLock');
  const before = (await fixture.core.getRun(fixture.runId))!;

  const answer = await postDecision(fixture.browser, fixture.origin, fixture.runId, {
    expectedWaitId: fixture.waiting.waitId!,
    action: 'answer',
    'answers[0][q]': 'Вопрос',
    'answers[0][a]': 'Ответ',
  });
  assert.equal(answer.status, 400);
  assert.deepEqual((await fixture.core.getRun(fixture.runId))!.gates, before.gates);
  assert.equal((await fixture.core.getRun(fixture.runId))!.next, before.next);

  const rejected = await postDecision(fixture.browser, fixture.origin, fixture.runId, {
    expectedWaitId: fixture.waiting.waitId!,
    action: 'reject',
    comment: '   ',
  });
  assert.equal(rejected.status, 400);
  assert.deepEqual((await fixture.core.getRun(fixture.runId))!.gates, before.gates);
  assert.equal((await fixture.core.getRun(fixture.runId))!.next, before.next);

  fixture.core.kernel.store.save({ ...before, next: 'gate2' });
  const gate2 = await postDecision(fixture.browser, fixture.origin, fixture.runId, {
    expectedWaitId: fixture.waiting.waitId!,
    action: 'approve',
  });
  assert.equal(gate2.status, 400);
  assert.deepEqual((await fixture.core.getRun(fixture.runId))!.gates, before.gates);
  assert.equal((await fixture.core.getRun(fixture.runId))!.next, 'gate2');
  assert.equal(withRunLock.mock.callCount(), 0);
});

test('ожидания: чужой прогон', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const fixture = await waitingFixture(t);
  const foreignPath = makeRepo();
  const foreign = {
    ...fixture.waiting,
    id: crypto.randomUUID(),
    changeId: `foreign-${crypto.randomUUID()}`,
    title: 'Чужой прогон',
    projectPath: foreignPath,
    worktreePath: foreignPath,
    waitId: crypto.randomUUID(),
    gates: [],
  };
  const store = new RunStore(fixture.dataDir);
  store.save(foreign);
  const runFile = path.join(fixture.dataDir, 'runs', `${foreign.id}.json`);
  const saved = fs.readFileSync(runFile, 'utf8');

  const page = await fixture.browser.request(fixture.origin, `/runs/${foreign.id}`);
  assert.equal(page.status, 404);
  const decision = await postDecision(fixture.browser, fixture.origin, foreign.id, {
    expectedWaitId: foreign.waitId!,
    action: 'approve',
  });
  assert.equal(decision.status, 404);
  assert.equal(fs.readFileSync(runFile, 'utf8'), saved);
});

test('ожидания: старый waitId после возврата на gate1', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const fixture = await waitingFixture(t);
  const rejected = await postDecision(fixture.browser, fixture.origin, fixture.runId, {
    expectedWaitId: fixture.waiting.waitId!,
    action: 'reject',
    comment: 'Переработай план',
  });
  assert.equal(rejected.status, 303);
  const returned = await untilGate(fixture.core, fixture.runId, 'gate1');
  assert.ok(returned.waitId);
  assert.notEqual(returned.waitId, fixture.waiting.waitId);

  const stale = await postDecision(fixture.browser, fixture.origin, fixture.runId, {
    expectedWaitId: fixture.waiting.waitId!,
    action: 'approve',
  });
  assert.equal(stale.status, 409);
  const current = (await fixture.core.getRun(fixture.runId))!;
  assert.equal(current.waitId, returned.waitId);
  assert.equal(current.next, 'gate1');
  assert.deepEqual(
    current.gates.map((gate) => gate.gate),
    ['gate1'],
  );
});

test('ожидания: запоздалая форма прошлого гейта — 409, а не 400', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const fixture = await waitingFixture(t);
  const withRunLock = t.mock.method(fixture.core.kernel, 'withRunLock');
  const previousGate = await postDecision(fixture.browser, fixture.origin, fixture.runId, {
    expectedWaitId: crypto.randomUUID(),
    action: 'answer',
    'answers[0][q]': 'Вопрос',
    'answers[0][a]': 'Ответ',
  });
  assert.equal(previousGate.status, 409);
  assert.match(await previousGate.text(), /gate1/);

  fixture.core.kernel.store.save({ ...fixture.waiting, status: 'running', next: 'implement' });
  const previousWait = await postDecision(fixture.browser, fixture.origin, fixture.runId, {
    expectedWaitId: fixture.waiting.waitId!,
    action: 'approve',
  });
  assert.equal(previousWait.status, 409);
  const body = await previousWait.text();
  assert.match(body, /running/);
  assert.match(body, /implement/);
  const current = (await fixture.core.getRun(fixture.runId))!;
  assert.equal(current.status, 'running');
  assert.equal(current.next, 'implement');
  assert.deepEqual(current.gates, []);
  assert.equal(withRunLock.mock.callCount(), 0);
});

test('обзор: ожидания с причиной после рестарта', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const fake = fakeClaude({ implement: () => {}, review: () => ({ blocking: [], notes: [] }) });
  const runners = { claude: fake.fn as never };
  const first = await startTestHost({ runners });
  t.after(() => first.close());
  const gate0 = waitingRunFixture(first.dataDir, first.project.path, {
    next: 'gate0',
    title: 'Нужны ответы',
    clarify: { questions: [{ q: 'Какие числа поддерживать?' }] },
  });
  const gate1 = waitingRunFixture(first.dataDir, first.project.path, { next: 'gate1', title: 'Нужно утверждение' });
  const gate2 = waitingRunFixture(first.dataDir, first.project.path, { next: 'gate2', title: 'Нужна приёмка' });
  const loop = waitingRunFixture(first.dataDir, first.project.path, {
    next: 'limit',
    title: 'Круг исправлений',
    message: '<b>Исполнитель и ревьюер ходят по кругу</b>',
    stuck: { items: [{ file: null, line: null, message: 'Те же замечания' }] },
    implAttemptsUsed: 2,
    implAttemptsLimit: 3,
  });
  const attempts = waitingRunFixture(first.dataDir, first.project.path, {
    next: 'limit',
    title: 'Попытки исчерпаны',
    message: 'Попытки реализации исчерпаны',
    implAttemptsUsed: 3,
    implAttemptsLimit: 3,
  });
  const fixtures = [gate0, gate1, gate2, loop, attempts];
  const config = configFor(first.dataDir, first.project);
  const firstServer = await openServer(createServerApp(config, first.host));
  t.after(firstServer.close);
  const browser = new Browser();
  assert.equal((await browser.login(firstServer.origin)).status, 303);
  await firstServer.close();
  await first.close();

  const second = await startTestHost({
    dataDir: first.dataDir,
    project: { path: first.project.path },
    runners,
    settings: first.settings,
  });
  t.after(() => second.close());
  const secondServer = await openServer(createServerApp(configFor(second.dataDir, second.project), second.host));
  t.after(secondServer.close);
  const oldSession = await browser.request(secondServer.origin, '/');
  assert.equal(oldSession.status, 303);
  assert.equal((await browser.login(secondServer.origin)).status, 303);

  const response = await browser.request(secondServer.origin, '/api/overview');
  assert.equal(response.status, 200);
  const snapshot = (await response.json()) as HostSnapshot;
  assert.equal(snapshot.runs.length, 5);
  const byId = new Map(snapshot.runs.map((run) => [run.id, run]));
  for (const fixture of fixtures) {
    const run = byId.get(fixture.id);
    assert.ok(run, fixture.title);
    assert.equal(run.waitId, fixture.waitId, fixture.title);
    assert.equal(run.gate, fixture.next, fixture.title);
    assert.ok(run.reason, fixture.title);
  }
  assert.match(byId.get(gate0.id)!.reason!, /1 вопрос/);
  assert.deepEqual(byId.get(loop.id)!.limit, { cause: 'loop', attempts: 2, max: 3 });
  assert.deepEqual(byId.get(attempts.id)!.limit, { cause: 'attempts', attempts: 3, max: 3 });

  const overview = await (await browser.request(secondServer.origin, '/')).text();
  assert.match(overview, /&lt;b&gt;Исполнитель и ревьюер ходят по кругу&lt;\/b&gt;/);
  assert.doesNotMatch(overview, /<b>Исполнитель/);

  const answerFields = {
    expectedWaitId: byId.get(gate0.id)!.waitId!,
    action: 'answer',
    'answers[0][q]': 'Какие числа поддерживать?',
    'answers[0][a]': 'Целые числа',
  };
  const answered = await postDecision(browser, secondServer.origin, gate0.id, answerFields);
  assert.equal(answered.status, 303);
  const answeredRun = (await second.core.getRun(gate0.id))!;
  assert.equal(answeredRun.gates.filter((gate) => gate.gate === 'gate0').length, 1);
  assert.notEqual(answeredRun.next, 'gate0');
  assert.equal((await postDecision(browser, secondServer.origin, gate0.id, answerFields)).status, 409);

  const approveFields = { expectedWaitId: byId.get(gate1.id)!.waitId!, action: 'approve' };
  const approved = await postDecision(browser, secondServer.origin, gate1.id, approveFields);
  assert.equal(approved.status, 303);
  const approvedRun = (await second.core.getRun(gate1.id))!;
  assert.equal(approvedRun.gates.filter((gate) => gate.gate === 'gate1').length, 1);
  assert.notEqual(approvedRun.next, 'gate1');
  assert.equal((await postDecision(browser, secondServer.origin, gate1.id, approveFields)).status, 409);
});
