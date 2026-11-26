import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyUsage, type AgentResult, type AgentRunOptions } from './agents/common.js';
import { opencodeMajor } from './agents/opencode.js';
import { ShuttingDownError } from './kernel.js';
import { Orchestrator } from './orchestrator.js';
import { killAll, run as runProc, spawnScope } from './proc.js';
import { listAgyModels, listOpencodeModels } from './services/connection.js';
import type { CoreEvent, CoreSettings, RunFile } from './types.js';

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
  const makeCore = () =>
    new Orchestrator({
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
  const core = makeCore();
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
    makeCore,
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

test('остановка службы: активный прогон восстанавливается, очередь не запускается', unix, async (t) => {
  let calls = 0;
  let started = () => {};
  const agentStarted = new Promise<void>((resolve) => (started = resolve));
  const { core, makeCore, k, a, b, until } = setup(
    t,
    async (o) => {
      calls++;
      if (calls > 1) return okReply('Готово');
      started();
      const result = await runProc('sleep', ['30'], { cwd: o.cwd, env: process.env, group: o.group });
      return { ok: false, stopped: result.killed, text: '', usage: emptyUsage() };
    },
    { maxParallel: 1 },
  );
  const first = await core.dispatch({
    type: 'run.start',
    input: { projectPath: a.repo, task: 'A', testCommand: '', mode: 'quick' },
  });
  await agentStarted;
  const second = await core.dispatch({
    type: 'run.start',
    input: { projectPath: b.repo, task: 'B', testCommand: '', mode: 'quick' },
  });
  const activeBefore = k.mustLoad(first.runId);
  assert.equal(activeBefore.attempts.at(-1)?.status, 'running');
  assert.equal(k.mustLoad(second.runId).status, 'queued');
  const before = backup(k, first.runId);

  await core.shutdown();

  assert.equal(calls, 1);
  assert.equal(backup(k, first.runId), before);
  assert.equal(k.mustLoad(second.runId).status, 'queued');
  await assert.rejects(core.dispatch({ type: 'run.stop', runId: first.runId }), (error: unknown) => {
    assert.ok(error instanceof ShuttingDownError);
    assert.equal(error.message, 'Служба останавливается');
    return true;
  });

  const next = makeCore();
  t.after(() => next.shutdown());
  next.kernel.pumping = true;
  await next.recover();
  const recovered = next.kernel.mustLoad(first.runId);
  assert.equal(recovered.status, 'queued');
  assert.equal(recovered.attempts.at(-1)?.status, 'stopped');
  assert.equal(recovered.implAttemptsUsed, 0);
  assert.equal(next.kernel.mustLoad(second.runId).status, 'queued');

  next.kernel.pumping = false;
  next.settingsChanged();
  await until(() => calls === 2 && next.kernel.mustLoad(first.runId).status === 'waiting');
  assert.equal(calls, 2);
});

test('остановка службы: оборванная проверка не записывается', unix, async (t) => {
  const events: CoreEvent[] = [];
  const { core, k, a, root, save, until } = setup(t);
  const marker = path.join(root, 'checks');
  const run = save(a, {
    next: 'tests',
    lintCommand: `printf 'lint\n' >> "${marker}"; sleep 30`,
    testCommand: `printf 'test\n' >> "${marker}"`,
    prepared: true,
  });
  core.on((event) => events.push(event));

  await core.recover();
  await until(() => fs.existsSync(marker));
  const before = backup(k, run.id);
  await core.shutdown();

  assert.equal(fs.readFileSync(marker, 'utf8'), 'lint\n');
  assert.equal(backup(k, run.id), before);
  assert.deepEqual(k.mustLoad(run.id).tests, []);
  assert.equal(
    events.some((event) => event.type === 'run.finished'),
    false,
  );
});

test('остановка службы: остановка стадии заморожена', unix, async (t) => {
  const events: CoreEvent[] = [];
  const { core, k, a, save } = setup(t);
  const run = save(a, { mode: 'refactor', next: 'baseline', testCommand: '', prepared: true });
  let before = '';
  core.on((event) => {
    events.push(event);
    if (event.type === 'stage.started' && event.stage === 'baseline') {
      before = backup(k, run.id);
      void core.shutdown();
    }
  });

  await core.recover();
  await core.shutdown();

  assert.equal(backup(k, run.id), before);
  assert.equal(k.mustLoad(run.id).status, 'running');
  assert.equal(
    events.some((event) => event.type === 'run.finished'),
    false,
  );
});

test('остановка службы: тот же Promise', unix, async (t) => {
  const { core } = setup(t);
  const stopping = core.shutdown();
  assert.strictEqual(core.shutdown(), stopping);
  await stopping;
});

test('остановка службы: очередь не продолжается', unix, async (t) => {
  const { core, k, a, b, save, cliCalls } = setup(t);
  const first = save(a, {
    status: 'queued',
    workspacePending: true,
    worktreePath: path.join(a.repo, 'worktree'),
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const second = save(b, {
    status: 'queued',
    workspacePending: true,
    worktreePath: path.join(b.repo, 'worktree'),
    createdAt: '2026-01-01T00:00:01.000Z',
  });
  const originalTools = k.tools.bind(k);
  let toolsCalls = 0;
  let entered = () => {};
  const waiting = new Promise<void>((resolve) => (entered = resolve));
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  k.tools = async (names) => {
    toolsCalls++;
    if (names.includes('openspec')) {
      entered();
      await gate;
    }
    return originalTools(names);
  };
  const recovering = core.recover();
  await waiting;
  const firstBefore = backup(k, first.id);
  const secondBefore = backup(k, second.id);
  const callsBefore = cliCalls();
  const stopping = core.shutdown();
  release();
  await recovering;
  await stopping;

  assert.equal(backup(k, first.id), firstBefore);
  assert.equal(backup(k, second.id), secondBefore);
  assert.equal(k.mustLoad(second.id).status, 'queued');
  assert.equal(toolsCalls, 1);
  assert.equal(cliCalls(), callsBefore);
});

test('остановка службы: принятый вызов старого ядра не запускает процесс и после нового Orchestrator', unix, async (t) => {
  const marker = path.join(os.tmpdir(), `pf-old-core-${Math.random().toString(36).slice(2)}`);
  t.after(() => fs.rmSync(marker, { force: true }));
  const { core, makeCore, k } = setup(t, async (o) => {
    if (o.group?.endsWith(':task')) {
      const result = await runProc('sh', ['-c', `printf old > "${marker}"`], {
        cwd: o.cwd,
        env: process.env,
        group: o.group,
      });
      return { ok: result.code === 0, text: result.stdout, error: result.spawnError, usage: emptyUsage() };
    }
    return okReply('Ответ');
  });
  const chat = await core.createChat({ agent: 'claude' });
  await core.sendChat(chat.id, 'Сформулируй задачу');
  for (let i = 0; i < 200 && (await core.getChat(chat.id))?.busy; i++) await new Promise((resolve) => setTimeout(resolve, 25));

  const originalTools = k.tools.bind(k);
  let entered = () => {};
  const waiting = new Promise<void>((resolve) => (entered = resolve));
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  k.tools = async (names) => {
    entered();
    await gate;
    return originalTools(names);
  };
  const pending = core.chatToTask(chat.id);
  await waiting;
  await core.shutdown();
  makeCore();
  release();

  await assert.rejects(pending, ShuttingDownError);
  assert.equal(fs.existsSync(marker), false);
});

test('остановка службы: запоздалый автопилот не трогает worktree', unix, async (t) => {
  const { core, k, a, root, save, until } = setup(t);
  const worktree = path.join(root, 'autopilot-worktree');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'purpleflow/autopilot', worktree], { cwd: a.repo });
  fs.writeFileSync(path.join(a.repo, '.env'), 'SECRET=1\n');
  const run = save(a, {
    next: 'gate1',
    autopilot: true,
    envFiles: ['.env'],
    worktreePath: worktree,
    branch: 'purpleflow/autopilot',
  });

  await core.recover();
  await until(() => k.mustLoad(run.id).status === 'waiting' && fs.existsSync(path.join(worktree, '.env')));
  fs.rmSync(path.join(worktree, '.env'));
  const before = backup(k, run.id);
  await core.shutdown();
  await new Promise((resolve) => setTimeout(resolve, 1000));

  assert.equal(fs.existsSync(path.join(worktree, '.env')), false);
  assert.equal(backup(k, run.id), before);
});

test('кэш версии opencode: отказ барьера не кэшируется', unix, async (t) => {
  const { bin } = setup(t);
  const binPath = path.join(bin, 'opencode');
  fs.writeFileSync(binPath, '#!/bin/sh\necho "2.0.0"\n', { mode: 0o755 });

  assert.equal(await spawnScope.run({ stopped: true }, () => opencodeMajor(binPath, process.env)), 1);
  assert.equal(await opencodeMajor(binPath, process.env), 2);
});

test('кэш версии opencode: убитый запрос не кэшируется', unix, async (t) => {
  const { bin, root } = setup(t);
  const binPath = path.join(bin, 'opencode');
  const started = path.join(root, 'version-started');
  fs.writeFileSync(binPath, `#!/bin/sh\nprintf started > "${started}"\nsleep 30\n`, { mode: 0o755 });
  const pending = opencodeMajor(binPath, process.env);
  for (let i = 0; i < 200 && !fs.existsSync(started); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(started));
  await killAll();
  assert.equal(await pending, 1);

  fs.writeFileSync(binPath, '#!/bin/sh\necho "2.0.0"\n', { mode: 0o755 });
  assert.equal(await opencodeMajor(binPath, process.env), 2);
});

test('кэш моделей opencode: отказ барьера не кэшируется', unix, async (t) => {
  const { k, bin, settings } = setup(t);
  const binPath = path.join(bin, 'opencode');
  fs.writeFileSync(binPath, '#!/bin/sh\n[ "$1" = "--version" ] && echo "2.0.0" && exit 0\n[ "$1" = "models" ] && echo "opencode/a"\n', {
    mode: 0o755,
  });
  settings.enabledAgents = ['opencode'];
  await k.tools(['opencode']);

  assert.deepEqual(await spawnScope.run({ stopped: true }, () => listOpencodeModels(k)), []);
  assert.deepEqual(await listOpencodeModels(k), ['opencode/a']);
});

test('кэш моделей agy: отказ барьера не кэшируется', unix, async (t) => {
  const { k, bin, settings } = setup(t);
  const binPath = path.join(bin, 'agy');
  fs.writeFileSync(
    binPath,
    '#!/bin/sh\n[ "$1" = "--version" ] && echo "1.0.0" && exit 0\n[ "$1" = "models" ] && printf "gemini-x\\tGemini X\\n"\n',
    {
      mode: 0o755,
    },
  );
  settings.enabledAgents = ['agy'];
  settings.toolPaths.agy = binPath;
  await k.tools(['agy']);

  assert.deepEqual(await spawnScope.run({ stopped: true }, () => listAgyModels(k)), []);
  assert.deepEqual(await listAgyModels(k), ['gemini-x']);
});

async function rejectsShutdown(pending: Promise<unknown>): Promise<void> {
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof ShuttingDownError);
    assert.equal(error.message, 'Служба останавливается');
    return true;
  });
}

test('остановка службы: сообщение в очереди чата не уходит агенту', unix, async (t) => {
  const gates: ((result: { stopped?: boolean }) => void)[] = [];
  let calls = 0;
  const { core, k } = setup(t, async () => {
    calls++;
    const result = await new Promise<{ stopped?: boolean }>((resolve) => gates.push(resolve));
    return { ok: !result.stopped, stopped: result.stopped, text: 'Ответ', usage: emptyUsage() };
  });
  const chat = await core.createChat({ agent: 'claude' });
  await core.sendChat(chat.id, 'Первое');
  for (let i = 0; i < 200 && gates.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(gates.length, 1);
  await core.sendChat(chat.id, 'Второе');
  const file = path.join(k.opts.dataDir, 'chats', `${chat.id}.json`);
  const before = fs.readFileSync(file, 'utf8');

  const stopping = core.shutdown();
  gates[0]({ stopped: true });
  await stopping;

  assert.equal(calls, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const saved = (await core.getChat(chat.id))!.chat;
  assert.equal(saved.messages.at(-1)?.text, 'Второе');
  assert.equal(saved.messages.at(-1)?.queued, true);
});

test('остановка службы: sendChat, compactChat, chatToTask и startPreview отклонены', unix, async (t) => {
  const { core, a, save } = setup(t);
  const chat = await core.createChat({ agent: 'claude' });
  const run = save(a, { runCommand: 'sleep 30', appUrl: 'http://127.0.0.1:43123' });
  await core.shutdown();

  await rejectsShutdown(core.sendChat(chat.id, 'Текст'));
  await rejectsShutdown(core.compactChat(chat.id));
  await rejectsShutdown(core.chatToTask(chat.id));
  await rejectsShutdown(core.allowChatMcp(chat.id, { server: 's', tool: 't' }));
  await rejectsShutdown(core.startPreview(run.id));
});

test('остановка службы: grantChatFullAccess и answerChatPermission отклонены', unix, async (t) => {
  const { core, k } = setup(t);
  const chat = await core.createChat({ agent: 'claude' });
  const file = path.join(k.opts.dataDir, 'chats', `${chat.id}.json`);
  const before = fs.readFileSync(file, 'utf8');
  await core.shutdown();

  await rejectsShutdown(core.grantChatFullAccess(chat.id));
  await rejectsShutdown(core.answerChatPermission(chat.id, 'request', 'once'));

  assert.equal(fs.existsSync(path.join(k.opts.dataDir, 'chats', chat.id, 'work')), false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('остановка службы: recover, ждущий k.tools, ничего не пишет', unix, async (t) => {
  const { core, k, a, save } = setup(t);
  const run = save(a, { baseProbeStash: 'deadbeef' });
  const originalTools = k.tools.bind(k);
  let entered = () => {};
  const waiting = new Promise<void>((resolve) => (entered = resolve));
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  k.tools = async (names) => {
    entered();
    await gate;
    return originalTools(names);
  };
  const recovering = core.recover();
  await waiting;
  const before = backup(k, run.id);
  await core.shutdown();
  release();
  await recovering;

  assert.equal(backup(k, run.id), before);
  assert.equal(k.mustLoad(run.id).status, 'running');
  assert.equal(k.mustLoad(run.id).baseProbeStash, 'deadbeef');
});

test('остановка службы: успешный ответ агента после shutdown не пишет файлы стадии', unix, async (t) => {
  let entered = () => {};
  const waiting = new Promise<void>((resolve) => (entered = resolve));
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { core, k, a, save } = setup(t, async () => {
    entered();
    await gate;
    return okReply('План');
  });
  const run = save(a, { mode: 'refactor', next: 'plan', testCommand: '', prepared: true });
  const changeDir = path.join(run.worktreePath, 'openspec', 'changes', run.changeId);
  fs.mkdirSync(changeDir, { recursive: true });
  await core.recover();
  await waiting;
  const before = backup(k, run.id);
  const stopping = core.shutdown();
  release();
  await stopping;

  assert.equal(fs.existsSync(path.join(changeDir, '.openspec.yaml')), false);
  assert.equal(backup(k, run.id), before);
  assert.equal(k.mustLoad(run.id).status, 'running');
});

test('остановка службы: ход чата после k.tools не создаёт каталог', unix, async (t) => {
  const { core, k } = setup(t);
  const chat = await core.createChat({ agent: 'claude' });
  const originalTools = k.tools.bind(k);
  let entered = () => {};
  const waiting = new Promise<void>((resolve) => (entered = resolve));
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  k.tools = async (names) => {
    entered();
    await gate;
    return originalTools(names);
  };
  const sending = core.sendChat(chat.id, 'Текст');
  const rejection = rejectsShutdown(sending);
  await waiting;
  const stopping = core.shutdown();
  release();
  await stopping;
  await rejection;

  assert.equal(fs.existsSync(path.join(k.opts.dataDir, 'chats', chat.id, 'work')), false);
});

test('остановка службы: принятый run.start, ожидающий k.tools, отвечает ошибкой и ничего не запускает', unix, async (t) => {
  const { core, k, a, cliCalls } = setup(t);
  const originalTools = k.tools.bind(k);
  let entered = () => {};
  const waiting = new Promise<void>((resolve) => (entered = resolve));
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  k.tools = async (names) => {
    entered();
    await gate;
    return originalTools(names);
  };
  const starting = core.dispatch({
    type: 'run.start',
    input: {
      projectPath: a.repo,
      task: 'Задача',
      testCommand: '',
      mode: 'quick',
      attachments: [{ name: 'note.txt', data: new TextEncoder().encode('secret') }],
    },
  });
  const rejection = rejectsShutdown(starting);
  await waiting;
  const callsBefore = cliCalls();
  const stopping = core.shutdown();
  release();
  await stopping;
  await rejection;

  assert.deepEqual(await core.listRuns(), []);
  assert.equal(fs.existsSync(path.join(k.opts.dataDir, 'attachments')), false);
  assert.equal(cliCalls(), callsBefore);
});

test('остановка службы: принятый run.delete отклонён и ничего не удаляет', unix, async (t) => {
  const { core, k, a, save } = setup(t);
  const worktree = path.join(k.store.worktreesDir(), 'delete-worktree');
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'purpleflow/delete', worktree], { cwd: a.repo });
  const run = save(a, { worktreePath: worktree, branch: 'purpleflow/delete' });
  const originalTools = k.tools.bind(k);
  let entered = () => {};
  const waiting = new Promise<void>((resolve) => (entered = resolve));
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  k.tools = async (names) => {
    entered();
    await gate;
    return originalTools(names);
  };
  const deleting = core.dispatch({ type: 'run.delete', runId: run.id, deleteBranch: false });
  const rejection = rejectsShutdown(deleting);
  await waiting;
  const before = backup(k, run.id);
  const index = path.join(k.opts.dataDir, 'runs.json');
  const indexBefore = fs.readFileSync(index, 'utf8');
  const stopping = core.shutdown();
  release();
  await stopping;
  await rejection;

  assert.equal(backup(k, run.id), before);
  assert.equal(fs.readFileSync(index, 'utf8'), indexBefore);
  assert.equal(fs.existsSync(worktree), true);
});

test('остановка службы: принятый startPreview не копирует .env', unix, async (t) => {
  const { core, k, a, save } = setup(t);
  const worktree = path.join(k.store.worktreesDir(), 'preview-worktree');
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'purpleflow/preview', worktree], { cwd: a.repo });
  fs.writeFileSync(path.join(a.repo, '.env'), 'SECRET=1\n');
  const run = save(a, {
    worktreePath: worktree,
    branch: 'purpleflow/preview',
    envFiles: ['.env'],
    runCommand: 'sleep 30',
    appUrl: 'http://127.0.0.1:43124',
  });

  const starting = core.startPreview(run.id);
  const rejection = rejectsShutdown(starting);
  const stopping = core.shutdown();
  await stopping;
  await rejection;

  assert.equal(fs.existsSync(path.join(worktree, '.env')), false);
  assert.equal(k.previewLaunches.size, 0);
});

test('остановка службы: активный askManager не пишет после shutdown', unix, async (t) => {
  let entered = () => {};
  const waiting = new Promise<void>((resolve) => (entered = resolve));
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { core, k, a, save } = setup(t, async (o) => {
    if (o.group?.endsWith(':manager')) {
      entered();
      await gate;
    }
    return okReply('{"reply":"Готово"}');
  });
  const run = save(a);
  const events: CoreEvent[] = [];
  const asking = core.askManager(run.id, 'Вопрос');
  const rejection = rejectsShutdown(asking);
  core.on((event) => events.push(event));
  await waiting;
  const before = fs.readFileSync(k.store.chatFile(run.id), 'utf8');
  const stopping = core.shutdown();
  release();
  await stopping;
  await rejection;

  assert.equal(fs.readFileSync(k.store.chatFile(run.id), 'utf8'), before);
  assert.equal(
    events.some((event) => event.type === 'manager.updated'),
    false,
  );
});

test('остановка: фоновый learn старого ядра ничего не пишет', unix, async (t) => {
  const { core, makeCore, k, a, root, save } = setup(t, async (o) => {
    const result = await runProc('sh', ['-c', `printf learn > "${path.join(root, 'learn-process')}"`], {
      cwd: o.cwd,
      env: process.env,
      group: o.group,
    });
    return { ok: result.code === 0, text: '{"lessons":["Новый урок"]}', usage: emptyUsage() };
  });
  save(a, {
    next: 'finish',
    gates: [{ gate: 'gate2', at: '2026-01-01T00:00:00.000Z', decision: 'reject', comment: 'Надо иначе' }],
  });
  const originalTools = k.tools.bind(k);
  let entered = () => {};
  const waiting = new Promise<void>((resolve) => (entered = resolve));
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  k.tools = async (names) => {
    if (names.length === 1 && names[0] === 'claude') {
      entered();
      await gate;
    }
    return originalTools(names);
  };
  await core.recover();
  await waiting;
  const projects = path.join(k.opts.dataDir, 'projects.json');
  const before = fs.existsSync(projects) ? fs.readFileSync(projects, 'utf8') : null;

  await core.shutdown();
  makeCore();
  release();
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(fs.existsSync(path.join(root, 'learn-process')), false);
  assert.equal(fs.existsSync(projects) ? fs.readFileSync(projects, 'utf8') : null, before);
});
