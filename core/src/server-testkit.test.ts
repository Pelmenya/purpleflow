import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { emptyUsage, type AgentResult } from './agents/common.js';
import { loadLoginShellEnv, prependPath } from './env.js';
import type { CoreSettings, GateId, RunFile } from './types.js';
import type { Orchestrator } from './orchestrator.js';
import type { CoreOptions } from './runtime.js';
import type { ServerConfig, ServerProject } from './server/config.js';
import { startHost, type Host } from './server/host.js';
import { RunStore } from './store.js';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PROMPTS = path.join(ROOT, 'core', 'prompts');
const env = prependPath(loadLoginShellEnv(), path.join(ROOT, 'node_modules', '.bin'));
export const PUBLIC_ORIGIN = 'https://purpleflow.example';
const SECRET = 'секрет владельца';

export function configFor(dataDir: string, project: ServerProject, settings?: CoreSettings): ServerConfig {
  const secretFile = path.join(dataDir, 'secret');
  fs.writeFileSync(secretFile, SECRET, { mode: 0o600 });
  return {
    dataDir,
    promptsDir: PROMPTS,
    projects: [project],
    publicOrigin: PUBLIC_ORIGIN,
    port: 0,
    secretFile,
    settings: settings ?? {
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

export async function openServer(handler: http.RequestListener): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  let closing: Promise<void> | undefined;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close() {
      if (!server.listening) return Promise.resolve();
      closing ??= new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      });
      return closing;
    },
  };
}

export async function listen(t: TestContext, handler: http.RequestListener): Promise<string> {
  const server = await openServer(handler);
  t.after(server.close);
  return server.origin;
}

export class Browser {
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

  login(origin: string, returnTo = '/'): Promise<Response> {
    return this.request(origin, '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: SECRET, returnTo }),
    });
  }
}

export function postDecision(browser: Browser, origin: string, runId: string, fields: Record<string, string>): Promise<Response> {
  return browser.request(origin, `/runs/${runId}/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
}

export const hasOpenspec = (() => {
  try {
    execFileSync('openspec', ['--version'], { env, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

export const serverTestsSkip = process.platform !== 'linux' || !hasOpenspec;

export function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-pipe-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir });
  g('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "p", "type": "module" }\n');
  fs.writeFileSync(path.join(dir, 'src/math.js'), 'export const add = (a, b) => a + b;\n');
  fs.writeFileSync(
    path.join(dir, 'test/math.test.js'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\ntest('add', () => assert.equal(add(2, 3), 5));\n",
  );
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  return dir;
}

export const ok = (text: string): AgentResult => ({ ok: true, text, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });

/** Фейковый claude: отвечает по роли (видно по промпту) и пишет файлы, как настоящий агент. */
export function fakeClaude(script: {
  implement: (n: number, cwd: string, prompt: string) => void;
  review: (n: number) => object;
  manager?: (prompt: string) => string;
  checks?: string;
  questions?: { q: string; options?: string[]; why?: string }[];
  proposal?: string;
}) {
  let impl = 0;
  let rev = 0;
  const prompts: string[] = [];
  const plans: string[] = [];
  const codeReviews: string[] = [];
  const fn = async (o: { prompt: string; cwd: string; systemPrompt?: string }): Promise<AgentResult> => {
    const p = o.prompt;
    const sys = o.systemPrompt ?? '';
    if (/Ты — менеджер прогона/.test(p)) return ok(script.manager?.(p) ?? '{"reply": "Всё идёт по плану.", "action": null}');
    if (/Перед планом проверь/.test(p)) return ok(JSON.stringify({ questions: script.questions ?? [] }));
    if (/второй, независимый ревьюер/.test(p)) return ok('{"items":[{"index":1,"verdict":"confirmed","reason":"сценарий есть"}]}');
    if (/ревьюер кода в PurpleFlow/.test(p)) {
      codeReviews.push(p);
      rev++;
      return ok(JSON.stringify(script.review(rev)));
    }
    if (/ревьюер в конвейере PurpleFlow/.test(p)) {
      rev++;
      return ok(JSON.stringify(script.review(rev)));
    }
    if (/планировщик/.test(sys)) {
      plans.push(p);
      const id = p.match(/используй ровно его\): `([^`]+)`/)![1];
      const d = path.join(o.cwd, 'openspec', 'changes', id);
      fs.mkdirSync(path.join(d, 'specs', 'calc'), { recursive: true });
      fs.writeFileSync(
        path.join(d, 'proposal.md'),
        script.proposal ??
          '# Умножение\n\n## Why\nНужно умножать два числа, сейчас есть только сложение, и это неудобно.\n\n## What Changes\n- mul\n\n## Impact\n- `src/math.js`\n\n## Invariants\n- add работает\n' +
            (script.checks ? `\n## Checks\n- \`${script.checks}\`\n` : ''),
      );
      fs.writeFileSync(path.join(d, 'tasks.md'), '## 1. Код\n- [ ] 1.1 mul в src/math.js\n- [ ] 1.2 тест\n');
      fs.writeFileSync(
        path.join(d, 'specs', 'calc', 'spec.md'),
        '## ADDED Requirements\n### Requirement: Умножение\nКалькулятор SHALL умножать.\n\n#### Scenario: Два числа\n- **WHEN** mul(2, 3)\n- **THEN** 6\n',
      );
      return ok('План готов.');
    }
    if (/исполнитель/.test(sys) || /Реализуй изменение|Продолжаем то же изменение/.test(p)) {
      impl++;
      prompts.push(p);
      script.implement(impl, o.cwd, p);
      return ok(`Попытка ${impl} сделана.`);
    }
    return ok('{}');
  };
  return { fn, prompts: () => prompts, plans: () => plans, reviews: () => rev, codeReviews: () => codeReviews };
}

export async function untilGate(core: Orchestrator, runId: string, gate: string, timeoutMs = 60_000): Promise<RunFile> {
  const t0 = Date.now();
  for (;;) {
    const r = (await core.getRun(runId))!;
    if (r.status === 'waiting' && r.next === gate) return r;
    if (r.status === 'stopped' || r.status === 'finished' || r.status === 'cancelled')
      throw new Error(`прогон остановился: ${r.message ?? r.status} (next=${r.next})`);
    if (Date.now() - t0 > timeoutMs) throw new Error(`не дождались ${gate}, сейчас ${r.next}/${r.status}`);
    await new Promise((res) => setTimeout(res, 100));
  }
}

export function waitingRunFixture(dataDir: string, projectPath: string, partial: Partial<RunFile> & { next: GateId }): RunFile {
  const id = partial.id ?? crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const run: RunFile = {
    version: 2,
    id,
    changeId: `server-${id}`,
    title: 'Ожидающий прогон',
    task: 'Сделай задачу',
    projectPath,
    worktreePath: projectPath,
    branch: 'main',
    baseCommit: 'base',
    testCommand: 'node --test',
    mode: 'task',
    workspace: 'worktree',
    models: { planner: '', executor: '', reviewer: '' },
    agents: { planner: 'claude', executor: 'claude', reviewer: 'claude' },
    status: 'waiting',
    waitId: crypto.randomUUID(),
    attempts: [{ stage: partial.next, attempt: 1, status: 'running', startedAt }],
    planRetries: 0,
    implAttemptsUsed: 0,
    implAttemptsLimit: 3,
    tests: [],
    reviews: [],
    gates: [],
    totals: emptyUsage(),
    createdAt: startedAt,
    updatedAt: startedAt,
    ...partial,
    next: partial.next,
  };
  new RunStore(dataDir).save(run);
  return run;
}

export function makeServerStand(opts: { testCommand?: string } = {}) {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-server-')));
  const root = path.join(sandbox, 'checkout');
  const dataDir = path.join(sandbox, 'data');
  const bin = path.join(sandbox, 'bin');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });

  const delayFile = path.join(sandbox, 'delay-ms');
  const fakeLog = path.join(sandbox, 'fake-claude.jsonl');
  fs.writeFileSync(delayFile, '0');
  const claude = path.join(bin, 'claude');
  const fake = fileURLToPath(new URL('../../app/e2e/fake-claude.mjs', import.meta.url));
  fs.writeFileSync(
    claude,
    `#!/bin/sh\nFAKE_CLAUDE_DELAY_MS="$(cat "${delayFile}")" FAKE_CLAUDE_LOG="${fakeLog}" exec "${process.execPath}" "${fake}" "$@"\n`,
    { mode: 0o755 },
  );

  const git = (...args: string[]) => execFileSync('git', args, { cwd: root });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'server@example.test');
  git('config', 'user.name', 'Server test');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/math.js'), 'export const add = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{ "name": "server-stand", "type": "module" }\n');
  git('add', '-A');
  git('commit', '-qm', 'Начало');

  const project: ServerProject = { id: 'p1', path: root, testCommand: opts.testCommand ?? 'node --version' };
  const secretFile = path.join(dataDir, 'secret');
  fs.writeFileSync(secretFile, SECRET, { mode: 0o600 });
  const configFile = path.join(sandbox, 'server.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      dataDir,
      promptsDir: PROMPTS,
      projects: [project],
      publicOrigin: PUBLIC_ORIGIN,
      port: 43_210,
      secretFile,
      settings: {
        toolPaths: { claude, openspec: path.join(ROOT, 'node_modules', '.bin', 'openspec') },
        agents: { planner: 'claude', executor: 'claude', reviewer: 'claude' },
        enabledAgents: ['claude'],
        agentTimeoutMin: 1,
        testTimeoutMin: 1,
      },
    }),
  );
  return { root, dataDir, configFile, project, delayFile, fakeLog };
}

export async function startTestHost(
  opts: {
    dataDir?: string;
    runners?: CoreOptions['runners'];
    settings?: CoreSettings;
    project?: Partial<ServerProject>;
    onCore?: (core: Orchestrator) => void;
  } = {},
): Promise<{
  host: Host;
  core: Orchestrator;
  dataDir: string;
  project: ServerProject;
  settings: CoreSettings;
  close: () => Promise<void>;
}> {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-bin-'));
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho "claude 1.0.0"\n', { mode: 0o755 });
  const settings: CoreSettings = {
    toolPaths: { claude: path.join(bin, 'claude') },
    proxy: { baseUrl: '', apiKey: '' },
    models: { planner: '', executor: '', reviewer: '' },
    agents: { planner: 'claude', executor: 'claude', reviewer: 'claude' },
    enabledAgents: ['claude'],
    agentTimeoutMin: 5,
    testTimeoutMin: 2,
    maxParallel: 2,
    ...opts.settings,
  };
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-data-'));
  const project: ServerProject = {
    id: opts.project?.id ?? 'p1',
    path: opts.project?.path ?? makeRepo(),
    testCommand: opts.project?.testCommand ?? 'node --test',
    setupCommand: opts.project?.setupCommand,
    lintCommand: opts.project?.lintCommand,
  };
  let core!: Orchestrator;
  const host = await startHost({
    dataDir,
    promptsDir: PROMPTS,
    projects: [project],
    settings,
    agentEnv: env,
    runners: opts.runners,
    onCore: (value) => {
      core = value;
      opts.onCore?.(value);
    },
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= host.close();
    return closing;
  };
  return { host, core, dataDir, project, settings, close };
}
