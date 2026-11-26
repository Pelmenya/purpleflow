#!/usr/bin/env node
// Установщик для macOS — в релиз текущей версии: npm run release:mac -w @purpleflow/installer
// Как и PurpleFlow для macOS, собирается локально: нужен сертификат «Developer ID Application» в связке ключей
// и данные для нотаризации (APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER или APPLE_ID +
// APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID). Windows и Linux собирает CI по тегу (.github/workflows/release.yml).
// Флаг --no-upload: только собрать и проверить, в релиз не загружать.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upload = !process.argv.includes('--no-upload');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: dir, stdio: 'inherit', ...opts });
const out = (cmd, args) => execFileSync(cmd, args, { cwd: dir, encoding: 'utf8' }).trim();
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

if (process.platform !== 'darwin') fail('Установщик для macOS собирается только на Mac.');
const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;

if (upload) {
  // Релиз (обычно ещё черновик) создаёт CI по тегу. Нет его — значит, тег не выпущен или CI ещё не дошёл.
  try {
    out('gh', ['release', 'view', version, '--json', 'tagName']);
  } catch {
    fail(`Релиза ${version} нет на GitHub. Сначала npm run release -- ${version} и дождитесь черновика от CI.`);
  }
}

fs.rmSync(path.join(dir, 'release'), { recursive: true, force: true });
run('npx', ['electron-vite', 'build']);
run('node', ['scripts/dist.mjs', '--mac', '--publish', 'never']);

const dmg = path.join(dir, 'release', 'PurpleFlow-Installer.dmg');
if (!fs.existsSync(dmg)) fail(`Не найден ${dmg}`);
const app = fs
  .readdirSync(path.join(dir, 'release'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.startsWith('mac'))
  .flatMap((d) =>
    fs
      .readdirSync(path.join(dir, 'release', d.name))
      .filter((f) => f.endsWith('.app'))
      .map((f) => path.join(dir, 'release', d.name, f)),
  )[0];
if (!app) fail('Не найдено собранное приложение в release/mac*');

// Неподписанный или ненотаризованный установщик Gatekeeper не откроет — такой в релиз не кладём.
run('codesign', ['--verify', '--deep', '--strict', app]);
run('spctl', ['--assess', '--type', 'execute', '--verbose', app]);

if (upload) {
  run('gh', ['release', 'upload', version, dmg, '--clobber']);
  console.log(`PurpleFlow-Installer.dmg загружен в релиз ${version}.`);
} else {
  console.log(`Собран и проверен ${dmg}; в релиз не загружался (--no-upload).`);
}
