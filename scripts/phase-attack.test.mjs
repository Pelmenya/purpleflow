import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test(
  'боевой старт отклоняет пропущенную атаку и изменённую карточку; закрытие проверенной карточки допускается',
  { skip: process.platform === 'win32' },
  (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'phase-attack-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const put = (name, text) => writeFileSync(path.join(dir, name), text);
    const folder = '.claude/local/attacks/f1';
    for (const d of ['scripts', '.claude/ralph', folder]) mkdirSync(path.join(dir, d), { recursive: true });
    cpSync(new URL('./phase-attack.mjs', import.meta.url), path.join(dir, 'scripts/phase-attack.mjs'));
    cpSync(new URL('../ralph', import.meta.url), path.join(dir, 'ralph'));
    const title = 'Ralph · Ф1: Обзор';
    const body = 'Результат\n\n## Предпосылки\nНет';
    const issue = { number: 2, state: 'open', milestone: { title }, body };
    const cfg = { defaultProfile: 'empty', common: { phases: [] }, profiles: { chosen: { phases: [{ milestone: title }] }, empty: {} } };
    put('.claude/ralph/ralph.config.json', JSON.stringify(cfg));
    put('issues.json', JSON.stringify([[issue]]));
    put('gh', `#!/bin/sh\ncase "$*" in *milestones/1) echo '${JSON.stringify([{ title }])}' ;; *) cat issues.json ;; esac\n`);
    chmodSync(path.join(dir, 'gh'), 0o755);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'commit', '--allow-empty', '-qm', 'base'], { cwd: dir });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: dir });
    const execute = (command, args) =>
      spawnSync(command, args, { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: dir + ':' + process.env.PATH } });
    const check = () => execute(process.execPath, ['scripts/phase-attack.mjs', 'check', '--profile=chosen']);
    const start = execute('sh', ['ralph', 'start', '--profile=chosen']);
    assert.equal(start.status, 1);
    assert.match(start.stderr, /stamp.json/);
    put(folder + '/card-2.md', body);
    put(folder + '/triage.md', '#2 рассмотрена');
    put(folder + '/attack-2.txt', 'Разбор попытки');
    const stamp = () => execute(process.execPath, ['scripts/phase-attack.mjs', 'stamp', '1']);
    assert.notEqual(stamp().status, 0);
    put(folder + '/attack-comp.txt', 'Разбор стыков');
    assert.equal(stamp().status, 0);
    assert.equal(check().status, 0);
    issue.state = 'closed';
    put('issues.json', JSON.stringify([[issue]]));
    assert.equal(check().status, 0);
    issue.body += ' Изменение';
    put('issues.json', JSON.stringify([[issue]]));
    assert.notEqual(check().status, 0);
    assert.ok(readFileSync(path.join(dir, folder, 'stamp.json'), 'utf8').includes(title));
  },
);
