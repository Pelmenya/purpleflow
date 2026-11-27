import assert from 'node:assert/strict';
import fs from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { drive, UNQUEUED_MESSAGE, USER_STOP_MESSAGE } from './engine.js';
import { run } from './proc.js';
import { loadServerConfig } from './server/config.js';
import { createServerApp } from './server/main.js';
import {
  Browser,
  configFor,
  fakeClaude,
  listen,
  makeRepo,
  makeServerStand,
  postDecision,
  serverTestsSkip,
  spawnService,
  startTestHost,
  untilGate,
  waitingRunFixture,
} from './server-testkit.test.js';
import { RunStore } from './store.js';
import type { CoreEvent, CoreSettings, RunFile } from './types.js';

const recoveryTest = { skip: serverTestsSkip, timeout: 120_000 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T, S extends T>(read: () => T | Promise<T>, done: (value: T) => value is S, timeoutMs?: number): Promise<S>;
async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, timeoutMs?: number): Promise<T>;
async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error('Не дождались состояния прогона');
    await sleep(100);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

async function startTask(browser: Browser, origin: string, task: string): Promise<string> {
  const project = await browser.request(origin, '/projects/p1');
  const submissionId = /name="submissionId" value="([0-9a-f-]+)"/.exec(await project.text())?.[1];
  assert.ok(submissionId);
  const started = await browser.request(origin, '/projects/p1/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ submissionId, task }),
  });
  assert.equal(started.status, 303);
  const runId = started.headers.get('location')?.split('/').at(-1);
  assert.ok(runId);
  return runId;
}

function stoppedRun(store: RunStore, runId: string): Promise<RunFile> {
  return until(
    () => store.load(runId),
    (run): run is RunFile => run?.status === 'stopped',
  );
}

test('журнал и остановка: вход с возвратом, 404 для чужого прогона, причина ошибки после перезагрузки', recoveryTest, async (t) => {
  const stand = makeServerStand();
  const store = new RunStore(stand.dataDir);
  const foreign = waitingRunFixture(stand.dataDir, makeRepo(), {
    next: 'gate1',
    status: 'stopped',
    message: 'Чужой прогон не менять',
  });
  store.appendLog(foreign.id, 'Чужой журнал не менять\n');
  const foreignBefore = JSON.stringify(store.load(foreign.id));
  const service = await spawnService(stand);
  t.after(service.stop);

  const anonymous = new Browser();
  const anonymousLog = await anonymous.request(service.origin, `/runs/${foreign.id}/log`);
  assert.equal(anonymousLog.status, 303);
  assert.equal(anonymousLog.headers.get('location'), `/login?returnTo=${encodeURIComponent(`/runs/${foreign.id}/log`)}`);

  const client = new Browser();
  assert.equal((await client.login(service.origin)).status, 303);
  const runId = await startTask(client, service.origin, 'Добавь mul. СЛОМАЙ_АГЕНТА');
  const gate1 = await until(
    () => store.load(runId),
    (run): run is RunFile => run?.status === 'waiting' && run.next === 'gate1',
  );
  assert.equal((await postDecision(client, service.origin, runId, { expectedWaitId: gate1.waitId!, action: 'approve' })).status, 303);
  const failed = await stoppedRun(store, runId);
  assert.ok(failed.message);

  const anonymousStop = await anonymous.request(service.origin, `/runs/${runId}/stop`, { method: 'POST' });
  assert.equal(anonymousStop.status, 303);
  assert.deepEqual(store.load(runId), failed);

  const secondClient = new Browser();
  const loggedIn = await secondClient.login(service.origin, `/runs/${runId}/log`);
  assert.equal(loggedIn.status, 303);
  assert.equal(loggedIn.headers.get('location'), `/runs/${runId}/log`);
  const page = await secondClient.request(service.origin, `/runs/${runId}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), new RegExp(escapeHtml(failed.message).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const log = await secondClient.request(service.origin, `/runs/${runId}/log`);
  assert.equal(log.status, 200);
  assert.match(await log.text(), new RegExp(escapeHtml(failed.message).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const foreignLog = await secondClient.request(service.origin, `/runs/${foreign.id}/log`);
  assert.equal(foreignLog.status, 404);
  const foreignStop = await secondClient.request(service.origin, `/runs/${foreign.id}/stop`, { method: 'POST' });
  assert.equal(foreignStop.status, 404);
  assert.equal(JSON.stringify(store.load(foreign.id)), foreignBefore);
  assert.equal(store.readLog(foreign.id), 'Чужой журнал не менять\n');
  assert.equal(fs.existsSync(store.logFile(runId)), true);
});

async function hostFixture(
  t: TestContext,
  opts: { stand?: ReturnType<typeof makeServerStand>; settings?: CoreSettings; fake?: ReturnType<typeof fakeClaude> } = {},
) {
  const stand = opts.stand ?? makeServerStand();
  const settings = opts.settings ?? loadServerConfig(stand.configFile).settings;
  const fixture = await startTestHost({
    dataDir: stand.dataDir,
    settings,
    project: stand.project,
    runners: opts.fake ? { claude: opts.fake.fn as never } : undefined,
  });
  t.after(fixture.close);
  const origin = await listen(t, createServerApp(configFor(stand.dataDir, stand.project, settings), fixture.host));
  const browser = new Browser();
  assert.equal((await browser.login(origin)).status, 303);
  return { ...fixture, stand, settings, origin, browser };
}

function beginStartTask(browser: Browser, origin: string, task: string): Promise<Response> {
  return browser.request(origin, '/projects/p1').then(async (project) => {
    const submissionId = /name="submissionId" value="([0-9a-f-]+)"/.exec(await project.text())?.[1];
    assert.ok(submissionId);
    return browser.request(origin, '/projects/p1/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ submissionId, task }),
    });
  });
}

function responseRunId(response: Response): string {
  const runId = response.headers.get('location')?.split('/').at(-1);
  assert.ok(runId);
  return runId;
}

function runningFixture(dataDir: string, projectPath: string): RunFile {
  const run = waitingRunFixture(dataDir, projectPath, {
    next: 'gate1',
    status: 'running',
    waitId: undefined,
    attempts: [],
  });
  run.next = 'implement';
  new RunStore(dataDir).save(run);
  return run;
}

function stopFromBrowser(browser: Browser, origin: string, runId: string, headers?: HeadersInit): Promise<Response> {
  return browser.request(origin, `/runs/${runId}/stop`, { method: 'POST', headers });
}

test('остановка сериализована с решениями', recoveryTest, async (t) => {
  const fake = fakeClaude({ implement: () => {}, review: () => ({ blocking: [], notes: [] }) });
  const fixture = await hostFixture(t, { fake });
  const cancelledId = await startTask(fixture.browser, fixture.origin, 'Отмена и остановка на gate1');
  const cancelledGate = await untilGate(fixture.core, cancelledId, 'gate1');
  const [cancelStop, cancel] = await Promise.all([
    stopFromBrowser(fixture.browser, fixture.origin, cancelledId),
    postDecision(fixture.browser, fixture.origin, cancelledId, { expectedWaitId: cancelledGate.waitId!, action: 'cancel' }),
  ]);
  assert.equal(cancelStop.status, 409);
  assert.equal(cancel.status, 303);
  assert.equal(fixture.core.kernel.mustLoad(cancelledId).status, 'cancelled');

  const approvedId = await startTask(fixture.browser, fixture.origin, 'Утверждение и остановка на gate1');
  const approvedGate = await untilGate(fixture.core, approvedId, 'gate1');
  const [approve, approveStop] = await Promise.all([
    postDecision(fixture.browser, fixture.origin, approvedId, { expectedWaitId: approvedGate.waitId!, action: 'approve' }),
    stopFromBrowser(fixture.browser, fixture.origin, approvedId),
  ]);
  assert.equal(approve.status, 303);
  assert.ok([303, 409].includes(approveStop.status));
  const approved = fixture.core.kernel.mustLoad(approvedId);
  assert.equal(approved.gates.filter((gate) => gate.gate === 'gate1').length, 1);
  assert.notEqual(approved.status, 'cancelled');

  const waiting = waitingRunFixture(fixture.dataDir, fixture.project.path, { next: 'gate1', waitId: 'stop-waiting' });
  const waitingStop = await stopFromBrowser(fixture.browser, fixture.origin, waiting.id);
  assert.equal(waitingStop.status, 409);
  assert.match(await waitingStop.text(), /data-status="waiting"/);
});

test('остановка: чужой Origin', recoveryTest, async (t) => {
  const fixture = await hostFixture(t);
  const run = runningFixture(fixture.dataDir, fixture.project.path);
  const before = fixture.core.kernel.mustLoad(run.id);
  const response = await stopFromBrowser(fixture.browser, fixture.origin, run.id, { Origin: 'https://evil.example' });
  assert.equal(response.status, 403);
  assert.deepEqual(fixture.core.kernel.mustLoad(run.id), before);
});

function openspecGate(stand: ReturnType<typeof makeServerStand>): { settings: CoreSettings; initStarted: string } {
  const config = loadServerConfig(stand.configFile);
  const initStarted = path.join(stand.root, 'init-started');
  const initRelease = path.join(stand.root, 'init-release');
  const initFail = path.join(stand.root, 'init-fail');
  const wrapper = path.join(stand.root, 'openspec-wrapper');
  const real = config.settings.toolPaths.openspec!;
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh\nif [ "$1" = init ]; then\n  : > "${initStarted}"\n  if [ -e "${initFail}" ]; then\n    while [ ! -e "${initRelease}" ]; do sleep 0.05; done\n    exit 1\n  fi\n  sleep 60\n  exit 1\nfi\nexec "${real}" "$@"\n`,
    { mode: 0o755 },
  );
  return {
    settings: { ...config.settings, toolPaths: { ...config.settings.toolPaths, openspec: wrapper } },
    initStarted,
  };
}

async function stopDuringPreparation(t: TestContext, beforeInit: boolean): Promise<void> {
  const stand = makeServerStand();
  const gated = openspecGate(stand);
  const fixture = await hostFixture(t, { stand, settings: gated.settings });
  const startedAt = Date.now();
  const starting = beginStartTask(fixture.browser, fixture.origin, 'Остановка подготовки');
  if (!beforeInit) await until(() => fs.existsSync(gated.initStarted), Boolean, 10_000);
  const listed = await until(
    () => fixture.core.listRuns(),
    (runs) => runs.length === 1,
    10_000,
  );
  const runId = listed[0]!.id;
  if (beforeInit) await until(() => fixture.core.kernel.preparing.has(runId), Boolean, 10_000);
  const stopping = stopFromBrowser(fixture.browser, fixture.origin, runId);
  await until(() => fixture.core.kernel.stopping.has(runId) || fixture.core.kernel.mustLoad(runId).status === 'stopped', Boolean, 10_000);
  const [started, stopped] = await Promise.all([starting, stopping]);
  assert.equal(started.status, 303);
  assert.equal(responseRunId(started), runId);
  assert.equal(stopped.status, 303);
  assert.ok(Date.now() - startedAt < 10_000);
  const run = fixture.core.kernel.mustLoad(runId);
  assert.equal(run.status, 'stopped');
  assert.equal(run.message, USER_STOP_MESSAGE);
  assert.equal((await fixture.browser.request(fixture.origin, `/runs/${runId}`)).status, 200);
  assert.deepEqual(fixture.core.kernel.store.readPids(runId), []);
}

test('остановка во время подготовки сохраняет прогон', recoveryTest, async (t) => {
  await stopDuringPreparation(t, false);
});

test('остановка в начале подготовки, до запуска init', recoveryTest, async (t) => {
  await stopDuringPreparation(t, true);
});

test('остановка не перезаписывает завершённый прогон и техническую ошибку', recoveryTest, async (t) => {
  const fixture = await hostFixture(t);
  for (const outcome of ['finished', 'failed'] as const) {
    const run = runningFixture(fixture.dataDir, fixture.project.path);
    const child = runProcess(run.id, fixture.project.path);
    const stopping = stopFromBrowser(fixture.browser, fixture.origin, run.id);
    await sleep(200);
    const current = fixture.core.kernel.mustLoad(run.id);
    if (outcome === 'finished') {
      current.status = 'finished';
      current.message = 'Завершено параллельно';
      current.commit = 'abc123';
      fixture.core.kernel.save(current);
    } else {
      fixture.core.kernel.fail(current, 'Сбой стадии во время остановки');
    }
    const response = await stopping;
    assert.equal(response.status, 409);
    const saved = fixture.core.kernel.mustLoad(run.id);
    assert.equal(saved.status, outcome === 'finished' ? 'finished' : 'stopped');
    assert.equal(saved.message, outcome === 'finished' ? 'Завершено параллельно' : 'Сбой стадии во время остановки');
    await child;
    assert.equal((await stopFromBrowser(fixture.browser, fixture.origin, run.id)).status, 409);
  }
});

function runProcess(runId: string, cwd: string): Promise<unknown> {
  return run('sh', ['-c', 'trap "" TERM; sleep 30'], { group: `${runId}:server`, cwd, env: process.env });
}

test('остановка до входа в drive', recoveryTest, async (t) => {
  let implementations = 0;
  const fake = fakeClaude({
    implement: () => {
      implementations++;
    },
    review: () => ({ blocking: [], notes: [] }),
  });
  const fixture = await hostFixture(t, { fake });
  const run = runningFixture(fixture.dataDir, fixture.project.path);
  fixture.core.kernel.stopping.add(run.id);
  await drive(fixture.core.kernel, run);
  assert.equal(implementations, 0);
  assert.equal(fixture.core.kernel.mustLoad(run.id).status, 'stopped');
  assert.equal(fixture.core.kernel.mustLoad(run.id).message, USER_STOP_MESSAGE);
});

test('ошибка с текстом ручной остановки — конфликт', recoveryTest, async (t) => {
  const fixture = await hostFixture(t);
  const events: CoreEvent[] = [];
  fixture.core.kernel.on((event) => events.push(event));
  const run = runningFixture(fixture.dataDir, fixture.project.path);
  fixture.core.kernel.driving.add(run.id);
  const stopping = stopFromBrowser(fixture.browser, fixture.origin, run.id);
  await until(() => fixture.core.kernel.stopping.has(run.id), Boolean, 10_000);
  fixture.core.kernel.fail(fixture.core.kernel.mustLoad(run.id), USER_STOP_MESSAGE);
  fixture.core.kernel.driving.delete(run.id);
  assert.equal((await stopping).status, 409);
  assert.equal(fixture.core.kernel.mustLoad(run.id).message, USER_STOP_MESSAGE);
  assert.ok(events.some((event) => event.type === 'run.finished' && event.runId === run.id && event.reason === 'stage_failed'));
});

test('остановка совпала с технической ошибкой', recoveryTest, async (t) => {
  const fixture = await hostFixture(t);
  const run = runningFixture(fixture.dataDir, fixture.project.path);
  fixture.core.kernel.driving.add(run.id);
  const stopping = stopFromBrowser(fixture.browser, fixture.origin, run.id);
  await until(() => fixture.core.kernel.stopping.has(run.id), Boolean, 10_000);
  fixture.core.kernel.fail(fixture.core.kernel.mustLoad(run.id), 'Сбой стадии');
  fixture.core.kernel.driving.delete(run.id);
  assert.equal((await stopping).status, 409);
  assert.equal(fixture.core.kernel.mustLoad(run.id).message, 'Сбой стадии');
});

test('остановка ожидающего в очереди подтверждается событием unqueued', recoveryTest, async (t) => {
  const fixture = await hostFixture(t);
  const events: CoreEvent[] = [];
  fixture.core.kernel.on((event) => events.push(event));
  const run = waitingRunFixture(fixture.dataDir, fixture.project.path, { next: 'gate1', status: 'queued', waitId: undefined });
  assert.equal((await stopFromBrowser(fixture.browser, fixture.origin, run.id)).status, 303);
  assert.equal(fixture.core.kernel.mustLoad(run.id).message, UNQUEUED_MESSAGE);
  assert.ok(events.some((event) => event.type === 'run.finished' && event.runId === run.id && event.reason === 'unqueued'));
});

async function reachImplement(service: Awaited<ReturnType<typeof spawnService>>, stand: ReturnType<typeof makeServerStand>) {
  const store = new RunStore(stand.dataDir);
  const browser = new Browser();
  assert.equal((await browser.login(service.origin)).status, 303);
  const runId = await startTask(browser, service.origin, 'Добавь mul');
  const gate1 = await until(
    () => store.load(runId),
    (run): run is RunFile => run?.status === 'waiting' && run.next === 'gate1',
  );
  fs.writeFileSync(stand.delayFile, '600000');
  assert.equal((await postDecision(browser, service.origin, runId, { expectedWaitId: gate1.waitId!, action: 'approve' })).status, 303);
  const active = await until(
    () => ({ run: store.load(runId), pids: store.readPids(runId) }),
    (value) =>
      Boolean(value.run?.attempts.some((attempt) => attempt.stage === 'implement' && attempt.status === 'running') && value.pids.length),
  );
  assert.ok(active.run);
  assert.ok(active.pids[0]);
  return { browser, runId, before: active.run, pid: active.pids[0] };
}

async function signalService(service: Awaited<ReturnType<typeof spawnService>>, signal: NodeJS.Signals): Promise<void> {
  if (service.proc.exitCode !== null || service.proc.signalCode !== null) return;
  const exited = once(service.proc, 'exit');
  assert.ok(service.proc.kill(signal));
  await exited;
}

function assertProcessDead(pid: number): void {
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}

async function recoveredGate2(stand: ReturnType<typeof makeServerStand>, runId: string): Promise<RunFile> {
  const store = new RunStore(stand.dataDir);
  return until(
    () => store.load(runId),
    (run): run is RunFile => run?.status === 'waiting' && run.next === 'gate2',
  );
}

test('падение процесса на реализации: тот же прогон и рабочая копия, прерванная и новая попытки', recoveryTest, async (t) => {
  const stand = makeServerStand();
  let service = await spawnService(stand);
  t.after(() => service.stop());
  const { runId, before, pid } = await reachImplement(service, stand);
  const worktreePath = before.worktreePath;

  await signalService(service, 'SIGKILL');
  fs.writeFileSync(stand.delayFile, '0');
  service = await spawnService(stand);
  const client = new Browser();
  assert.equal((await client.login(service.origin)).status, 303);
  const recovered = await recoveredGate2(stand, runId);

  assertProcessDead(pid);
  assert.equal(recovered.id, runId);
  assert.equal(recovered.worktreePath, worktreePath);
  assert.equal(fs.existsSync(worktreePath), true);
  const implementations = recovered.attempts.filter((attempt) => attempt.stage === 'implement');
  assert.equal(implementations[0]?.status, 'stopped');
  assert.equal(implementations[1]?.status, 'done');
});

test('SIGTERM с активным прогоном завершает дочерний процесс', recoveryTest, async (t) => {
  const stand = makeServerStand();
  let service = await spawnService(stand);
  t.after(() => service.stop());
  const { runId, before, pid } = await reachImplement(service, stand);

  await signalService(service, 'SIGTERM');
  assertProcessDead(pid);
  fs.writeFileSync(stand.delayFile, '0');
  service = await spawnService(stand);
  const client = new Browser();
  assert.equal((await client.login(service.origin)).status, 303);
  const recovered = await recoveredGate2(stand, runId);
  assert.equal(recovered.worktreePath, before.worktreePath);
  assert.ok(recovered.attempts.some((attempt) => attempt.stage === 'implement' && attempt.status === 'done'));
});

test('остановка кнопкой', recoveryTest, async (t) => {
  const stand = makeServerStand();
  const service = await spawnService(stand);
  t.after(service.stop);
  const { runId } = await reachImplement(service, stand);
  const secondClient = new Browser();
  assert.equal((await secondClient.login(service.origin)).status, 303);
  const page = await secondClient.request(service.origin, `/runs/${runId}`);
  assert.equal(page.status, 200);
  const action = /<form method="post" action="([^"]+)"><button type="submit">Остановить<\/button><\/form>/.exec(await page.text())?.[1];
  assert.equal(action, `/runs/${runId}/stop`);

  const stopped = await secondClient.request(service.origin, action!, { method: 'POST' });
  assert.equal(stopped.status, 303);
  const after = await secondClient.request(service.origin, `/runs/${runId}`);
  assert.equal(after.status, 200);
  const html = await after.text();
  assert.match(html, /data-status="stopped"/);
  assert.match(html, /Остановлено пользователем/);
});
