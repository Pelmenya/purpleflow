#!/usr/bin/env node
// Сборка пакетов установщика: node scripts/dist.mjs [аргументы electron-builder]
// Для Linux название приложения при сборке латинское — «PurpleFlow Installer»: из него electron-builder делает
// папку установки (/opt/<название>) и пути в скриптах deb и профиле AppArmor. Кириллица и пробел там — лишний риск,
// а в меню приложений название остаётся русским (linux.desktop.entry.Name в electron-builder.yml).
// На macOS и Windows приложение называется «Установщик PurpleFlow», как в package.json.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const explicit = ['--mac', '-m', '--win', '-w', '--linux', '-l'].filter((f) => args.includes(f));
const linux = explicit.length ? args.includes('--linux') || args.includes('-l') : process.platform === 'linux';
const extra = linux ? ['-c.productName=PurpleFlow Installer'] : [];

execFileSync('npx', ['electron-builder', ...args, ...extra], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
