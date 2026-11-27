import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentResult } from './agents/common.js';
import { loadLoginShellEnv, prependPath } from './env.js';
import type { CoreSettings, RunFile } from './types.js';
import type { Orchestrator } from './orchestrator.js';
import type { CoreOptions } from './runtime.js';
import type { ServerProject } from './server/config.js';
import { startHost, type Host } from './server/host.js';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PROMPTS = path.join(ROOT, 'core', 'prompts');
const env = prependPath(loadLoginShellEnv(), path.join(ROOT, 'node_modules', '.bin'));

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

export async function startTestHost(
  opts: {
    dataDir?: string;
    runners?: CoreOptions['runners'];
    settings?: CoreSettings;
    project?: Partial<ServerProject>;
    onCore?: (core: Orchestrator) => void;
  } = {},
): Promise<{ host: Host; core: Orchestrator; dataDir: string; project: ServerProject; close: () => Promise<void> }> {
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
  return { host, core, dataDir, project, close };
}
