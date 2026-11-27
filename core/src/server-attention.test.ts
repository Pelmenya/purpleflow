import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyUsage } from './agents/common.js';
import { Orchestrator } from './orchestrator.js';
import { attentionIntent, type AttentionIntent } from './server/attention.js';
import { makeRepo, serverTestsSkip, startTestHost, waitingRunFixture } from './server-testkit.test.js';
import type { CoreSettings, RunFile } from './types.js';

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
const unix = { skip: process.platform === 'win32', timeout: 60_000 };

function setup(t: { after: (fn: () => void | Promise<void>) => void }, keepFailedStart: boolean) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-attention-')));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho "claude 1.0.0"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'opencode'), '#!/bin/sh\necho "1.0.0"\n', { mode: 0o755 });
  fs.writeFileSync(
    path.join(bin, 'openspec'),
    `#!/bin/sh
[ "$1" = "--version" ] && echo 1.0.0 && exit 0
if [ "$1" = "init" ]; then
  sleep "\${INIT_SLEEP:-0}"
  if [ "\${INIT_FAIL:-0}" = "1" ]; then
    echo "сбой init" >&2
    exit 1
  fi
  mkdir -p openspec/changes
fi
exit 0
`,
    { mode: 0o755 },
  );
  const settings = {
    toolPaths: { claude: path.join(bin, 'claude'), opencode: path.join(bin, 'opencode'), openspec: path.join(bin, 'openspec') },
    proxy: { baseUrl: '', apiKey: '' },
    models: { planner: '', executor: '', reviewer: '' },
    agents: { planner: 'claude', executor: 'claude', reviewer: 'claude' },
    agentTimeoutMin: 1,
    testTimeoutMin: 1,
    maxParallel: 2,
  } as unknown as CoreSettings;
  const env: NodeJS.ProcessEnv = { ...process.env };
  const core = new Orchestrator({
    dataDir: path.join(root, 'data'),
    promptsDir: PROMPTS,
    env,
    getSettings: () => settings,
    keepFailedStart,
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return { core, k: core.kernel, repo, env };
}

function start(core: Orchestrator, projectPath: string, task = 'Задача') {
  return core.dispatch({
    type: 'run.start',
    input: { projectPath, task, testCommand: 'true', mode: 'task', workspace: 'worktree' },
  });
}

function runFixture(partial: Partial<RunFile> = {}): RunFile {
  const at = new Date().toISOString();
  return {
    version: 2,
    id: 'run',
    changeId: 'change',
    title: 'Задача',
    task: 'Сделай задачу',
    projectPath: '/project',
    worktreePath: '/worktree',
    branch: 'purpleflow/change',
    baseCommit: 'base',
    testCommand: 'npm test',
    mode: 'task',
    workspace: 'worktree',
    models: { planner: '', executor: '', reviewer: '' },
    agents: { planner: 'claude', executor: 'claude', reviewer: 'claude' },
    status: 'waiting',
    next: 'gate1',
    waitId: 'w',
    attempts: [],
    planRetries: 0,
    implAttemptsUsed: 0,
    implAttemptsLimit: 3,
    tests: [],
    reviews: [],
    gates: [],
    totals: emptyUsage(),
    createdAt: at,
    updatedAt: at,
    ...partial,
  };
}

test('intent: ожидание и остановка из полей прогона', () => {
  for (const next of ['gate0', 'gate1', 'gate2'] as const) {
    assert.deepEqual(attentionIntent(runFixture({ next })), {
      key: 'wait:run:w',
      runId: 'run',
      kind: 'wait',
      reasonCode: next,
    });
  }
  assert.equal(attentionIntent(runFixture({ next: 'limit', stuck: { items: [] } }))?.reasonCode, 'limit_loop');
  assert.equal(attentionIntent(runFixture({ next: 'limit' }))?.reasonCode, 'limit_attempts');
  assert.equal(attentionIntent(runFixture({ waitDecided: true })), null);
  assert.equal(attentionIntent(runFixture({ autopilot: true })), null);
  assert.equal(attentionIntent(runFixture({ waitId: undefined })), null);

  assert.deepEqual(
    attentionIntent(
      runFixture({
        status: 'stopped',
        stop: { reason: 'checks_red', id: 's', at: new Date().toISOString() },
      }),
    ),
    { key: 'stopped:run:s', runId: 'run', kind: 'stopped', reasonCode: 'checks_red' },
  );
  for (const reason of ['stage_failed', 'start_failed', 'plan_invalid', 'no_checks', 'checks_red'] as const) {
    assert.equal(attentionIntent(runFixture({ status: 'stopped', stop: { reason, id: 's', at: 'now' } }))?.kind, 'stopped');
  }
  for (const reason of ['user_stop', 'paused', 'unqueued', 'limit_stop'] as const) {
    assert.equal(attentionIntent(runFixture({ status: 'stopped', stop: { reason, id: 's', at: 'now' } })), null);
  }
  assert.equal(attentionIntent(runFixture({ status: 'stopped', stop: undefined })), null);
  assert.equal(attentionIntent(runFixture({ status: 'finished' })), null);
  assert.equal(attentionIntent(runFixture({ status: 'cancelled' })), null);
});

test('старт: неудачная подготовка с keepFailedStart — прогон остановлен с причиной и журналом', unix, async (t) => {
  const { core, k, repo, env } = setup(t, true);
  env.INIT_FAIL = '1';
  const { runId } = await start(core, repo);
  const run = k.mustLoad(runId);
  assert.equal(run.status, 'stopped');
  assert.equal(run.stop?.reason, 'start_failed');
  assert.match(run.message ?? '', /Не удалось начать прогон/);
  assert.deepEqual(attentionIntent(run), {
    key: `stopped:${runId}:${run.stop?.id}`,
    runId,
    kind: 'stopped',
    reasonCode: 'start_failed',
  });
  assert.match(k.store.readLog(runId), /Не удалось начать прогон/);

  await assert.rejects(start(core, repo, '   '), /Опишите задачу/);
  assert.equal((await core.listRuns()).length, 1);
});

test('старт: без keepFailedStart неудачная подготовка удаляет запись', unix, async (t) => {
  const { core, repo, env } = setup(t, false);
  env.INIT_FAIL = '1';
  await assert.rejects(start(core, repo));
  assert.deepEqual(await core.listRuns(), []);
  await assert.rejects(start(core, repo, '   '), /Опишите задачу/);
  assert.deepEqual(await core.listRuns(), []);
});

test('старт: ручная остановка во время подготовки с keepFailedStart по-прежнему user_stop', unix, async (t) => {
  const { core, k, repo, env } = setup(t, true);
  env.INIT_SLEEP = '3';
  const pending = start(core, repo);
  for (let i = 0; i < 500 && !k.preparing.size; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  const [runId] = k.preparing;
  assert.ok(runId);
  await core.dispatch({ type: 'run.stop', runId });
  await pending;
  const run = k.mustLoad(runId);
  assert.equal(run.status, 'stopped');
  assert.equal(run.message, 'Остановлено пользователем');
  assert.equal(run.stop?.reason, 'user_stop');
  assert.equal(attentionIntent(run), null);
});

test('хост: intent неудачного старта и ожидания, чужой проект скрыт', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-attention-host-')));
  const claude = path.join(root, 'claude');
  const openspec = path.join(root, 'openspec');
  fs.writeFileSync(claude, '#!/bin/sh\necho "claude 1.0.0"\n', { mode: 0o755 });
  fs.writeFileSync(
    openspec,
    '#!/bin/sh\n[ "$1" = "--version" ] && echo 1.0.0 && exit 0\n[ "$1" = "init" ] && echo "сбой init" >&2 && exit 1\nexit 0\n',
    { mode: 0o755 },
  );
  const fixture = await startTestHost({ settings: { toolPaths: { claude, openspec } } as CoreSettings });
  const foreignPath = makeRepo();
  t.after(async () => {
    await fixture.close();
    for (const dir of [root, fixture.dataDir, fixture.project.path, foreignPath]) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  const events: { runId: string; intent: AttentionIntent | null }[] = [];
  const unsubscribe = fixture.host.onIntentChange((runId, intent) => events.push({ runId, intent }));

  const started = await fixture.host.startTask('p1', { task: 'Задача', submissionId: crypto.randomUUID() });
  assert.equal(started.status, 'started');
  const failedId = started.status === 'started' ? started.runId : '';
  const failed = await fixture.host.readRun(failedId);
  assert.equal(failed?.stop?.reason, 'start_failed');
  assert.deepEqual(fixture.host.intents(), [
    { key: `stopped:${failedId}:${failed?.stop?.id}`, runId: failedId, kind: 'stopped', reasonCode: 'start_failed' },
  ]);
  assert.equal(events.filter(({ intent }) => intent?.kind === 'stopped').length, 1);

  const foreign = waitingRunFixture(fixture.dataDir, foreignPath, { next: 'gate1', waitId: 'foreign-wait' });
  fixture.core.kernel.save(foreign);
  fixture.core.kernel.save({
    ...foreign,
    status: 'stopped',
    stop: { reason: 'checks_red', id: 'foreign-stop', at: new Date().toISOString() },
  });
  assert.equal(
    fixture.host.intents().some(({ runId }) => runId === foreign.id),
    false,
  );
  assert.equal(
    events.some(({ runId }) => runId === foreign.id),
    false,
  );

  const own = waitingRunFixture(fixture.dataDir, fixture.project.path, { next: 'gate1', waitId: 'own-wait' });
  fixture.core.kernel.save(own);
  fixture.core.kernel.save(own);
  assert.equal(events.filter(({ runId }) => runId === own.id).length, 1);
  assert.equal(events.at(-1)?.intent?.key, `wait:${own.id}:own-wait`);
  fixture.core.kernel.save({ ...own, waitId: 'new-wait' });
  assert.equal(events.filter(({ runId }) => runId === own.id).length, 2);
  assert.equal(events.at(-1)?.intent?.key, `wait:${own.id}:new-wait`);
  fixture.core.kernel.save({ ...own, waitId: 'new-wait', waitDecided: true });
  assert.deepEqual(events.at(-1), { runId: own.id, intent: null });

  unsubscribe();
  unsubscribe();
  fixture.core.kernel.save({ ...own, waitId: 'after-unsubscribe' });
  assert.equal(events.filter(({ runId }) => runId === own.id).length, 3);
});

test(
  'хост: intents загружает полные записи только для своих ожидающих и остановленных прогонов',
  { skip: serverTestsSkip, timeout: 60_000 },
  async (t) => {
    const fixture = await startTestHost();
    const foreignPath = makeRepo();
    t.after(async () => {
      await fixture.close();
      for (const dir of [fixture.dataDir, fixture.project.path, foreignPath]) {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    });
    waitingRunFixture(fixture.dataDir, fixture.project.path, { next: 'gate1', status: 'running' });
    const waiting = waitingRunFixture(fixture.dataDir, fixture.project.path, { next: 'gate1', waitId: 'host-wait' });
    const stopped = waitingRunFixture(fixture.dataDir, fixture.project.path, {
      next: 'gate1',
      status: 'stopped',
      stop: { reason: 'checks_red', id: 'host-stop', at: new Date().toISOString() },
    });
    const silentlyStopped = waitingRunFixture(fixture.dataDir, fixture.project.path, {
      next: 'gate1',
      status: 'stopped',
      stop: { reason: 'user_stop', id: 'host-user-stop', at: new Date().toISOString() },
    });
    waitingRunFixture(fixture.dataDir, fixture.project.path, { next: 'gate1', status: 'cancelled' });
    waitingRunFixture(fixture.dataDir, fixture.project.path, { next: 'gate1', status: 'finished' });
    waitingRunFixture(fixture.dataDir, foreignPath, { next: 'gate1', waitId: 'foreign-wait' });
    waitingRunFixture(fixture.dataDir, foreignPath, {
      next: 'gate1',
      status: 'stopped',
      stop: { reason: 'checks_red', id: 'foreign-stop', at: new Date().toISOString() },
    });
    const missing = waitingRunFixture(fixture.dataDir, fixture.project.path, { next: 'gate1', workspacePending: true });
    fs.rmSync(path.join(fixture.dataDir, 'runs', `${missing.id}.json`));

    const store = fixture.core.kernel.store;
    const load = store.load.bind(store);
    const loaded: string[] = [];
    t.mock.method(store, 'load', (id: string) => {
      loaded.push(id);
      return load(id);
    });

    const intents = fixture.host.intents();
    assert.deepEqual(loaded.sort(), [waiting.id, stopped.id, silentlyStopped.id].sort());
    assert.deepEqual(
      intents.map((intent) => intent.key).sort(),
      [`wait:${waiting.id}:host-wait`, `stopped:${stopped.id}:host-stop`].sort(),
    );
  },
);
