import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyUsage, type AgentResult, type AgentRunOptions } from './agents/common.js';
import { Orchestrator } from './orchestrator.js';
import type { CoreEvent, CoreSettings, RunFile } from './types.js';

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
const unix = { skip: process.platform === 'win32', timeout: 60_000 };
const okReply = (text = '{}'): AgentResult => ({ ok: true, text, usage: emptyUsage() });
type Claude = (o: AgentRunOptions) => Promise<AgentResult> | AgentResult;

function setup(t: { after: (fn: () => void) => void }, claude: Claude = () => okReply(), maxParallel = 2) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-stop-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const at =
    (cwd: string) =>
    (...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'pipe' })
        .toString()
        .trim();
  const g = at(repo);
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho "claude 1.0.0"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'opencode'), '#!/bin/sh\necho "1.0.0"\n', { mode: 0o755 });
  const calls = path.join(root, 'openspec-calls');
  fs.writeFileSync(
    path.join(bin, 'openspec'),
    `#!/bin/sh\n[ "$1" = "--version" ] && echo 1.0.0 && exit 0\necho "$*" >> "${calls}"\n[ "$1" = "init" ] && sleep "\${INIT_SLEEP:-0}" && mkdir -p openspec/changes\nexit 0\n`,
    { mode: 0o755 },
  );
  const settings = {
    toolPaths: { claude: path.join(bin, 'claude'), opencode: path.join(bin, 'opencode'), openspec: path.join(bin, 'openspec') },
    proxy: { baseUrl: '', apiKey: '' },
    models: { planner: '', executor: '', reviewer: '' },
    agents: { planner: 'claude', executor: 'claude', reviewer: 'claude' },
    agentTimeoutMin: 1,
    testTimeoutMin: 1,
    maxParallel,
  } as unknown as CoreSettings;
  const env: NodeJS.ProcessEnv = { ...process.env };
  const core = new Orchestrator({
    dataDir: path.join(root, 'data'),
    promptsDir: PROMPTS,
    env,
    getSettings: () => settings,
    runners: { claude: (async (o: AgentRunOptions) => claude(o)) as never, opencode: (async (o: AgentRunOptions) => claude(o)) as never },
  });
  const k = core.kernel;
  const head = g('rev-parse', 'HEAD');
  const save = (over: Partial<RunFile> = {}) => {
    const run = {
      id: `run-${Math.random().toString(36).slice(2, 10)}`,
      title: 'Задача',
      task: 'Сделай',
      changeId: 'c',
      mode: 'quick',
      status: 'running',
      next: 'implement',
      workspace: 'worktree',
      visual: false,
      projectPath: repo,
      worktreePath: repo,
      branch: 'main',
      baseCommit: head,
      agents: { planner: 'claude', executor: 'claude', reviewer: 'claude' },
      models: {},
      attempts: [],
      tests: [],
      reviews: [],
      gates: [],
      implAttemptsUsed: 1,
      implAttemptsLimit: 3,
      totals: emptyUsage(),
      createdAt: '2026-01-01T00:00:00Z',
      ...over,
    } as unknown as RunFile;
    k.store.save(run);
    return run;
  };
  const until = async (id: string, ok: (r: RunFile) => boolean) => {
    for (let i = 0; i < 400; i++) {
      const r = k.store.load(id);
      if (r && ok(r)) return r;
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error(`не дождались: ${JSON.stringify({ s: k.store.load(id)?.status, m: k.store.load(id)?.message })}`);
  };
  return { core, k, g, save, until };
}

test('остановка: markStopped и fail записывают причину', unix, (t) => {
  const { k, save } = setup(t);
  const run = save();

  k.markStopped(run, 'x', 'checks_red');
  let saved = k.mustLoad(run.id);
  assert.equal(saved.stop?.reason, 'checks_red');
  assert.match(saved.stop!.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.ok(!Number.isNaN(Date.parse(saved.stop!.at)));
  assert.equal(new Date(saved.stop!.at).toISOString(), saved.stop!.at);
  const firstId = saved.stop!.id;

  k.markStopped(run, 'x', 'checks_red');
  saved = k.mustLoad(run.id);
  assert.notEqual(saved.stop!.id, firstId);
  const secondId = saved.stop!.id;

  k.save(run);
  assert.equal(k.mustLoad(run.id).stop!.id, secondId);

  k.markStopped(run, 'x');
  assert.equal(k.mustLoad(run.id).stop?.reason, 'user_stop');

  k.fail(run, 'e');
  assert.equal(k.mustLoad(run.id).stop?.reason, 'stage_failed');
});

test('остановка: во время остановки службы ничего не пишется', unix, (t) => {
  const { k, save } = setup(t);
  const run = save();
  const file = path.join(k.opts.dataDir, 'runs', `${run.id}.json`);
  const before = fs.readFileSync(file);
  k.closing = true;

  k.markStopped(run, 'x');
  k.fail(run, 'e');

  assert.deepEqual(fs.readFileSync(file), before);
});

test('запуск из очереди с ошибкой — start_failed', unix, async (t) => {
  const { core, g, save, until } = setup(t);
  g('branch', 'purpleflow/x');
  const run = save({ status: 'queued', workspace: 'branch', branch: 'purpleflow/x', next: 'implement' });

  await core.settingsChanged();

  const stopped = await until(run.id, (r) => r.status === 'stopped');
  assert.equal(stopped.stop?.reason, 'start_failed');
});

test('снятие с очереди перезаписывает устаревшую причину', unix, async (t) => {
  const { core, k, save } = setup(t);
  const run = save({ status: 'queued', stop: { reason: 'stage_failed', at: '2026-01-01T00:00:00.000Z', id: 'old' } });

  await core.dispatch({ type: 'run.stop', runId: run.id });

  const stopped = k.mustLoad(run.id);
  assert.equal(stopped.stop?.reason, 'unqueued');
  assert.notEqual(stopped.stop?.id, 'old');
});

test('«Стоп» неактивного running — user_stop', unix, async (t) => {
  const { core, k, save } = setup(t);
  const run = save({ status: 'running' });

  await core.dispatch({ type: 'run.stop', runId: run.id });

  assert.equal(k.mustLoad(run.id).stop?.reason, 'user_stop');
});

test('отмена на limit — limit_stop', unix, async (t) => {
  const { core, k, save } = setup(t);
  const run = save({ status: 'waiting', next: 'limit' });

  await core.dispatch({ type: 'gate.cancel', runId: run.id });

  assert.equal(k.mustLoad(run.id).stop?.reason, 'limit_stop');
});

test('восстановление после отмены снимает причину', unix, async (t) => {
  const { core, k, save } = setup(t);
  const run = save({
    status: 'cancelled',
    next: 'gate2',
    stop: { reason: 'stage_failed', at: '2026-01-01T00:00:00.000Z', id: 'old' },
  });

  await core.dispatch({ type: 'run.restore', runId: run.id });

  assert.equal(k.mustLoad(run.id).stop, undefined);
});

test('stash не вернулся при восстановлении — stage_failed без run.finished', unix, async (t) => {
  const { core, k, save } = setup(t);
  const run = save({ baseProbeStash: '0'.repeat(40) });
  const events: CoreEvent[] = [];
  core.on((event) => events.push(event));
  k.pumping = true;

  await core.recover();

  assert.equal(k.mustLoad(run.id).stop?.reason, 'stage_failed');
  assert.equal(
    events.some((event) => event.type === 'run.finished' && event.runId === run.id),
    false,
  );
});

function stopWritesWithoutRecord(source: string): number[] {
  const lines = source.split('\n');
  const missing: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const status = lines[i].match(/\b([A-Za-z_$][\w$]*)\.status\s*=\s*(['"])stopped\2/);
    if (!status) continue;
    const object = status[1];
    const nextStatus = new RegExp(`\\b${object}\\.status\\s*=`);
    const stop = new RegExp(`\\b${object}\\.stop\\s*=`);
    let recorded = false;
    for (let j = i + 1; j < Math.min(lines.length, i + 10); j++) {
      if (stop.test(lines[j])) {
        recorded = true;
        break;
      }
      if (nextStatus.test(lines[j]) || /\bsave\s*\(/.test(lines[j])) break;
    }
    if (!recorded) missing.push(i + 1);
  }
  return missing;
}

test('барьер: отрицательные образцы записей stopped', () => {
  assert.deepEqual(stopWritesWithoutRecord("r.status = 'stopped';\nr.message = 'x';\nk.save(r);"), [1]);
  assert.deepEqual(stopWritesWithoutRecord("r.status = 'stopped';\nr.stop = stopRecord('user_stop');\nk.save(r);"), []);
  assert.deepEqual(
    stopWritesWithoutRecord("r.status = 'stopped';\nr.stop = stopRecord('stage_failed');\nr.status = 'stopped';\nk.save(r);"),
    [3],
  );
  assert.deepEqual(stopWritesWithoutRecord('r.stop = stopRecord(\'user_stop\');\nr.status = "stopped";\nk.save(r);'), [2]);
});

test('барьер: каждая запись stopped несёт причину', () => {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const sourceFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(file);
      return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [file] : [];
    });
  const missing = sourceFiles(root).flatMap((file) =>
    stopWritesWithoutRecord(fs.readFileSync(file, 'utf8')).map((line) => `${path.relative(root, file)}:${line}`),
  );
  assert.deepEqual(missing, []);
});
