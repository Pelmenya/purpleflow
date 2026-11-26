// Визуальная проверка: настоящий сервер на свободном порту, агент подменён. npx подменён тоже: иначе тест зависел бы от сети.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyUsage, type AgentRunOptions } from './agents/common.js';
import { Kernel } from './kernel.js';
import { selfCheckReason, startSelfCheck } from './stages/selfcheck.js';
import { stageVisual } from './stages/visual.js';
import type { CoreSettings, RunFile } from './types.js';

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
const unix = { skip: process.platform === 'win32', timeout: 60_000 };
const SERVER = `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(process.env.PORT,'127.0.0.1')"`;

function setup(t: { after: (fn: () => void) => void }, reply: (dir: string, o: AgentRunOptions) => string, runCommand = SERVER) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-visual-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wt = path.join(root, 'wt');
  fs.mkdirSync(wt);
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: wt });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'a\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  const baseCommit = g('rev-parse', 'HEAD').toString().trim();
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'npx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho "claude 1.0.0"\n', { mode: 0o755 });
  const settings = {
    toolPaths: { claude: path.join(bin, 'claude') },
    proxy: { baseUrl: '', apiKey: '' },
    models: { planner: '', executor: '', reviewer: '' },
    agents: { planner: 'claude', executor: 'claude', reviewer: 'claude' },
    agentTimeoutMin: 1,
  } as unknown as CoreSettings;
  const prompts: AgentRunOptions[] = [];
  const k = new Kernel({
    dataDir: path.join(root, 'data'),
    promptsDir: PROMPTS,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    getSettings: () => settings,
    runners: {
      claude: (async (o: AgentRunOptions) => {
        prompts.push(o);
        return { ok: true, text: reply(o.addDirs?.[0] ?? '', o), usage: emptyUsage() };
      }) as never,
    },
  });
  const run = {
    id: 'visual-1',
    title: 'Задача',
    task: 'Сделай кнопку',
    changeId: 'c',
    mode: 'task',
    status: 'running',
    next: 'visual',
    workspace: 'worktree',
    visual: true,
    projectPath: wt,
    worktreePath: wt,
    branch: 'main',
    baseCommit,
    runCommand,
    appUrl: 'http://127.0.0.1:{port}/',
    agents: { planner: 'claude', executor: 'claude', reviewer: 'claude', visual: 'claude' },
    models: {},
    attempts: [],
    tests: [],
    reviews: [],
    implAttemptsUsed: 1,
    implAttemptsLimit: 3,
    totals: emptyUsage(),
    createdAt: '2026-01-01',
  } as unknown as RunFile;
  k.store.save(run);
  return { k, run, prompts, root };
}

test('всё верно: снимки из ответа и неперечисленные; путь наружу отбрасывается; дальше приёмка', unix, async (t) => {
  const { k, run, prompts } = setup(t, (dir) => {
    fs.writeFileSync(path.join(dir, 'home.png'), '');
    fs.writeFileSync(path.join(dir, 'extra.png'), '');
    fs.writeFileSync(`${dir}-evil.png`, '');
    return JSON.stringify({
      blocking: [],
      notes: [],
      shots: [
        { file: 'home.png', caption: 'Главная' },
        { file: `${dir}-evil.png`, caption: 'соседний каталог с тем же началом' },
        { file: path.join(dir, '..', 'secret.png'), caption: 'наружу' },
      ],
    });
  });
  await stageVisual(k, run);
  assert.equal(run.next, 'gate2');
  const v = run.visuals!.at(-1)!;
  assert.deepEqual(
    v.shots.map((s) => s.caption),
    ['Главная', 'extra.png'],
  );
  assert.match(v.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.match(prompts[0].prompt, /Сделай кнопку/);
  assert.deepEqual(prompts[0].tools, ['Bash', 'Read', 'Glob', 'Grep'], 'только смотреть');
  assert.equal(run.attempts.at(-1)!.status, 'done');
  await assert.rejects(fetch(v.url), 'сервер погашен');
});

test('проблемы видны: задача возвращается исполнителю со списком и снимками', unix, async (t) => {
  const { k, run } = setup(t, (dir) => {
    fs.writeFileSync(path.join(dir, 'bug.png'), '');
    return JSON.stringify({ blocking: [{ message: 'кнопка не видна' }], notes: [] });
  });
  await stageVisual(k, run);
  assert.equal(run.next, 'implement');
  assert.equal(run.attempts.at(-1)!.status, 'failed');
  assert.match(run.feedback!.text, /кнопка не видна[\s\S]*bug\.png/);
});

test('подтверждения — в passed, а не в заметках: задача идёт на приёмку', unix, async (t) => {
  const { k, run } = setup(t, () =>
    JSON.stringify({
      blocking: [],
      passed: ['Вкладка «Все» открывается', '  ', { message: 'Консоль без ошибок' }],
      notes: [{ file: null, line: null, message: 'Отступ у заголовка на 390px великоват' }],
    }),
  );
  await stageVisual(k, run);
  assert.equal(run.next, 'gate2');
  const v = run.visuals!.at(-1)!;
  assert.deepEqual(v.passed, ['Вкладка «Все» открывается', 'Консоль без ошибок']);
  assert.deepEqual(
    v.notes.map((n) => n.message),
    ['Отступ у заголовка на 390px великоват'],
  );
  assert.match(run.attempts.at(-1)!.summary ?? '', /проверено: 2/);
});

test('проверить не удалось: не вина исполнителя — сразу к человеку, замечания как заметки', unix, async (t) => {
  const { k, run } = setup(t, () => JSON.stringify({ blocking: [{ message: 'нет входа' }], notes: [], unverified: 'нужен логин' }));
  await stageVisual(k, run);
  assert.equal(run.next, 'gate2');
  const v = run.visuals!.at(-1)!;
  assert.equal(v.unverified, 'нужен логин');
  assert.deepEqual(v.blocking, []);
  assert.equal(v.notes[0].message, 'нет входа');
});

test('сбои: приложение не поднялось, ответ не JSON', unix, async (t) => {
  const down = setup(t, () => '{}', 'echo упало; exit 4');
  await assert.rejects(stageVisual(down.k, down.run), /завершилось с кодом 4/);
  assert.equal(down.prompts.length, 0, 'агента не запускали');
  const bad = setup(t, () => 'просто текст');
  await assert.rejects(stageVisual(bad.k, bad.run), /не в формате JSON/);
});

test('самопроверка исполнителя: только с визуальной проверкой; codex — через браузер снаружи, кроме Windows', () => {
  const base = {
    visual: true,
    runCommand: 'npm run dev',
    appUrl: 'http://localhost:{port}',
    agents: { executor: 'claude' },
  } as unknown as RunFile;
  assert.equal(selfCheckReason(base), 'on');
  assert.equal(selfCheckReason({ ...base, visual: false }), 'off');
  assert.equal(selfCheckReason({ ...base, appUrl: '' }), 'off');
  const codex = { ...base, agents: { executor: 'codex' } } as never;
  assert.equal(selfCheckReason(codex, 'darwin'), 'codex');
  assert.equal(selfCheckReason(codex, 'linux'), 'codex');
  assert.equal(selfCheckReason(codex, 'win32'), 'codex-win');
});

test('самопроверка исполнителя: приложение в фоне, pw в PATH, адрес в промпте; stop гасит сервер', unix, async (t) => {
  const { k, run } = setup(t, () => '');
  const self = (await startSelfCheck(k, run, 1))!;
  assert.ok(self);
  const url = /на (http:\/\/127\.0\.0\.1:\d+\/)/.exec(self.block)![1];
  assert.match(self.block, /Самопроверка в браузере/);
  const dir = self.env.PATH!.split(path.delimiter)[0];
  assert.ok(fs.existsSync(path.join(dir, 'pw')), 'обёртка pw — первой в PATH');
  assert.ok(dir.includes(path.join('visual', run.id, 'self-1')));
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    up = await fetch(url).then(
      (r) => r.ok,
      () => false,
    );
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(up, 'приложение поднялось');
  await self.stop();
  await assert.rejects(fetch(url), 'сервер погашен');

  assert.match(self.block, /pw open http/, 'не codex — браузер открывает сам');
});
