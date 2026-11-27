// Pull Request: настоящий git с локальным bare-remote в каталоге github.com и фейковый gh в PATH.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Kernel } from './kernel.js';
import { detectProjectForge, getProjectConfig, saveProjectConfig } from './services/projects.js';
import { getDiff, getChangedFiles } from './services/runs.js';
import {
  getPrDetails,
  getPrStatus,
  listBranches,
  merge,
  mergePrOf,
  openPr,
  prBody,
  prFollowup,
  prReady,
  updateBranch,
} from './services/pr.js';
import type { CoreSettings, PrFollowupItem, RunFile } from './types.js';

const unix = { skip: process.platform === 'win32' };
const URL_ = 'https://github.com/acme/app/pull/7';

const prJson = (over: object = {}) =>
  JSON.stringify({
    number: 7,
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: '',
    statusCheckRollup: [
      { status: 'COMPLETED', conclusion: 'FAILURE', name: 'test', detailsUrl: 'https://github.com/acme/app/actions/runs/1/job/2' },
    ],
    mergeCommit: null,
    url: URL_,
    ...over,
  });

function setup(t: { after: (fn: () => void) => void }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-pr-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'github.com', 'acme', 'app.git');
  const repo = path.join(root, 'repo');
  const wt = path.join(root, 'wt');
  fs.mkdirSync(remote, { recursive: true });
  fs.mkdirSync(repo);
  const at =
    (cwd: string) =>
    (...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd })
        .toString()
        .trim();
  const g = at(repo);
  at(remote)('init', '-q', '--bare', '-b', 'main');
  g('init', '-q', '-b', 'main');
  // Адрес origin — настоящий (по нему определяется провайдер), а push уходит в локальный bare-remote.
  g('remote', 'add', 'origin', 'https://github.com/acme/app.git');
  g('config', 'remote.origin.pushurl', remote);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  g('push', '-q', 'origin', 'main');
  const baseCommit = g('rev-parse', 'HEAD');
  g('worktree', 'add', '-q', '-b', 'purpleflow/x', wt);
  fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n');
  at(wt)('add', '-A');
  at(wt)('commit', '-qm', 'задача');

  // gh отвечает по команде; ответ на pr view берёт из файла, чтобы тест мог менять состояние PR.
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const view = path.join(root, 'view.json');
  const calls = path.join(root, 'calls');
  const graphql = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          title: 'Заголовок',
          reviews: { nodes: [] },
          comments: { nodes: [{ id: 'c1', author: { login: 'ann' }, body: 'Поправь', createdAt: '2026-01-01T00:00:00Z', url: 'u' }] },
          reviewThreads: { nodes: [] },
        },
      },
    },
  });
  fs.writeFileSync(view, prJson());
  fs.writeFileSync(path.join(root, 'graphql.json'), graphql);
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/sh
echo "$*" >> "${calls}"
[ -n "$GITLAB_TOKEN" ] && echo leaked >> "${calls}-leak"
case "$1 $2" in
  "pr create") echo "${URL_}" ;;
  "pr view") cat "${view}" ;;
  "api graphql") cat "${root}/graphql.json" ;;
  "run view") printf 'job\\tstep\\t2026-01-01T00:00:00.000Z упал тест\\n' ;;
esac
`,
    { mode: 0o755 },
  );
  const settings = { toolPaths: {} } as unknown as CoreSettings;
  const k = new Kernel({
    dataDir: path.join(root, 'data'),
    promptsDir: root,
    // Origin некоторых тестов — настоящий адрес gitlab.com: без этого git на машине с терминалом
    // спрашивает логин и вешает прогон, а в CI без терминала просто падает.
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GIT_TERMINAL_PROMPT: '0' },
    getSettings: () => settings,
  });
  const drives: RunFile[] = [];
  k.engine = { drive: async (r: RunFile) => void drives.push(r) } as never;
  const run = {
    id: 'run-1',
    title: 'Заголовок',
    task: 'Сделай b',
    changeId: 'c',
    mode: 'task',
    status: 'finished',
    next: 'finish',
    workspace: 'worktree',
    projectPath: repo,
    worktreePath: wt,
    branch: 'purpleflow/x',
    baseBranch: 'main',
    baseCommit,
    agents: { reviewer: 'codex' },
    models: {},
    attempts: [],
    tests: [],
    reviews: [],
    implAttemptsUsed: 1,
    createdAt: '2026-01-01',
  } as unknown as RunFile;
  k.store.save(run);
  return {
    k,
    g,
    root,
    bin,
    at,
    gw: at(wt),
    wt,
    repo,
    remoteGit: at(remote),
    calls: () => fs.readFileSync(calls, 'utf8').trim().split('\n'),
    setView: (over: object) => fs.writeFileSync(view, prJson(over)),
    drives,
    withPr: () => k.store.save({ ...k.mustLoad('run-1'), pr: { url: URL_, number: 7, base: 'main', createdAt: '2026-01-01' } }),
  };
}

test('openPr: ветка на origin, описание из прогона, повторно нельзя', unix, async (t) => {
  const { k, remoteGit, calls } = setup(t);
  assert.equal(await prReady(k, 'run-1'), null);
  await assert.rejects(openPr(k, 'run-1', '  '), /Выберите ветку/);
  await openPr(k, 'run-1', 'main');
  const r = k.mustLoad('run-1');
  assert.deepEqual([r.pr?.url, r.pr?.number, r.pr?.base], [URL_, 7, 'main']);
  assert.deepEqual([r.pr?.kind, r.pr?.host], ['github', 'github.com'], 'провайдер записан в прогон');
  assert.ok(remoteGit('rev-parse', 'purpleflow/x'), 'ветка отправлена');
  assert.ok(calls().some((c) => c.startsWith('pr create') && c.includes('--head purpleflow/x')));
  await assert.rejects(openPr(k, 'run-1', 'main'), /уже открыт/);
  assert.ok(!fs.readdirSync(os.tmpdir()).includes('purpleflow-pr-run-1.md'), 'временное описание убрано');
});

test('openPr: только для завершённого прогона', unix, async (t) => {
  const { k } = setup(t);
  k.store.save({ ...k.mustLoad('run-1'), status: 'running' });
  await assert.rejects(openPr(k, 'run-1', 'main'), /завершённого/);
});

test('prBody: собирает то, что есть, и пропускает пустое', unix, async (t) => {
  const { k } = setup(t);
  const r = k.mustLoad('run-1');
  const empty = await prBody(k, r);
  assert.match(empty, /## Задача\n\nСделай b/);
  assert.doesNotMatch(empty, /## Ревью|## Проверки|## Визуальная/);
  const full = await prBody(k, {
    ...r,
    attempts: [{ stage: 'implement', attempt: 1, startedAt: '', status: 'done', output: 'Добавил b' }],
    tests: [{ checks: [{ kind: 'test', command: 'npm test', passed: true }] }],
    reviews: [{ at: '', blocking: [], notes: [{ file: 'b.txt', line: 2, message: 'заметка' }] }],
    visuals: [{ blocking: [], notes: [], shots: [{ caption: 'Главная', file: 'x.png' }] }],
  } as unknown as RunFile);
  assert.match(full, /## Что сделано\n\nДобавил b/);
  assert.match(full, /Тесты: ✅ `npm test`/);
  assert.match(full, /Блокирующих замечаний нет[\s\S]*`b\.txt:2` — заметка/);
  assert.match(full, /Главная/);
});

test('статус и детали: упавшие проверки — среди замечаний, влитый на GitHub PR отмечается у прогона', unix, async (t) => {
  const { k, withPr, setView } = setup(t);
  assert.equal(await getPrStatus(k, 'run-1'), null, 'без PR');
  withPr();
  const d = await getPrDetails(k, 'run-1');
  assert.equal(d?.title, 'Заголовок');
  assert.deepEqual(
    d?.comments.map((c) => c.kind),
    ['check', 'comment'],
  );
  assert.equal(k.mustLoad('run-1').merged, undefined);
  setView({ state: 'MERGED', mergeCommit: { oid: 'abc' } });
  await getPrStatus(k, 'run-1');
  assert.deepEqual([k.mustLoad('run-1').merged?.into, k.mustLoad('run-1').merged?.commit], ['main', 'abc']);
});

test('mergePrOf: без PR — ошибка; с PR — слияние через gh', unix, async (t) => {
  const { k, withPr, calls, setView } = setup(t);
  await assert.rejects(mergePrOf(k, 'run-1'), /нет PR/);
  withPr();
  setView({ state: 'MERGED' });
  await mergePrOf(k, 'run-1');
  assert.ok(calls().includes(`pr merge ${URL_} --merge`));
  assert.ok(k.mustLoad('run-1').merged);
});

test('prFollowup: новый круг с логом упавшей проверки; условия запуска', unix, async (t) => {
  const { k, withPr, drives } = setup(t);
  const items: PrFollowupItem[] = [
    { id: '1', kind: 'check', author: 'CI', body: 'test', at: '', url: 'https://github.com/acme/app/actions/runs/1/job/2' },
    { id: '2', kind: 'thread', author: 'ann', body: 'Поправь', at: '', path: 'b.txt', line: 1 },
  ] as unknown as PrFollowupItem[];
  await assert.rejects(prFollowup(k, 'run-1', items), /нет PR/);
  withPr();
  await assert.rejects(prFollowup(k, 'run-1', []), /Выберите замечания/);
  await prFollowup(k, 'run-1', items, 'и ещё вот это');
  const r = k.mustLoad('run-1');
  assert.deepEqual([r.status, r.next, r.prRound, r.implAttemptsLimit], ['running', 'implement', 2, 4]);
  assert.match(r.feedback!.text, /Упала проверка CI «test»[\s\S]*упал тест/);
  assert.match(r.feedback!.text, /b\.txt:1 — @ann: Поправь/);
  assert.match(r.feedback!.text, /и ещё вот это/);
  assert.equal(drives.length, 1);
  await assert.rejects(prFollowup(k, 'run-1', items), /когда прогон завершён/);
});

test('prFollowup: удалённую при уборке копию создаёт заново', unix, async (t) => {
  const { k, withPr, wt, g } = setup(t);
  withPr();
  g('worktree', 'remove', '--force', wt);
  k.store.save({ ...k.mustLoad('run-1'), worktreeRemoved: true });
  await prFollowup(k, 'run-1', [], 'доработай');
  assert.ok(fs.existsSync(path.join(wt, 'b.txt')));
  assert.equal(k.mustLoad('run-1').worktreeRemoved, undefined);
});

test('updateBranch без конфликтов: дальше проверки, дифф прогона не включает влитое из базы', unix, async (t) => {
  const { k, withPr, g, drives } = setup(t);
  withPr();
  // updateBranch делает fetch: подставляем локальный remote вместо адреса на публичном хосте.
  g('remote', 'set-url', 'origin', g('config', 'remote.origin.pushurl'));
  await assert.rejects(updateBranch(k, 'run-1'), /уже содержит всё/);

  fs.writeFileSync(path.join(k.mustLoad('run-1').projectPath, 'c.txt'), 'из базы\n');
  g('add', '-A');
  g('commit', '-qm', 'новое в main');
  g('push', '-q', 'origin', 'main');
  await updateBranch(k, 'run-1');
  const r = k.mustLoad('run-1');
  assert.deepEqual([r.status, r.next, r.mergeOnly, r.prRound], ['running', 'tests', true, 2]);
  assert.equal(r.diffFrom, g('rev-parse', 'main'));
  assert.equal(r.prRounds?.at(-1)?.kind, 'update');
  assert.equal(drives.length, 1);

  // Завершили круг: в диффе только работа задачи.
  k.store.save({ ...r, status: 'finished' });
  assert.deepEqual(
    (await getDiff(k, 'run-1')).map((f) => f.path),
    ['b.txt'],
  );
  assert.deepEqual(await getChangedFiles(k, 'run-1'), ['b.txt']);
});

test('updateBranch с конфликтом: разрешать будет исполнитель', unix, async (t) => {
  const { k, withPr, g, gw, wt } = setup(t);
  withPr();
  // updateBranch делает fetch: подставляем локальный remote вместо адреса на публичном хосте.
  g('remote', 'set-url', 'origin', g('config', 'remote.origin.pushurl'));
  fs.writeFileSync(path.join(wt, 'a.txt'), 'из задачи\n');
  gw('add', '-A');
  gw('commit', '-qm', 'правка a');
  fs.writeFileSync(path.join(k.mustLoad('run-1').projectPath, 'a.txt'), 'из базы\n');
  g('add', '-A');
  g('commit', '-qm', 'новое в main');
  g('push', '-q', 'origin', 'main');
  await updateBranch(k, 'run-1');
  const r = k.mustLoad('run-1');
  assert.deepEqual([r.next, r.roundFiles, r.prRounds?.at(-1)?.conflicts], ['implement', ['a.txt'], ['a.txt']]);
  assert.match(r.feedback!.text, /в файлах конфликты/);
  assert.match(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8'), /<<<<<<</);
});

test('merge и listBranches: своя ветка не предлагается, результат записан', unix, async (t) => {
  const { k, g, repo } = setup(t);
  const list = await listBranches(k, 'run-1');
  assert.deepEqual([list.branches, list.suggested], [['main'], 'main']);
  await assert.rejects(merge(k, 'run-1', ' '), /Выберите ветку/);
  await merge(k, 'run-1', 'main');
  assert.equal(k.mustLoad('run-1').merged?.commit, g('rev-parse', 'main'));
  assert.ok(fs.existsSync(path.join(repo, 'b.txt')));
});

test('merge в режиме «Ветка»: проект уходит с ветки прогона на ту, куда влили; с правками — остаётся', unix, async (t) => {
  const { k, g, repo } = setup(t);
  // Режим «Ветка»: проект сам стоит на ветке прогона (копию убираем, ветку открываем в проекте).
  g('worktree', 'remove', '--force', path.join(path.dirname(repo), 'wt'));
  g('checkout', '-q', 'purpleflow/x');
  k.store.save({ ...k.mustLoad('run-1'), workspace: 'branch', worktreePath: repo });
  await merge(k, 'run-1', 'main');
  assert.equal(g('branch', '--show-current'), 'main');
  assert.ok(fs.existsSync(path.join(repo, 'b.txt')));

  // Правки в рабочей копии — не переключаем.
  g('checkout', '-q', 'purpleflow/x');
  fs.appendFileSync(path.join(repo, 'a.txt'), 'правка\n');
  g('branch', 'dev', 'main');
  k.store.save({ ...k.mustLoad('run-1'), merged: undefined });
  await merge(k, 'run-1', 'dev');
  assert.equal(g('branch', '--show-current'), 'purpleflow/x');
});

test('старый прогон с pr без kind обрабатывается как GitHub', unix, async (t) => {
  const { k, withPr, calls } = setup(t);
  withPr();
  assert.equal(k.mustLoad('run-1').pr?.kind, undefined);
  assert.equal((await getPrStatus(k, 'run-1'))?.number, 7);
  await mergePrOf(k, 'run-1');
  assert.ok(calls().includes(`pr merge ${URL_} --merge`));
});

test('prReady: неподтверждённый хост — причина с подсказкой про локальное слияние', unix, async (t) => {
  const { k, g, repo } = setup(t);
  g('remote', 'set-url', 'origin', 'git@git.company.ru:team/app.git');
  const why = await prReady(k, 'run-1');
  assert.match(why ?? '', /git\.company\.ru не настроен/);
  assert.match(why ?? '', /локально/);
  await assert.rejects(openPr(k, 'run-1', 'main'), /не настроен/);
  assert.ok(repo);
});

// GitLab: тот же прогон, но origin — bare-remote в каталоге gitlab.com, а в PATH фейковый glab.
function setupGitlab(t: { after: (fn: () => void) => void }) {
  const s = setup(t);
  const remote = path.join(s.root, 'gitlab.com', 'acme', 'app.git');
  fs.mkdirSync(remote, { recursive: true });
  s.at(remote)('init', '-q', '--bare', '-b', 'main');
  s.g('remote', 'set-url', 'origin', 'https://gitlab.com/acme/app.git');
  s.g('config', 'remote.origin.pushurl', remote);
  s.g('push', '-q', 'origin', 'main');
  const mr = path.join(s.root, 'mr.json');
  const jobs = path.join(s.root, 'jobs.json');
  const MR_URL = 'https://gitlab.com/acme/app/-/merge_requests/3';
  const mrJson = (over: object = {}) =>
    JSON.stringify({
      iid: 3,
      title: 'MR',
      web_url: MR_URL,
      state: 'opened',
      detailed_merge_status: 'mergeable',
      head_pipeline: { id: 1 },
      ...over,
    });
  fs.writeFileSync(mr, mrJson());
  fs.writeFileSync(jobs, JSON.stringify([{ id: 9, name: 'test', status: 'failed', web_url: 'https://gitlab.com/acme/app/-/jobs/9' }]));
  fs.writeFileSync(
    path.join(s.root, 'discussions.json'),
    JSON.stringify([
      {
        id: 'd1',
        individual_note: true,
        notes: [{ id: 1, body: 'Поправь', author: { username: 'ann' }, created_at: '2026-01-01T00:00:00Z' }],
      },
    ]),
  );
  const calls = path.join(s.root, 'glab-calls');
  fs.writeFileSync(
    path.join(s.bin, 'glab'),
    `#!/bin/sh
echo "$*" >> "${calls}"
case "$*" in
  *"auth status"*) ;;
  *"-X POST"*merge_requests*) echo '{"web_url":"${MR_URL}","iid":3}' ;;
  *"-X PUT"*"/merge"*) echo '{}' ;;
  *"/jobs/9/trace"*) printf 'упал тест\\n' ;;
  *"pipelines/1/jobs"*) cat "${jobs}" ;;
  *"/discussions"*) cat "${s.root}/discussions.json" ;;
  *merge_requests/3*) cat "${mr}" ;;
esac
`,
    { mode: 0o755 },
  );
  return {
    ...s,
    MR_URL,
    leaked: () => fs.existsSync(`${calls}-leak`),
    glabCalls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : []),
    setMr: (over: object) => fs.writeFileSync(mr, mrJson(over)),
    withMr: () =>
      s.k.store.save({
        ...s.k.mustLoad('run-1'),
        pr: { url: MR_URL, number: 3, base: 'main', createdAt: '2026-01-01', kind: 'gitlab', host: 'gitlab.com' },
      }),
  };
}

test('GitLab: openPr создаёт MR и пишет провайдера в прогон', unix, async (t) => {
  const { k, glabCalls, MR_URL } = setupGitlab(t);
  assert.equal(await prReady(k, 'run-1'), null);
  await openPr(k, 'run-1', 'main');
  const r = k.mustLoad('run-1');
  assert.deepEqual([r.pr?.url, r.pr?.number, r.pr?.kind, r.pr?.host], [MR_URL, 3, 'gitlab', 'gitlab.com']);
  assert.ok(
    glabCalls().some(
      (c) => c.includes('--hostname gitlab.com') && c.includes('projects/acme%2Fapp/merge_requests') && c.includes('-X POST'),
    ),
  );
});

test('GitLab: упавший job — в замечаниях, followup получает хвост лога, слияние отмечает прогон', unix, async (t) => {
  const { k, withMr, setMr, drives, glabCalls } = setupGitlab(t);
  withMr();
  const d = await getPrDetails(k, 'run-1');
  assert.deepEqual(
    d?.comments.map((c) => c.kind),
    ['check', 'comment'],
  );
  assert.equal(d?.status.failedChecks?.[0].url, 'https://gitlab.com/acme/app/-/jobs/9');
  const items = [
    { id: '1', kind: 'check', author: 'CI', body: 'test', at: '', url: 'https://gitlab.com/acme/app/-/jobs/9' },
  ] as unknown as PrFollowupItem[];
  await prFollowup(k, 'run-1', items);
  assert.match(k.mustLoad('run-1').feedback!.text, /Упала проверка CI «test»[\s\S]*упал тест/);
  assert.equal(drives.length, 1);

  k.store.save({ ...k.mustLoad('run-1'), status: 'finished' });
  setMr({ state: 'merged', merge_commit_sha: 'abc' });
  await mergePrOf(k, 'run-1');
  assert.ok(glabCalls().some((c) => c.includes('-X PUT') && c.endsWith('/merge')));
  assert.deepEqual([k.mustLoad('run-1').merged?.into, k.mustLoad('run-1').merged?.commit], ['main', 'abc']);
});

test('два проекта на разных self-hosted хостах: каждый вызов glab несёт свой --hostname', unix, async (t) => {
  const { k, g, repo, root: dir, at, glabCalls } = setupGitlab(t);
  const repo2 = path.join(dir, 'repo2');
  fs.mkdirSync(repo2);
  at(repo2)('init', '-q', '-b', 'main');
  at(repo2)('remote', 'add', 'origin', 'git@git.beta.ru:team/other.git');
  g('remote', 'set-url', 'origin', 'git@git.alpha.ru:team/app.git');
  k.store.writeProject(repo, { forge: { kind: 'gitlab', host: 'git.alpha.ru' } } as never);
  k.store.writeProject(repo2, { forge: { kind: 'gitlab', host: 'git.beta.ru' } } as never);
  k.store.save({ ...k.mustLoad('run-1'), id: 'run-2', projectPath: repo2 });
  assert.equal(await prReady(k, 'run-1'), null);
  assert.equal(await prReady(k, 'run-2'), null);
  const calls = glabCalls();
  assert.ok(calls.includes('auth status --hostname git.alpha.ru'));
  assert.ok(calls.includes('auth status --hostname git.beta.ru'));
});

test('GitLab: неподтверждённый хост — причина, локальное слияние работает', unix, async (t) => {
  const { k, g } = setupGitlab(t);
  g('remote', 'set-url', 'origin', 'git@gitlab.company.ru:team/app.git');
  assert.match((await prReady(k, 'run-1')) ?? '', /gitlab\.company\.ru не настроен/);
  await assert.rejects(openPr(k, 'run-1', 'main'), /не настроен/);
  g('remote', 'set-url', 'origin', 'https://gitlab.com/acme/app.git');
  await merge(k, 'run-1', 'main');
  assert.ok(k.mustLoad('run-1').merged);
});

const baseCfg = { setupCommand: '', lintCommand: '', testCommand: '', notes: { setup: '', lint: '', test: '' } };

test('saveProjectConfig: провайдер — нормализация хоста, undefined сохраняет прежнее, null сбрасывает', unix, async (t) => {
  const { k, repo } = setup(t);
  assert.equal(getProjectConfig(k, repo)?.forge, undefined);
  saveProjectConfig(k, repo, { ...baseCfg, forge: { kind: 'gitlab', host: ' https://GitLab.Company.ru/ ' } });
  assert.deepEqual(getProjectConfig(k, repo)?.forge, { kind: 'gitlab', host: 'gitlab.company.ru' });
  // Сохранение команд без forge (старое окно, правка команд) подтверждённый провайдер не стирает.
  saveProjectConfig(k, repo, { ...baseCfg, testCommand: 'npm test' });
  assert.deepEqual(getProjectConfig(k, repo)?.forge, { kind: 'gitlab', host: 'gitlab.company.ru' });
  assert.equal(getProjectConfig(k, repo)?.testCommand, 'npm test');
  // Пустой хост — ошибка, сохранённый провайдер остаётся.
  assert.throws(() => saveProjectConfig(k, repo, { ...baseCfg, forge: { kind: 'gitlab', host: 'https://' } }), /хост/);
  assert.deepEqual(getProjectConfig(k, repo)?.forge, { kind: 'gitlab', host: 'gitlab.company.ru' });
  saveProjectConfig(k, repo, { ...baseCfg, forge: { kind: 'github', host: 'github.com' } });
  saveProjectConfig(k, repo, { ...baseCfg, forge: null });
  assert.equal(getProjectConfig(k, repo)?.forge, undefined);
});

test('старые настройки проекта без forge читаются, провайдер определяется по origin', unix, async (t) => {
  const { k, repo } = setup(t);
  k.store.writeProject(repo, { ...baseCfg, updatedAt: '2025-01-01T00:00:00.000Z' });
  assert.equal(getProjectConfig(k, repo)?.forge, undefined);
  const d = await detectProjectForge(k, repo);
  assert.equal(d.saved, null);
  assert.equal(d.confirmed, true);
  assert.deepEqual(d.suggested, { kind: 'github', host: 'github.com' });
});

test('detectProjectForge: gitlab.com подтверждён, self-hosted — предложение, неизвестный хост — без предложения', unix, async (t) => {
  const { k, g, repo } = setup(t);
  g('remote', 'set-url', 'origin', 'https://gitlab.com/a/b.git');
  let d = await detectProjectForge(k, repo);
  assert.deepEqual(d.suggested, { kind: 'gitlab', host: 'gitlab.com' });
  assert.equal(d.confirmed, true);
  g('remote', 'set-url', 'origin', 'git@gitlab.company.ru:a/b.git');
  d = await detectProjectForge(k, repo);
  assert.deepEqual(d.suggested, { kind: 'gitlab', host: 'gitlab.company.ru' });
  assert.equal(d.confirmed, false);
  assert.equal(d.remote, 'git@gitlab.company.ru:a/b.git');
  g('remote', 'set-url', 'origin', 'git@git.company.ru:a/b.git');
  d = await detectProjectForge(k, repo);
  assert.equal(d.suggested, null);
  assert.equal(d.host, 'git.company.ru');
  saveProjectConfig(k, repo, { ...baseCfg, forge: { kind: 'gitlab', host: 'git.company.ru' } });
  assert.deepEqual((await detectProjectForge(k, repo)).saved, { kind: 'gitlab', host: 'git.company.ru' });
});

test(
  'GitLab: два инстанса одновременно — статусы не смешиваются, у каждого свой --hostname, глобальные токены не передаются',
  unix,
  async (t) => {
    const { k, root: dir, MR_URL, glabCalls, leaked } = setupGitlab(t);
    const run1 = k.mustLoad('run-1');
    k.store.save({ ...run1, pr: { url: MR_URL, number: 3, base: 'main', createdAt: '', kind: 'gitlab', host: 'git.alpha.ru' } });
    k.store.save({
      ...run1,
      id: 'run-2',
      pr: {
        url: 'https://git.beta.ru/team/x/-/merge_requests/3',
        number: 3,
        base: 'main',
        createdAt: '',
        kind: 'gitlab',
        host: 'git.beta.ru',
      },
    });
    // Настройки проекта поменялись после создания MR — статус всё равно у хоста из run.pr.
    k.store.writeProject(run1.projectPath, { forge: { kind: 'gitlab', host: 'git.beta.ru' } } as never);
    const prev = process.env.GITLAB_TOKEN;
    k.opts.env.GITLAB_TOKEN = 'secret-for-gitlab-com';
    try {
      const [a, b] = await Promise.all([getPrStatus(k, 'run-1'), getPrStatus(k, 'run-2')]);
      assert.equal(a?.url, MR_URL);
      assert.ok(b);
    } finally {
      delete k.opts.env.GITLAB_TOKEN;
      if (prev !== undefined) process.env.GITLAB_TOKEN = prev;
    }
    const calls = glabCalls().filter((c) => c.startsWith('api'));
    assert.ok(calls.some((c) => c.includes('--hostname git.alpha.ru')));
    assert.ok(calls.some((c) => c.includes('--hostname git.beta.ru')));
    assert.ok(calls.every((c) => c.includes('--hostname git.alpha.ru') || c.includes('--hostname git.beta.ru')));
    assert.ok(!calls.some((c) => c.includes('gitlab.com') && c.includes('--hostname gitlab.com')));
    assert.equal(leaked(), false, 'GITLAB_TOKEN не должен доходить до glab');
    void dir;
  },
);

test('GitLab: хост в настройках не совпадает с origin — причина, MR не создаётся', unix, async (t) => {
  const { k, g, repo } = setupGitlab(t);
  g('remote', 'set-url', 'origin', 'git@gitlab.beta.ru:team/app.git');
  k.store.writeProject(repo, { forge: { kind: 'gitlab', host: 'gitlab.alpha.ru' } } as never);
  assert.match((await prReady(k, 'run-1')) ?? '', /gitlab\.beta\.ru.*не совпадает.*gitlab\.alpha\.ru/);
  await assert.rejects(openPr(k, 'run-1', 'main'), /не совпадает/);
});

test('GitLab: слияние fast-forward без merge_commit_sha — коммит берётся из sha', unix, async (t) => {
  const { k, withMr, setMr } = setupGitlab(t);
  withMr();
  k.store.save({ ...k.mustLoad('run-1'), status: 'finished' });
  setMr({ state: 'merged', merge_commit_sha: null, squash_commit_sha: null, sha: 'ff00ff' });
  await mergePrOf(k, 'run-1');
  assert.equal(k.mustLoad('run-1').merged?.commit, 'ff00ff');
});
