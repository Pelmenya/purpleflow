#!/usr/bin/env node
// Выпуск версии: npm run release -- 0.2.0
// Поднимает версию, коммитит и ставит тег; по тегу CI собирает все ОС и кладёт их в черновик релиза на GitHub.
// Пользователи получат обновление, когда черновик опубликован: это и есть последняя проверка человеком.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? '')) {
  console.error('Укажите версию: npm run release -- 0.2.0');
  process.exit(1);
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

if (git('status', '--porcelain')) fail('В рабочей копии есть незакоммиченные изменения.');
if (git('branch', '--show-current') !== 'main') fail('Выпускать можно только из main.');
git('fetch', 'origin', 'main', '--tags');
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) fail('main расходится с origin/main.');
if (git('tag', '--list', version)) fail(`Тег ${version} уже есть.`);

// Установщик выходит в тех же релизах, что и PurpleFlow, поэтому версия у них общая.
const PACKAGES = ['package.json', 'app/package.json', 'core/package.json', 'installer/package.json'];
for (const file of PACKAGES) {
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}
execFileSync('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund', '--ignore-scripts'], { stdio: 'inherit' });

git('add', ...PACKAGES, 'package-lock.json');
git('commit', '-m', `Версия ${version}`);
git('tag', version);
git('push', 'origin', 'main', version);
console.log(`Тег ${version} отправлен. Когда CI соберёт черновик релиза, опубликуйте его на GitHub.`);
