import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyUsage } from './agents/common.js';
import { autoDecide } from './gates.js';
import { Orchestrator } from './orchestrator.js';
import { run } from './proc.js';
import type { CoreOptions } from './runtime.js';
import { createServerCore, type ServerCore } from './server/guard.js';
import { fakeClaude, hasOpenspec, makeRepo, serverTestsSkip, untilGate } from './server-testkit.test.js';
import type { RunStore } from './store.js';
import type { CoreSettings, RunFile } from './types.js';

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
const decisionTest = { skip: serverTestsSkip || !hasOpenspec, timeout: 120_000 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeCore(
  t: TestContext,
  fake: ReturnType<typeof fakeClaude>,
  over: { allowProject?: CoreOptions['allowProject'] } = {},
): { core: ServerCore; repo: string; options: CoreOptions } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-server-decision-'));
  const repo = makeRepo();
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho "claude 1.0.0"\n', { mode: 0o755 });
  const settings = {
    toolPaths: { claude: path.join(bin, 'claude') },
    proxy: { baseUrl: '', apiKey: '' },
    models: { planner: '', executor: '', reviewer: '' },
    agents: { planner: 'claude', executor: 'claude', reviewer: 'claude' },
    enabledAgents: ['claude'],
    agentTimeoutMin: 5,
    testTimeoutMin: 2,
    maxParallel: 2,
  } as unknown as CoreSettings;
  const options: CoreOptions = {
    dataDir: path.join(root, 'data'),
    promptsDir: PROMPTS,
    env: process.env,
    getSettings: () => settings,
    runners: { claude: fake.fn as never },
    allowProject: over.allowProject,
  };
  const core = createServerCore(options);
  t.after(async () => {
    await core.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });
  return { core, repo, options };
}

function defaultFake() {
  return fakeClaude({
    implement: (_n, cwd) =>
      fs.writeFileSync(path.join(cwd, 'src/math.js'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n'),
    review: () => ({ blocking: [], notes: [] }),
  });
}

async function startToGate(core: ServerCore, repo: string, gate = 'gate1') {
  const { runId } = await core.dispatch({
    type: 'run.start',
    input: {
      projectPath: repo,
      task: 'Добавь функцию mul(a, b) в src/math.js и тест.',
      testCommand: 'node --test',
      mode: 'task',
      workspace: 'worktree',
    },
  });
  const current = await untilGate(core, runId, gate);
  return { runId, run: current };
}

function saveRun(store: RunStore, projectPath: string, over: Partial<RunFile> = {}): RunFile {
  const id = over.id ?? crypto.randomUUID();
  const current = {
    version: 2,
    id,
    title: 'Прогон для решения',
    task: 'Сделай',
    changeId: `c-${id}`,
    mode: 'quick',
    status: 'stopped',
    next: 'implement',
    workspace: 'worktree',
    projectPath,
    worktreePath: projectPath,
    worktreeRemoved: true,
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
  store.save(current);
  return current;
}

function backupFile(options: CoreOptions, runId: string): string {
  return path.join(options.dataDir, 'runs', `${runId}.json`);
}

async function toLimit(core: ServerCore, runId: string, waitId = 'L'): Promise<RunFile> {
  const current = (await core.getRun(runId))!;
  current.status = 'waiting';
  current.next = 'limit';
  current.waitId = waitId;
  delete current.waitDecided;
  for (const attempt of current.attempts) if (attempt.stage === 'gate1' && attempt.status === 'running') attempt.status = 'done';
  current.attempts.push({
    stage: 'limit',
    attempt: current.attempts.filter((attempt) => attempt.stage === 'limit').length + 1,
    startedAt: new Date().toISOString(),
    status: 'running',
  });
  core.kernel.store.save(current);
  return current;
}

test('решение: две команды на одну попытку — один переход', decisionTest, async (t) => {
  const { core, repo } = makeCore(t, defaultFake());
  const { runId, run: waiting } = await startToGate(core, repo);

  const results = await Promise.allSettled([
    core.decideExpected(runId, waiting.waitId!, { action: 'approve' }),
    core.decideExpected(runId, waiting.waitId!, { action: 'approve' }),
  ]);

  const values = results.map((result) => (result.status === 'fulfilled' ? result.value : ({ ok: false, conflict: true } as const)));
  assert.deepEqual(
    values.sort((a, b) => Number(b.ok) - Number(a.ok)),
    [{ ok: true }, { ok: false, conflict: true }],
  );
  const saved = await core.getRun(runId);
  assert.equal(saved?.gates.filter((entry) => entry.gate === 'gate1').length, 1);
});

test('решение: ответ и принятие на gate0 одновременно — один переход', decisionTest, async (t) => {
  const fake = defaultFake();
  const base = fake.fn;
  fake.fn = (async (options: Parameters<typeof fake.fn>[0]) => {
    if (/Перед планом проверь/.test(options.prompt))
      return { ok: true, text: '{"questions":[{"q":"Какие числа поддерживать?"}]}', usage: emptyUsage() };
    return base(options);
  }) as typeof fake.fn;
  const { core, repo } = makeCore(t, fake);
  const { runId, run: waiting } = await startToGate(core, repo, 'gate0');
  core.kernel.engine.drive = async () => {};

  const results = await Promise.allSettled([
    core.dispatch({ type: 'gate.answer', runId, answers: [{ q: 'Какие числа поддерживать?', a: 'целые' }] }),
    core.decideExpected(runId, waiting.waitId!, { action: 'approve' }),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled' && (!('ok' in result.value) || result.value.ok)).length, 1);
  const saved = await core.getRun(runId);
  assert.equal(saved?.gates.filter((entry) => entry.gate === 'gate0').length, 1);
  assert.equal(saved?.next, 'plan');
});

test('решение: запоздалая команда после возврата на тот же gate1', decisionTest, async (t) => {
  const { core, repo } = makeCore(t, defaultFake());
  const { runId, run: first } = await startToGate(core, repo);
  assert.deepEqual(await core.decideExpected(runId, first.waitId!, { action: 'reject', comment: 'Перепиши план' }), {
    ok: true,
  });
  const second = await untilGate(core, runId, 'gate1');
  assert.notEqual(second.waitId, first.waitId);

  assert.deepEqual(await core.decideExpected(runId, first.waitId!, { action: 'approve' }), {
    ok: false,
    conflict: true,
  });
  const saved = await core.getRun(runId);
  assert.equal(saved?.gates.filter((entry) => entry.gate === 'gate1').length, 1);
});

test('решение: повтор после успешной команды', decisionTest, async (t) => {
  const { core, repo } = makeCore(t, defaultFake());
  const { runId, run: waiting } = await startToGate(core, repo);
  assert.deepEqual(await core.decideExpected(runId, waiting.waitId!, { action: 'approve' }), { ok: true });

  assert.deepEqual(await core.decideExpected(runId, waiting.waitId!, { action: 'approve' }), {
    ok: false,
    conflict: true,
  });
  const saved = await core.getRun(runId);
  assert.equal(saved?.gates.filter((entry) => entry.gate === 'gate1').length, 1);
});

test('решение: повтор cancel на limit', decisionTest, async (t) => {
  const { core, repo } = makeCore(t, defaultFake());
  const { runId } = await startToGate(core, repo);
  await toLimit(core, runId);

  assert.deepEqual(await core.decideExpected(runId, 'L', { action: 'cancel' }), { ok: true });
  assert.equal((await core.getRun(runId))?.status, 'stopped');
  assert.deepEqual(await core.decideExpected(runId, 'L', { action: 'cancel' }), { ok: false, conflict: true });
  assert.deepEqual(await core.decideExpected(runId, 'L', { action: 'approve' }), { ok: false, conflict: true });
  const saved = await core.getRun(runId);
  assert.equal(saved?.status, 'stopped');
  assert.equal(saved?.gates.filter((entry) => entry.gate === 'limit').length, 1);
});

test('решение: повтор через dispatch на limit', decisionTest, async (t) => {
  const fake = defaultFake();
  const { core, repo } = makeCore(t, fake);
  const { runId } = await startToGate(core, repo);
  await toLimit(core, runId);
  let finished = 0;
  core.on((event) => {
    if (event.type === 'run.finished' && event.runId === runId) finished++;
  });

  const results = await Promise.allSettled([core.dispatch({ type: 'gate.cancel', runId }), core.dispatch({ type: 'gate.cancel', runId })]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  assert.match((rejected.reason as Error).message, /Решение по этому ожиданию уже принято/);
  await assert.rejects(core.dispatch({ type: 'gate.approve', runId }), /Решение по этому ожиданию уже принято/);
  const saved = await core.getRun(runId);
  assert.equal(saved?.gates.filter((entry) => entry.gate === 'limit').length, 1);
  assert.equal(fake.prompts().length, 0);
  assert.equal(finished, 1);
});

test('desktop: продолжение после cancel на limit', decisionTest, async (t) => {
  const fake = defaultFake();
  const { core, repo, options } = makeCore(t, fake);
  const { runId } = await startToGate(core, repo);
  await toLimit(core, runId);
  assert.deepEqual(await core.decideExpected(runId, 'L', { action: 'cancel' }), { ok: true });

  const desktop = new Orchestrator(options);
  await desktop.dispatch({ type: 'gate.approve', runId });

  const saved = await desktop.getRun(runId);
  assert.equal(saved?.gates.filter((entry) => entry.gate === 'limit').length, 2);
  for (let i = 0; i < 500 && fake.prompts().length === 0; i++) await sleep(20);
  const implementPrompts = fake.prompts().length;
  desktop.kernel.closing = true;
  for (let i = 0; i < 500 && desktop.kernel.driving.has(runId); i++) await sleep(20);
  assert.equal(desktop.kernel.driving.has(runId), false);
  assert.equal(implementPrompts, 1);
});

test('автопилот: старый таймер не решает новое ожидание', decisionTest, async (t) => {
  const { core, repo } = makeCore(t, defaultFake());
  const waiting = saveRun(core.kernel.store, repo, { status: 'waiting', next: 'gate1', waitId: 'A' });

  const deciding = autoDecide(core.kernel, waiting.id, 'gate1', 'A', 'Автопилот не смог принять план');
  const replacement = (await core.getRun(waiting.id))!;
  replacement.waitId = 'B';
  core.kernel.store.save(replacement);
  await deciding;

  const saved = await core.getRun(waiting.id);
  assert.equal(saved?.gates.length, 0);
  assert.equal(saved?.warnings, undefined);
  assert.doesNotMatch(await core.getLog(waiting.id), /Автопилот не смог принять план/);
});

test('восстановление: старое ожидание получает waitId до готовности', decisionTest, async (t) => {
  const { core, repo } = makeCore(t, defaultFake());
  const waiting = saveRun(core.kernel.store, repo, { status: 'waiting', next: 'gate1' });

  await core.recover();

  const recovered = await core.getRun(waiting.id);
  assert.ok(recovered?.waitId);
  assert.equal((await core.getRun(waiting.id))?.waitId, recovered.waitId);
});

test('восстановление: решённое ожидание не открывается заново', decisionTest, async (t) => {
  const { core, repo } = makeCore(t, defaultFake());
  const waiting = saveRun(core.kernel.store, repo, {
    status: 'stopped',
    next: 'limit',
    gates: [{ gate: 'limit', decision: 'cancel', at: '2026-01-01T00:00:00Z' }],
  });

  await core.recover();

  const recovered = (await core.getRun(waiting.id))!;
  assert.ok(recovered.waitId);
  assert.equal(recovered.waitDecided, true);
  assert.deepEqual(await core.decideExpected(waiting.id, recovered.waitId!, { action: 'approve' }), {
    ok: false,
    conflict: true,
  });
  assert.equal((await core.getRun(waiting.id))?.gates.length, 1);
});

test('восстановление: недопущенное ожидание не трогается', decisionTest, async (t) => {
  const { core, repo, options } = makeCore(t, defaultFake(), { allowProject: () => false });
  const waiting = saveRun(core.kernel.store, repo, { status: 'waiting', next: 'gate1' });
  const file = backupFile(options, waiting.id);
  const before = fs.readFileSync(file);

  await core.recover();

  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal((await core.getRun(waiting.id))?.waitId, undefined);
});

test('восстановление: ожидание, возвращённое после cancel, остаётся нерешённым', decisionTest, async (t) => {
  const { core, repo } = makeCore(t, defaultFake());
  const waiting = saveRun(core.kernel.store, repo, {
    status: 'waiting',
    next: 'gate1',
    attempts: [{ stage: 'gate1', attempt: 1, startedAt: '2026-01-01T00:00:00Z', status: 'running' }],
    gates: [{ gate: 'gate1', decision: 'cancel', at: '2026-01-01T00:00:00Z' }],
  });

  await core.recover();

  const recovered = (await core.getRun(waiting.id))!;
  assert.ok(recovered.waitId);
  assert.equal(recovered.waitDecided, undefined);
  core.kernel.engine.drive = async () => {};
  assert.deepEqual(await core.decideExpected(waiting.id, recovered.waitId!, { action: 'approve' }), { ok: true });
});

test('восстановление: после начала остановки backfill не пишет', decisionTest, async (t) => {
  const { core, repo, options } = makeCore(t, defaultFake());
  const waiting = saveRun(core.kernel.store, repo, { status: 'waiting', next: 'gate1' });
  const file = backupFile(options, waiting.id);
  const before = fs.readFileSync(file);
  core.kernel.pumping = true;
  core.kernel.closing = true;

  await core.recover();

  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal((await core.getRun(waiting.id))?.waitId, undefined);
});

test('восстановление: остановленный limit без cancel остаётся нерешённым', decisionTest, async (t) => {
  const { core, repo } = makeCore(t, defaultFake());
  const waiting = saveRun(core.kernel.store, repo, { status: 'stopped', next: 'limit' });

  await core.recover();

  const recovered = (await core.getRun(waiting.id))!;
  assert.ok(recovered.waitId);
  assert.equal(recovered.waitDecided, undefined);
  core.kernel.engine.drive = async () => {};
  assert.deepEqual(await core.decideExpected(waiting.id, recovered.waitId!, { action: 'approve' }), { ok: true });
});

test('восстановление: нерешённое ожидание без попытки остаётся нерешённым', decisionTest, async (t) => {
  const { core, repo } = makeCore(t, defaultFake());
  const waiting = saveRun(core.kernel.store, repo, { status: 'stopped', next: 'gate1' });

  await core.recover();

  const recovered = (await core.getRun(waiting.id))!;
  assert.ok(recovered.waitId);
  assert.equal(recovered.waitDecided, undefined);
  core.kernel.engine.drive = async () => {};
  assert.deepEqual(await core.decideExpected(waiting.id, recovered.waitId!, { action: 'approve' }), { ok: true });
});

test('решение: новая попытка ожидания не наследует решённость', decisionTest, async (t) => {
  const { core, repo } = makeCore(t, defaultFake());
  const { runId } = await startToGate(core, repo);
  await toLimit(core, runId);
  assert.deepEqual(await core.decideExpected(runId, 'L', { action: 'cancel' }), { ok: true });
  const saves: RunFile[] = [];
  const save = core.kernel.save.bind(core.kernel);
  core.kernel.save = (current) => {
    saves.push(structuredClone(current));
    save(current);
  };

  await core.dispatch({ type: 'run.resume', runId });

  assert.ok(saves[0].attempts.some((attempt) => attempt.stage === 'limit' && attempt.status === 'running'));
  assert.ok(saves[0].waitId);
  assert.notEqual(saves[0].waitId, 'L');
  assert.equal(saves[0].waitDecided, undefined);
});

test('остановка службы: автопилот и решение в очереди', decisionTest, async (t) => {
  const { core, repo } = makeCore(t, defaultFake());
  const { runId, run: waiting } = await startToGate(core, repo);
  let release = () => {};
  let entered = () => {};
  const lockEntered = new Promise<void>((resolve) => (entered = resolve));
  const holding = core.kernel.withRunLock(runId, async () => {
    entered();
    await new Promise<void>((resolve) => (release = resolve));
  });
  await lockEntered;
  const automatic = autoDecide(core.kernel, runId, 'gate1', waiting.waitId, 'Автопилот не смог принять план');
  const decision = core.decideExpected(runId, waiting.waitId!, { action: 'approve' });
  await sleep(1000);

  const stopping = core.shutdown();
  release();

  await assert.rejects(decision, /Служба останавливается/);
  await automatic;
  await holding;
  await stopping;
  assert.equal((await core.getRun(runId))?.gates.length, 0);
  await assert.rejects(core.decideExpected(runId, waiting.waitId!, { action: 'approve' }), /Служба останавливается/);
});

test('остановка службы во время решения', decisionTest, async (t) => {
  const { core, repo, options } = makeCore(t, defaultFake());
  const waiting = saveRun(core.kernel.store, repo, {
    status: 'waiting',
    next: 'limit',
    waitId: 'L',
    attempts: [{ stage: 'limit', attempt: 1, startedAt: '2026-01-01T00:00:00Z', status: 'running' }],
  });
  const file = backupFile(options, waiting.id);
  const before = fs.readFileSync(file);
  const child = run('sh', ['-c', 'trap "" TERM; sleep 30'], { group: waiting.id, cwd: repo, env: process.env });

  const decision = core.decideExpected(waiting.id, 'L', { action: 'cancel' });
  await sleep(200);
  const stopping = core.shutdown();

  await assert.rejects(decision, /Служба останавливается/);
  await stopping;
  await child;
  assert.deepEqual(fs.readFileSync(file), before);
  const saved = await core.getRun(waiting.id);
  assert.equal(saved?.status, 'waiting');
  assert.equal(saved?.gates.length, 0);
});
