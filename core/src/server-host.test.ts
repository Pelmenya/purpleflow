import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyUsage } from './agents/common.js';
import { startHost, type Host, type HostSnapshot, type StartHostOptions } from './server/host.js';
import { RunStore } from './store.js';
import type { CoreEvent, CoreSettings, RunFile } from './types.js';

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
const SELF = fileURLToPath(import.meta.url);
const CHILD = fileURLToPath(new URL('./server-host-child.test.ts', import.meta.url));
const INLINE_HELPER = '--pf-server-host-inline';
const linux = { skip: process.platform !== 'linux', timeout: 30_000 };
type TestWithAfter = { after: (fn: () => void | Promise<void>) => void };

if (process.argv.includes(INLINE_HELPER)) {
  const options = JSON.parse(process.env.PF_HOST_INLINE!) as StartHostOptions;
  const host = await startHost(options);
  try {
    console.log(JSON.stringify(await host.snapshot()));
    console.log('ready');
  } finally {
    await host.close();
    process.exit(0);
  }
}

async function openHost(t: TestWithAfter, options: StartHostOptions): Promise<Host> {
  const host = await startHost(options);
  t.after(() => host.close());
  return host;
}

async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

function spawnHost(t: TestWithAfter, options: StartHostOptions, inline = false) {
  const variable = inline ? 'PF_HOST_INLINE' : 'PF_HOST_CHILD';
  const child = spawn(process.execPath, ['--import', 'tsx', ...(inline ? [SELF, INLINE_HELPER] : [CHILD])], {
    env: { ...process.env, [variable]: JSON.stringify(options) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => killChild(child));
  let buffer = '';
  let stderr = '';
  let snapshot: HostSnapshot | undefined;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const ready = new Promise<HostSnapshot>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`Таймаут готовности процесса: ${stderr}`)), 15_000);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(snapshot!);
    };
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => finish(new Error(`Процесс вышел до ready: ${code ?? signal}; ${stderr}`)));
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines) {
        if (line === 'ready') finish(snapshot ? undefined : new Error('Процесс не напечатал снимок'));
        else if (line) snapshot = JSON.parse(line) as HostSnapshot;
      }
    });
  });
  return { child, ready, stderr: () => stderr };
}

function initRepo(project: string): string {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
  fs.writeFileSync(path.join(project, 'a.txt'), 'a\n');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: project });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: project });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim();
}

function fakeTools(root: string, capture: string) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const claude = path.join(bin, 'chosen-claude');
  const openspec = path.join(bin, 'openspec');
  fs.writeFileSync(
    claude,
    `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) {
  console.log('claude 1.0.0');
} else if (process.argv[2] === '-p') {
  fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ script: ${JSON.stringify(claude)}, args: process.argv.slice(2), env: process.env }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Готово', usage: {} }));
}
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(openspec, '#!/bin/sh\necho 1.0.0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho "выбран claude из PATH" >&2\nexit 1\n', { mode: 0o755 });
  return { bin, claude, openspec };
}

async function waitFor(ok: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (ok()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

function settings(toolPaths: CoreSettings['toolPaths'] = {}): CoreSettings {
  return {
    toolPaths,
    enabledAgents: ['claude'],
    proxy: { baseUrl: '', apiKey: '' },
    models: { planner: '', executor: '', reviewer: '' },
    agents: { planner: 'claude', executor: 'claude', reviewer: 'claude' },
    agentTimeoutMin: 1,
    testTimeoutMin: 1,
    maxParallel: 2,
  };
}

function save(store: RunStore, projectPath: string, over: Partial<RunFile> = {}): RunFile {
  const id = over.id ?? `run-${Math.random().toString(36).slice(2, 10)}`;
  const run = {
    version: 2,
    id,
    title: 'Задача',
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

function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-server-host-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const project = path.join(root, 'project');
  const other = path.join(root, 'other');
  fs.mkdirSync(project);
  fs.mkdirSync(other);
  const dataDir = path.join(root, 'data');
  const options: StartHostOptions = {
    dataDir,
    promptsDir: PROMPTS,
    projects: [{ id: 'p1', path: project }],
    settings: settings(),
    agentEnv: { ...process.env },
  };
  return { root, project, other, dataDir, options };
}

test('хост: два снимка возвращают одинаковые id проекта и прогона, чужой проект отсутствует', linux, async (t) => {
  const { options, project, other, dataDir } = setup(t);
  const store = new RunStore(dataDir);
  const allowed = save(store, project, { title: 'Разрешённый' });
  save(store, other, { title: 'Чужой' });
  const host = await startHost(options);
  t.after(() => host.close());

  const first = await host.snapshot();
  const second = await host.snapshot();
  assert.deepEqual(first, second);
  assert.deepEqual(first.projects, [{ id: 'p1', name: path.basename(fs.realpathSync(project)) }]);
  assert.deepEqual(first.runs, [{ id: allowed.id, projectId: 'p1', title: 'Разрешённый', status: 'stopped', next: 'implement' }]);
});

test('хост: второй экземпляр на том же каталоге отклонён, после close владение свободно', linux, async (t) => {
  const { root, options, dataDir } = setup(t);
  const link = path.join(root, 'data-link');
  fs.symlinkSync(dataDir, link, 'dir');
  const first = await openHost(t, options);

  await assert.rejects(startHost({ ...options, dataDir: link }), /Каталог данных уже обслуживается/);
  await first.close();
  await first.close();
  const second = await openHost(t, { ...options, dataDir: link });
  await second.close();
});

test('хост: некорректные проекты отклонены без создания ядра, каталог после отказа свободен', linux, async (t) => {
  const { root, options, project } = setup(t);
  const alias = path.join(root, 'project-alias');
  fs.symlinkSync(project, alias, 'dir');
  const cases: StartHostOptions['projects'][] = [
    [
      { id: 'p1', path: project },
      { id: 'p1', path: project },
    ],
    [{ id: 'team/a', path: project }],
    [{ id: 'a..b', path: project }],
    [{ id: 'p1\n', path: project }],
    [{ id: 'p1\r\n', path: project }],
    [{ id: 'p1\u2028', path: project }],
    [{ id: 'p1', path: path.join(root, 'отсутствует') }],
    [
      { id: 'p1', path: project },
      { id: 'p2', path: alias },
    ],
  ];

  for (const projects of cases) {
    await assert.rejects(startHost({ ...options, projects }));
    assert.equal(fs.existsSync(path.join(options.dataDir, 'runs.json')), false);
    const host = await openHost(t, options);
    await host.close();
  }
});

test('хост: удерживаемое подключение к сокету владения не задерживает close', linux, async (t) => {
  const { options, dataDir } = setup(t);
  const host = await openHost(t, options);
  const address = `\0purpleflow-data-${createHash('sha256').update(fs.realpathSync(dataDir)).digest('hex')}`;
  const socket = net.connect(address);
  t.after(() => socket.destroy());
  await once(socket, 'connect');

  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    host.close(),
    new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('close ждёт клиентский сокет')), 2_000))),
  ]).finally(() => clearTimeout(timer));
  const reopened = await openHost(t, options);
  await reopened.close();
});

test('хост: после SIGKILL владельца новый процесс получает владение и данные', linux, async (t) => {
  const { options, project, dataDir } = setup(t);
  const run = save(new RunStore(dataDir), project);
  const first = spawnHost(t, options);
  const initial = await first.ready;
  assert.equal(initial.runs[0]?.id, run.id);
  await killChild(first.child);

  const second = spawnHost(t, options);
  const restored = await second.ready;
  assert.deepEqual(restored.projects, initial.projects);
  assert.deepEqual(restored.runs, initial.runs);
});

test('хост: ошибка recover отклоняет запуск, новый процесс подхватывает данные', linux, async (t) => {
  const { options, project, dataDir } = setup(t);
  const run = save(new RunStore(dataDir), project, { status: 'running' });
  const backup = path.join(dataDir, 'runs', `${run.id}.json`);
  const broken = JSON.parse(fs.readFileSync(backup, 'utf8')) as RunFile;
  broken.attempts = null as unknown as RunFile['attempts'];
  fs.writeFileSync(backup, JSON.stringify(broken));

  await assert.rejects(startHost(options));
  broken.attempts = [];
  broken.status = 'stopped';
  fs.writeFileSync(backup, JSON.stringify(broken));
  const child = spawnHost(t, options);
  const restored = await child.ready;
  assert.equal(restored.runs[0]?.id, run.id);
});

test('хост: путь прогона через симлинк допущен при совпадающем realpath', linux, async (t) => {
  const { root, options, project, dataDir } = setup(t);
  const alias = path.join(root, 'project-alias');
  fs.symlinkSync(project, alias, 'dir');
  const run = save(new RunStore(dataDir), alias);
  const host = await openHost(t, options);

  const snapshot = await host.snapshot();
  assert.deepEqual(
    snapshot.runs.map((item) => [item.id, item.projectId]),
    [[run.id, 'p1']],
  );
});

test('хост: onEvent ловит событие восстановленного прогона до готовности', linux, async (t) => {
  const { options, project, dataDir } = setup(t);
  const run = save(new RunStore(dataDir), project, { status: 'running', next: 'gate2' });
  const events: CoreEvent[] = [];
  await openHost(t, { ...options, onEvent: (event) => events.push(event) });

  assert.equal(
    events.some((event) => event.type === 'run.updated' && event.run.id === run.id && event.run.status === 'running'),
    true,
  );
});

test('хост: агент получает settings и agentEnv без секрета службы', linux, async (t) => {
  const { root, options, project, dataDir } = setup(t);
  const head = initRepo(project);
  const capture = path.join(root, 'agent.json');
  const tools = fakeTools(root, capture);
  const secretName = 'PF_HOST_TEST_SERVICE_SECRET';
  const previousSecret = process.env[secretName];
  process.env[secretName] = 'секрет службы';
  t.after(() => {
    if (previousSecret === undefined) delete process.env[secretName];
    else process.env[secretName] = previousSecret;
  });
  const agentEnv: NodeJS.ProcessEnv = {
    PATH: `${tools.bin}${path.delimiter}${process.env.PATH ?? ''}`,
    HOME: process.env.HOME,
    PF_HOST_TEST_AGENT: 'переданное окружение',
  };
  save(new RunStore(dataDir), project, { status: 'running', baseCommit: head, testCommand: '' });
  const host = await openHost(t, {
    ...options,
    settings: settings({ claude: tools.claude, openspec: tools.openspec }),
    agentEnv,
  });

  await waitFor(() => fs.existsSync(capture), 'фейковый агент не запущен');
  const call = JSON.parse(fs.readFileSync(capture, 'utf8')) as {
    script: string;
    args: string[];
    env: NodeJS.ProcessEnv;
  };
  assert.equal(call.script, tools.claude);
  assert.equal(call.args[0], '-p');
  assert.equal(call.env.PF_HOST_TEST_AGENT, 'переданное окружение');
  assert.equal(call.env[secretName], undefined);
  await host.close();
});

test('хост: ядро работает в realpath каталога данных после перенацеливания ссылки', linux, async (t) => {
  const { root, options, project } = setup(t);
  const head = initRepo(project);
  const capture = path.join(root, 'agent.json');
  const tools = fakeTools(root, capture);
  const dataA = path.join(root, 'data-a');
  const dataB = path.join(root, 'data-b');
  const link = path.join(root, 'data-link');
  fs.mkdirSync(dataB);
  const run = save(new RunStore(dataA), project, { status: 'running', baseCommit: head, testCommand: '' });
  fs.symlinkSync(dataA, link, 'dir');
  const hostOptions: StartHostOptions = {
    ...options,
    dataDir: link,
    settings: settings({ claude: tools.claude, openspec: tools.openspec }),
    agentEnv: { PATH: `${tools.bin}${path.delimiter}${process.env.PATH ?? ''}`, HOME: process.env.HOME },
  };
  await openHost(t, hostOptions);
  fs.unlinkSync(link);
  fs.symlinkSync(dataB, link, 'dir');

  await waitFor(() => {
    const saved = JSON.parse(fs.readFileSync(path.join(dataA, 'runs', `${run.id}.json`), 'utf8')) as RunFile;
    return saved.attempts.length > 0;
  }, 'первый хост не записал восстановленный прогон в исходный realpath');
  assert.equal(fs.existsSync(path.join(dataB, 'runs', `${run.id}.json`)), false);

  const second = spawnHost(t, hostOptions, true);
  const snapshotB = await second.ready;
  assert.deepEqual(snapshotB.projects, [{ id: 'p1', name: path.basename(fs.realpathSync(project)) }]);
  assert.deepEqual(snapshotB.runs, []);
});
