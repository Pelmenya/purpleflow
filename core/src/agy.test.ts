// Адаптер agy (Antigravity CLI) через ACP: JSON-RPC диалог, прокси, решения по запросам разрешений.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentStep } from './agents/common.js';
import {
  AGY_PROXY_DATA_DIR,
  agyArgs,
  agyDecision,
  agyEnv,
  agyError,
  agyModelId,
  agyProxyBase,
  agyToolInput,
  permissionOutcome,
  readOnlyCommand,
  runAgy,
  type AgyOptions,
} from './agents/agy.js';

const unix = { skip: process.platform === 'win32' };

interface Scenario {
  /** Что agy пришлёт во время session/prompt: обновления и запросы разрешений. */
  steps?: ({ update: Record<string, unknown> } | { permission: Record<string, unknown>; after?: Record<string, unknown>[] })[];
  /** Шаги следующих session/prompt того же запуска (после первого). */
  next?: Scenario['steps'][];
  stopReason?: string;
  usage?: Record<string, number>;
  /** Ошибка JSON-RPC на этот метод. */
  failOn?: string;
}

/**
 * Фейковый `agy acp` на Node: отвечает на initialize/authenticate/session/*, проигрывает сценарий и пишет
 * в log всё, что получил, — плюс argv и переменные прокси.
 */
function fakeAgy(t: { after: (fn: () => void) => void }, sc: Scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-agy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(sc));
  const bin = path.join(dir, 'agy');
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('fs'); const path = require('path'); const rl = require('readline');
const dir = ${JSON.stringify(dir)};
const sc = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
const log = (x) => fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify(x) + '\\n');
log({ argv: process.argv.slice(2), key: process.env.GEMINI_API_KEY || null, base: process.env.GOOGLE_GEMINI_BASE_URL || null });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
const waiting = new Map(); let nextId = 100; let prompts = 0;
const ask = (method, params) => new Promise((r) => { const id = String(nextId++); waiting.set(id, r); send({ id, method, params }); });
const update = (u) => send({ method: 'session/update', params: { sessionId: 'S1', update: u } });
const models = { availableModels: ['gemini-3.8-flash-high', 'gemini-3.8-flash-low', 'gemini-4-argon-high'].map((modelId) => ({ modelId })) };
rl.createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line); log(m);
  if (m.method === undefined) { const r = waiting.get(String(m.id)); waiting.delete(String(m.id)); return r && r(m); }
  if (sc.failOn === m.method) return send({ id: m.id, error: { code: -32000, message: 'Authentication required' } });
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: 1, authMethods: [] } });
  if (m.method === 'session/new') return send({ id: m.id, result: { sessionId: 'S1', models } });
  if (m.method === 'session/resume') return send({ id: m.id, result: { models } });
  if (m.method !== 'session/prompt') return send({ id: m.id, result: {} });
  const round = prompts++;
  for (const s of (round ? (sc.next || [])[round - 1] : sc.steps) || []) {
    if (s.update) update(s.update);
    else {
      const res = await ask('session/request_permission', { sessionId: 'S1', toolCall: s.permission, options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }] });
      const ok = res.result && res.result.outcome && res.result.outcome.optionId === 'allow';
      update({ sessionUpdate: 'tool_call_update', toolCallId: s.permission.toolCallId, status: ok ? 'completed' : 'failed', rawOutput: { output: ok ? 'готово' : 'user denied' } });
      for (const a of s.after || []) update(a);
    }
  }
  send({ id: m.id, result: { stopReason: sc.stopReason || 'end_turn', usage: sc.usage || {} } });
});
`,
    { mode: 0o755 },
  );
  const read = () =>
    fs
      .readFileSync(path.join(dir, 'log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { bin, read };
}

function opts(bin: string, cwd: string, o: Partial<AgyOptions> = {}): AgyOptions & { steps: AgentStep[] } {
  const steps: AgentStep[] = [];
  return {
    bin,
    cwd,
    env: process.env,
    prompt: 'Сделай дело',
    timeoutMs: 30_000,
    group: 'agy-test',
    onOutput: () => {},
    onStep: (s) => steps.push(s),
    steps,
    ...o,
  };
}

const text = (t: string) => ({ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } } });
const tmp = (t: { after: (fn: () => void) => void }) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-agy-cwd-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

test('agyProxyBase: Gemini API прокси — рядом с адресом Anthropic', () => {
  const p = (baseUrl: string) => agyProxyBase({ baseUrl, apiKey: 'k' });
  assert.equal(
    p('https://app.purpleschool.ru/api-v2/public/ai-proxy/anthropic'),
    'https://app.purpleschool.ru/api-v2/public/ai-proxy/gemini',
  );
  assert.equal(p('https://x.test/ai-proxy/anthropic/'), 'https://x.test/ai-proxy/gemini');
  assert.equal(p('https://x.test/ai-proxy/openai/v1'), 'https://x.test/ai-proxy/gemini');
});

test('agyArgs и agyEnv: с прокси — свой каталог данных и ключ только в окружении', () => {
  const proxy = { baseUrl: 'https://x.test/ai-proxy/anthropic', apiKey: 'секрет' };
  const args = agyArgs({ proxy, addDirs: ['/a'] });
  assert.deepEqual(args, ['acp', '--disable-telemetry', '--app-data-dir', AGY_PROXY_DATA_DIR, '--add-dir', '/a']);
  assert.ok(!args.join(' ').includes('секрет'));
  const env = agyEnv({ env: { GOOGLE_API_KEY: 'чужой', PATH: '/bin' }, proxy });
  assert.equal(env.GEMINI_API_KEY, 'секрет');
  assert.equal(env.GOOGLE_GEMINI_BASE_URL, 'https://x.test/ai-proxy/gemini');
  assert.equal(env.GOOGLE_API_KEY, undefined);
  // Без прокси — вход пользователя, никаких ключей и своего каталога.
  assert.deepEqual(agyArgs({}), ['acp', '--disable-telemetry']);
  assert.equal(agyEnv({ env: { PATH: '/bin' } }).GEMINI_API_KEY, undefined);
});

test('agyModelId: уровень рассуждений — суффиксом, если такая модель есть', () => {
  const av = ['gemini-3.8-flash-high', 'gemini-3.8-flash-low'];
  assert.equal(agyModelId('gemini-3.8-flash', 'high', av), 'gemini-3.8-flash-high');
  assert.equal(agyModelId('gemini-3.8-flash', 'xhigh', av), 'gemini-3.8-flash');
  assert.equal(agyModelId('gemini-3.8-flash-low', 'high', av), 'gemini-3.8-flash-low');
  assert.equal(agyModelId(undefined, 'high', av), undefined);
});

test('readOnlyCommand: читающие команды и git — да, запись, перенаправления и подстановки — нет', () => {
  for (const ok of [
    'git diff HEAD~1',
    'git log --oneline | head -5',
    'ls -la && cat README.md',
    'rg foo src',
    'git branch',
    'find . -name "*.ts"',
  ])
    assert.ok(readOnlyCommand(ok), ok);
  for (const no of [
    'echo x > a.txt',
    'git commit -m x',
    'git branch new',
    'rm -rf src',
    'find . -delete',
    'cat $(whoami)',
    'npm install',
    'git checkout -b x',
  ])
    assert.ok(!readOnlyCommand(no), no);
});

test('agyDecision: режимы чата и стадий', () => {
  const root = '/proj';
  const cmd = (CommandLine: string) => ({ kind: 'execute', name: 'run_command', rawInput: { CommandLine } });
  const write = (p: string) => ({ kind: 'edit', name: 'write_file', rawInput: { Path: p }, locations: [{ path: p }] });
  // Полный доступ — всё.
  assert.equal(agyDecision('full', cmd('git push'), [root]), null);
  // Только чтение: читающие команды можно, запись и меняющие команды — нет.
  assert.equal(agyDecision('readOnly', cmd('git diff'), [root]), null);
  assert.match(agyDecision('readOnly', cmd('npm test'), [root]) ?? '', /только читает/);
  assert.match(agyDecision('readOnly', write('/proj/a.ts'), [root]) ?? '', /правки запрещены/);
  assert.equal(agyDecision('readOnly', { kind: 'read', name: 'read_file' }, [root]), null);
  // Правки: внутри проекта можно, вне его и в .git — нет; git-операции — только с полным доступом.
  assert.equal(agyDecision('limited', write('/proj/src/a.ts'), [root]), null);
  assert.match(agyDecision('limited', write('/etc/hosts'), [root]) ?? '', /вне папки проекта/);
  assert.match(agyDecision('limited', write('/proj/.git/config'), [root]) ?? '', /\.git/);
  assert.equal(agyDecision('limited', cmd('npm test'), [root]), null);
  assert.match(agyDecision('limited', cmd('git commit -am x'), [root]) ?? '', /полным доступом/);
  assert.match(agyDecision('limited', cmd('rm -rf .git'), [root]) ?? '', /полным доступом/);
  assert.equal(agyDecision('limited', cmd('git status'), [root]), null);
});

test('permissionOutcome: выбирает вариант agy по виду, а не по имени', () => {
  const options = [
    { optionId: 'a1', kind: 'allow_once' },
    { optionId: 'r1', kind: 'reject_once' },
  ];
  assert.deepEqual(permissionOutcome(options, true), { outcome: { outcome: 'selected', optionId: 'a1' } });
  assert.deepEqual(permissionOutcome(options, false), { outcome: { outcome: 'selected', optionId: 'r1' } });
  assert.deepEqual(permissionOutcome([], false), { outcome: { outcome: 'cancelled' } });
});

test('agyToolInput: аргументы agy переводятся в имена claude', () => {
  assert.deepEqual(agyToolInput({ CommandLine: 'ls', WaitMsBeforeAsync: 5000, toolSummary: 'x' }), { command: 'ls' });
  assert.deepEqual(agyToolInput({ Path: '/a', Content: 'x' }), { file_path: '/a', content: 'x' });
});

test('agyError: прокси, вход, регион и лимиты — понятными фразами', () => {
  assert.match(agyError('Error 404, Message: Gemini model is unavailable', true), /нет в AI-прокси/);
  assert.match(agyError('Error 401 API key not valid', true), /отклонил ключ/);
  // Прокси не получил ответа у провайдера модели — понятная фраза с именем модели, а не сырой текст.
  const upstream = agyError(
    'generating and executing: Error 400, Message: API Route Gemini request failed, Status: INVALID_ARGUMENT, Details: []',
    true,
    'gemini-4-argon-low',
  );
  assert.match(upstream, /провайдер модели «gemini-4-argon» сейчас отвечает ошибкой/);
  assert.match(upstream, /gemini-3\.8-flash/);
  assert.match(agyError('Error 404 Gemini model is unavailable', true, 'gemini-4-neon'), /модели «gemini-4-neon» нет/);
  assert.match(agyError('Authentication required (-32000)', false), /Подключите AI-прокси/);
  const region = agyError('eligibility check failed', false);
  assert.match(region, /AI-прокси PurpleSchool/);
  assert.doesNotMatch(region, /сеть|VPN/i);
  assert.match(agyError('RESOURCE_EXHAUSTED 429', false), /лимит/);
});

test('runAgy: через прокси — вход по ключу, системный промпт, модель с уровнем и ответ после инструментов', unix, async (t) => {
  const cwd = tmp(t);
  const f = fakeAgy(t, {
    steps: [
      text('Сначала посмотрю. '),
      {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'c1',
          name: 'read_file',
          kind: 'read',
          rawInput: { Path: `${cwd}/a.txt` },
          status: 'in_progress',
        },
      },
      { update: { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: { output: 'hi' } } },
      text('Готово'),
      { update: { sessionUpdate: 'usage_update', used: 1200, size: 1048576 } },
    ],
    usage: { inputTokens: 100, outputTokens: 20, thoughtTokens: 5, cachedReadTokens: 7 },
  });
  let session = '';
  const o = opts(f.bin, cwd, {
    systemPrompt: 'Ты помощник',
    model: 'gemini-3.8-flash',
    effort: 'high',
    proxy: { baseUrl: 'https://x.test/ai-proxy/anthropic', apiKey: 'ppk-test' },
    onSession: (id) => (session = id),
  });
  const r = await runAgy(o);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.text, 'Готово');
  assert.equal(session, 'S1');
  assert.deepEqual([r.usage.input, r.usage.output, r.usage.cacheRead], [100, 25, 7]);
  const log = f.read();
  assert.equal(log[0].key, 'ppk-test');
  assert.equal(log[0].base, 'https://x.test/ai-proxy/gemini');
  const methods = log.map((m) => m.method).filter(Boolean);
  assert.deepEqual(methods, ['initialize', 'authenticate', 'session/new', 'session/set_model', 'session/prompt']);
  const msg = (name: string) => log.find((m) => m.method === name)!.params as Record<string, unknown>;
  assert.deepEqual(msg('authenticate'), { methodId: 'gemini-api-key' });
  assert.deepEqual(msg('session/new')._meta, { antigravity: { systemPrompt: { append: 'Ты помощник' } } });
  assert.equal(msg('session/set_model').modelId, 'gemini-3.8-flash-high');
  assert.ok(o.steps.some((s) => s.kind === 'tool' && s.id === 'c1'));
  assert.ok(o.steps.some((s) => s.kind === 'tool_result' && s.id === 'c1' && s.ok && s.output === 'hi'));
  assert.ok(o.steps.some((s) => s.kind === 'meta' && s.context === 1200));
});

test('runAgy: без модели через прокси — модель прокси по умолчанию; без прокси — без входа по ключу', unix, async (t) => {
  const cwd = tmp(t);
  const a = fakeAgy(t, { steps: [text('ок')] });
  await runAgy(opts(a.bin, cwd, { proxy: { baseUrl: 'https://x.test/ai-proxy/anthropic', apiKey: 'k' } }));
  assert.equal((a.read().find((m) => m.method === 'session/set_model')!.params as { modelId: string }).modelId, 'gemini-3.8-flash');
  const b = fakeAgy(t, { steps: [text('ок')] });
  await runAgy(opts(b.bin, cwd));
  const methods = b
    .read()
    .map((m) => m.method)
    .filter(Boolean);
  assert.deepEqual(methods, ['initialize', 'session/new', 'session/prompt']);
  assert.equal(b.read()[0].key, null);
});

test('runAgy: продолжение беседы — session/resume, без системного промпта заново', unix, async (t) => {
  const cwd = tmp(t);
  const f = fakeAgy(t, { steps: [text('помню')] });
  const r = await runAgy(opts(f.bin, cwd, { resumeConversation: 'S0', systemPrompt: 'Ты помощник' }));
  assert.equal(r.ok, true, r.error);
  const resume = f.read().find((m) => m.method === 'session/resume');
  assert.equal((resume!.params as { sessionId: string }).sessionId, 'S0');
  assert.ok(!f.read().some((m) => m.method === 'session/new'));
});

test('runAgy: в «Правках» git-операция отклоняется, и отказ виден как «нет доступа»', unix, async (t) => {
  const cwd = tmp(t);
  const f = fakeAgy(t, {
    steps: [
      {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'c1',
          name: 'run_command',
          kind: 'execute',
          rawInput: { CommandLine: 'git commit -am x' },
        },
      },
      { permission: { toolCallId: 'c1', name: 'run_command', kind: 'execute', rawInput: { CommandLine: 'git commit -am x' } } },
      { update: { sessionUpdate: 'tool_call', toolCallId: 'c2', name: 'write_file', kind: 'edit', rawInput: { Path: `${cwd}/a.txt` } } },
      {
        permission: {
          toolCallId: 'c2',
          name: 'write_file',
          kind: 'edit',
          rawInput: { Path: `${cwd}/a.txt` },
          locations: [{ path: `${cwd}/a.txt` }],
        },
      },
      text('Не смог закоммитить'),
    ],
  });
  const o = opts(f.bin, cwd, { limited: true });
  const r = await runAgy(o);
  assert.equal(r.ok, true, r.error);
  const answers = f.read().filter((m) => m.method === undefined && m.result) as { result: { outcome: { optionId: string } } }[];
  assert.deepEqual(
    answers.map((a) => a.result.outcome.optionId),
    ['deny', 'allow'],
  );
  const denied = o.steps.find((s) => s.kind === 'tool_result' && s.id === 'c1') as Extract<AgentStep, { kind: 'tool_result' }>;
  assert.equal(denied.ok, false);
  assert.match(denied.output ?? '', /operation not permitted/i);
  assert.ok(o.steps.some((s) => s.kind === 'tool_result' && s.id === 'c2' && s.ok));
});

test('runAgy: только чтение отклоняет запись', unix, async (t) => {
  const cwd = tmp(t);
  const f = fakeAgy(t, {
    steps: [{ permission: { toolCallId: 'c1', name: 'write_file', kind: 'edit', rawInput: { Path: `${cwd}/a.txt` } } }, text('нельзя')],
  });
  const r = await runAgy(opts(f.bin, cwd, { readOnly: true }));
  assert.equal(r.ok, true, r.error);
  const answer = f.read().find((m) => m.method === undefined && m.result) as { result: { outcome: { optionId: string } } };
  assert.equal(answer.result.outcome.optionId, 'deny');
  const prompt = f.read().find((m) => m.method === 'session/prompt')!.params as { prompt: { text: string }[] };
  assert.match(prompt.prompt[0].text, /только на чтение/);
});

test('runAgy: ошибка модели из потока и ошибка входа — понятный сбой, а не пустой ответ', unix, async (t) => {
  const cwd = tmp(t);
  const proxy = { baseUrl: 'https://x.test/ai-proxy/anthropic', apiKey: 'k' };
  const a = fakeAgy(t, {
    steps: [text('\n⚠ agent executor error: generating and executing: Error 404, Message: Gemini model is unavailable')],
  });
  const r1 = await runAgy(opts(a.bin, cwd, { proxy }));
  assert.equal(r1.ok, false);
  assert.match(r1.error ?? '', /нет в AI-прокси/);
  const b = fakeAgy(t, { failOn: 'session/new' });
  const r2 = await runAgy(opts(b.bin, cwd));
  assert.equal(r2.ok, false);
  assert.match(r2.error ?? '', /нужен вход/);
});

test('runAgy: картинки уходят блоками image', unix, async (t) => {
  const cwd = tmp(t);
  const img = path.join(cwd, 'a.png');
  fs.writeFileSync(img, Buffer.from([1, 2, 3]));
  const f = fakeAgy(t, { steps: [text('вижу')] });
  await runAgy(opts(f.bin, cwd, { images: [img] }));
  const prompt = f.read().find((m) => m.method === 'session/prompt')!.params as { prompt: Record<string, string>[] };
  assert.deepEqual(prompt.prompt[1], { type: 'image', mimeType: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') });
});

test('runAgy: ход кончился на отказе — agy просят закончить без него, и ответ есть', unix, async (t) => {
  const cwd = tmp(t);
  const f = fakeAgy(t, {
    steps: [{ permission: { toolCallId: 'c1', name: 'run_command', kind: 'execute', rawInput: { CommandLine: 'npm test' } } }],
    next: [[text('Тесты запустить нельзя: стадия только читает. Код выглядит верно.')]],
  });
  const r = await runAgy(opts(f.bin, cwd, { readOnly: true }));
  assert.equal(r.ok, true, r.error);
  assert.match(r.text, /Код выглядит верно/);
  const prompts = f.read().filter((m) => m.method === 'session/prompt') as { params: { prompt: { text: string }[] } }[];
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].params.prompt[0].text, /отклонил последнее действие: стадия только читает/);
});

test('runAgy: в «Правках» спрашивает человека — один раз, в этом чате и отказ', unix, async (t) => {
  const cwd = tmp(t);
  const push = { toolCallId: 'c1', name: 'run_command', kind: 'execute', rawInput: { CommandLine: 'git push' } };
  const f = fakeAgy(t, {
    steps: [
      { permission: push },
      { permission: { ...push, toolCallId: 'c2' } },
      {
        permission: {
          toolCallId: 'c3',
          name: 'write_file',
          kind: 'edit',
          rawInput: { Path: '/etc/hosts' },
          locations: [{ path: '/etc/hosts' }],
        },
      },
      text('Готово'),
    ],
  });
  const asked: string[] = [];
  const kept: string[] = [];
  const o = opts(f.bin, cwd, {
    limited: true,
    // Молчание agy, пока человек думает, — не зависание.
    idleTimeoutMs: 1500,
    askPermission: async (q) => {
      asked.push(q.id);
      await new Promise((r) => setTimeout(r, 2000));
      return q.id === 'c1' ? 'always' : 'deny';
    },
    onAllow: (key) => kept.push(key),
  });
  const r = await runAgy(o);
  assert.equal(r.ok, true, r.error);
  // c2 — та же команда: после «в этом чате» не спрашиваем.
  assert.deepEqual(asked, ['c1', 'c3']);
  assert.deepEqual(kept, ['command:git push']);
  const answers = f.read().filter((m) => m.method === undefined && m.result) as { result: { outcome: { optionId: string } } }[];
  assert.deepEqual(
    answers.map((a) => a.result.outcome.optionId),
    ['allow', 'allow', 'deny'],
  );
  const denied = o.steps.find((s) => s.kind === 'tool_result' && s.id === 'c3') as Extract<AgentStep, { kind: 'tool_result' }>;
  // Отказ человека — не «песочница»: карточки «Нужен полный доступ» под ним не будет.
  assert.equal(denied.output, 'Вы отклонили это действие.');
});

test('runAgy: разрешённое раньше «в этом чате» проходит без вопроса', unix, async (t) => {
  const cwd = tmp(t);
  const f = fakeAgy(t, {
    steps: [{ permission: { toolCallId: 'c1', name: 'run_command', kind: 'execute', rawInput: { CommandLine: 'git push' } } }, text('ок')],
  });
  let asked = false;
  await runAgy(
    opts(f.bin, cwd, {
      limited: true,
      allowed: ['command:git push'],
      askPermission: async () => {
        asked = true;
        return 'deny';
      },
    }),
  );
  assert.equal(asked, false);
  const answer = f.read().find((m) => m.method === undefined && m.result) as { result: { outcome: { optionId: string } } };
  assert.equal(answer.result.outcome.optionId, 'allow');
});
