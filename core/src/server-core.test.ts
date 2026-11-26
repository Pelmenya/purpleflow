import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyUsage, type AgentResult, type AgentRunOptions } from './agents/common.js';
import { Orchestrator } from './orchestrator.js';
import { killAll } from './proc.js';
import type { CoreSettings, RunFile } from './types.js';

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
const unix = { skip: process.platform === 'win32', timeout: 60_000 };
const okReply = (text = '{}'): AgentResult => ({ ok: true, text, usage: emptyUsage() });
type Claude = (o: AgentRunOptions) => Promise<AgentResult> | AgentResult;

function setup(
  t: { after: (fn: () => void | Promise<void>) => void },
  claude: Claude = () => okReply(),
  options: { maxParallel?: number; allowProject?: (projectPath: string) => boolean } = {},
) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-server-core-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  t.after(killAll);
  const at =
    (cwd: string) =>
    (...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'pipe' })
        .toString()
        .trim();
  const makeRepo = (name: string) => {
    const repo = path.join(root, name);
    fs.mkdirSync(repo);
    const g = at(repo);
    g('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), `${name}\n`);
    g('add', '-A');
    g('commit', '-qm', 'init');
    return { repo, head: g('rev-parse', 'HEAD') };
  };
  const a = makeRepo('a');
  const b = makeRepo('b');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const cliCalls = path.join(root, 'cli-calls');
  for (const name of ['claude', 'opencode', 'openspec']) {
    const body = name === 'openspec' ? `[ "$1" = "init" ] && mkdir -p openspec/changes\nexit 0\n` : 'exit 0\n';
    fs.writeFileSync(
      path.join(bin, name),
      `#!/bin/sh\necho "${name} $*" >> "${cliCalls}"\n[ "$1" = "--version" ] && echo "1.0.0" && exit 0\n${body}`,
      { mode: 0o755 },
    );
  }
  let settingsReads = 0;
  const settings = {
    toolPaths: { claude: path.join(bin, 'claude'), opencode: path.join(bin, 'opencode'), openspec: path.join(bin, 'openspec') },
    enabledAgents: ['claude'],
    proxy: { baseUrl: '', apiKey: '' },
    models: { planner: '', executor: '', reviewer: '' },
    agents: { planner: 'claude', executor: 'claude', reviewer: 'claude' },
    agentTimeoutMin: 1,
    testTimeoutMin: 1,
    maxParallel: options.maxParallel ?? 2,
  } as unknown as CoreSettings;
  const env = { ...process.env };
  const core = new Orchestrator({
    dataDir: path.join(root, 'data'),
    promptsDir: PROMPTS,
    env,
    getSettings: () => {
      settingsReads++;
      return settings;
    },
    runners: { claude: (async (o: AgentRunOptions) => claude(o)) as never },
    allowProject: options.allowProject,
  });
  const k = core.kernel;
  const save = (project: { repo: string; head: string }, over: Partial<RunFile> = {}) => {
    const run = {
      version: 2,
      id: `run-${Math.random().toString(36).slice(2, 10)}`,
      title: 'Задача',
      task: 'Сделай',
      changeId: `c-${Math.random().toString(36).slice(2, 8)}`,
      mode: 'quick',
      status: 'running',
      next: 'implement',
      workspace: 'worktree',
      projectPath: project.repo,
      worktreePath: project.repo,
      branch: 'main',
      baseCommit: project.head,
      agents: { planner: 'claude', executor: 'claude', reviewer: 'claude' },
      models: {},
      attempts: [],
      tests: [],
      reviews: [],
      gates: [],
      implAttemptsUsed: 1,
      implAttemptsLimit: 3,
      totals: emptyUsage(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...over,
    } as RunFile;
    k.store.save(run);
    return run;
  };
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 400; i++) {
      if (ok()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail('не дождались состояния');
  };
  return {
    core,
    k,
    a,
    b,
    root,
    bin,
    settings,
    env,
    save,
    until,
    settingsReads: () => settingsReads,
    cliCalls: () => (fs.existsSync(cliCalls) ? fs.readFileSync(cliCalls, 'utf8') : ''),
  };
}

function backup(k: Orchestrator['kernel'], id: string): string {
  return fs.readFileSync(path.join(k.opts.dataDir, 'runs', `${id}.json`), 'utf8');
}

test('допуск проектов: недопущенный прогон не восстанавливается и не запускается', unix, async (t) => {
  const seen: string[] = [];
  const { core, k, a, b, save, until } = setup(
    t,
    (o) => {
      seen.push(o.cwd);
      return okReply('Готово');
    },
    { allowProject: (projectPath) => projectPath === a.repo },
  );
  const allowed = save(a);
  const denied = save(b);
  const children = [spawn('sleep', ['30'], { stdio: 'ignore' }), spawn('sleep', ['30'], { stdio: 'ignore' })];
  t.after(() => children.forEach((child) => child.kill('SIGKILL')));
  k.store.writePids(denied.id, [children[0].pid!]);
  k.store.writePids(`${denied.id}:manager`, [children[1].pid!]);
  const before = backup(k, denied.id);

  await core.recover();
  await until(() => seen.length === 1 && k.mustLoad(allowed.id).status === 'waiting');

  assert.deepEqual(seen, [a.repo]);
  assert.equal(k.mustLoad(denied.id).status, 'running');
  assert.equal(backup(k, denied.id), before);
  assert.deepEqual(k.store.readPids(denied.id), [children[0].pid]);
  assert.deepEqual(k.store.readPids(`${denied.id}:manager`), [children[1].pid]);
  assert.equal(
    children.every((child) => child.exitCode === null && child.signalCode === null),
    true,
  );
});

test('допуск проектов: чужой running не занимает место в очереди', unix, async (t) => {
  const seen: string[] = [];
  const { core, k, a, b, save, until } = setup(
    t,
    (o) => {
      seen.push(o.cwd);
      return okReply('Готово');
    },
    { maxParallel: 1, allowProject: (projectPath) => projectPath === a.repo },
  );
  save(b);
  const allowed = save(a, { status: 'queued' });

  await core.recover();
  await until(() => seen.length === 1 && k.mustLoad(allowed.id).status === 'waiting');

  assert.deepEqual(seen, [a.repo]);
});

test('допуск проектов: недопущенный queued не берётся из очереди', unix, async (t) => {
  const seen: string[] = [];
  const { core, k, b, save } = setup(
    t,
    (o) => {
      seen.push(o.cwd);
      return okReply();
    },
    { allowProject: () => false },
  );
  const denied = save(b, { status: 'queued' });
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  k.store.writePids(denied.id, [child.pid!]);
  const before = backup(k, denied.id);
  const index = path.join(k.opts.dataDir, 'runs.json');
  const indexBefore = fs.readFileSync(index, 'utf8');

  await core.recover();
  core.settingsChanged();
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(k.mustLoad(denied.id).status, 'queued');
  assert.equal(backup(k, denied.id), before);
  assert.equal(fs.readFileSync(index, 'utf8'), indexBefore);
  assert.deepEqual(k.store.readPids(denied.id), [child.pid]);
  assert.deepEqual(seen, []);
});

test('допуск проектов: run.start недопущенного проекта отклонён первой строкой', unix, async (t) => {
  const seen: AgentRunOptions[] = [];
  const { core, k, b, settingsReads, cliCalls } = setup(
    t,
    (o) => {
      seen.push(o);
      return okReply();
    },
    { allowProject: () => false },
  );

  await assert.rejects(
    core.dispatch({
      type: 'run.start',
      input: {
        projectPath: b.repo,
        task: 'Задача',
        testCommand: 'true',
        mode: 'quick',
        attachments: [{ name: 'note.txt', data: new TextEncoder().encode('secret') }],
      },
    }),
    /Проект не допущен службой/,
  );

  assert.deepEqual(await core.listRuns(), []);
  assert.equal(fs.existsSync(path.join(k.opts.dataDir, 'attachments')), false);
  assert.deepEqual(seen, []);
  assert.equal(settingsReads(), 0);
  assert.equal(cliCalls(), '');
});

test('допуск проектов: без предиката поведение прежнее', unix, async (t) => {
  const seen: string[] = [];
  const { core, k, a, save, until } = setup(t, (o) => {
    seen.push(o.cwd);
    return okReply('Готово');
  });
  const run = save(a);

  await core.recover();
  await until(() => seen.length === 1 && k.mustLoad(run.id).status === 'waiting');

  assert.equal(k.mustLoad(run.id).status, 'waiting');
  assert.deepEqual(seen, [a.repo]);
});
