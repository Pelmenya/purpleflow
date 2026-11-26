import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyUsage } from './agents/common.js';
import { startHost, type StartHostOptions } from './server/host.js';
import { RunStore } from './store.js';
import type { CoreSettings, RunFile } from './types.js';

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
const linux = { skip: process.platform !== 'linux', timeout: 30_000 };

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
  assert.deepEqual(first.runs, [
    { id: allowed.id, projectId: 'p1', title: 'Разрешённый', status: 'stopped', next: 'implement' },
  ]);
});
