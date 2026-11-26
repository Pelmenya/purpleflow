#!/usr/bin/env node
// Сборка whisper-cli (whisper.cpp) для диктовки: из исходников ggml-org с зафиксированной версией.
// Результат — app/whisper-bin/<os>/whisper-cli[.exe]; electron-builder кладёт его в ресурсы приложения.
// macOS — универсальный бинарник (arm64 + x86_64) с Metal; Windows — x64 (на ARM запускается в эмуляции); Linux — x64.
// Уже собранный той же версии не пересобирается.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 'v1.9.6';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OS = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform];
if (!OS) throw new Error(`Платформа ${process.platform} не поддерживается`);
const exe = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
const outDir = path.join(ROOT, 'app', 'whisper-bin', OS);
const stamp = path.join(outDir, 'VERSION');

if (fs.existsSync(path.join(outDir, exe)) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === VERSION) {
  console.log(`whisper-cli ${VERSION} уже собран: ${outDir}`);
  process.exit(0);
}

const work = path.join(os.tmpdir(), `purpleflow-whisper-${VERSION}`);
const src = path.join(work, `whisper.cpp-${VERSION.slice(1)}`);
const run = (cmd, args, cwd = work) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

fs.mkdirSync(work, { recursive: true });
if (!fs.existsSync(src)) {
  const tar = path.join(work, 'src.tar.gz');
  console.log(`Скачиваю whisper.cpp ${VERSION}…`);
  const res = await fetch(`https://github.com/ggml-org/whisper.cpp/archive/refs/tags/${VERSION}.tar.gz`);
  if (!res.ok) throw new Error(`Не скачался whisper.cpp ${VERSION}: HTTP ${res.status}`);
  fs.writeFileSync(tar, Buffer.from(await res.arrayBuffer()));
  // Имя без пути: tar из Git для Windows читает «C:» в пути как адрес удалённой машины.
  run('tar', ['-xzf', path.basename(tar)]);
}

const build = path.join(src, 'build');
const flags = [
  '-B',
  build,
  '-DCMAKE_BUILD_TYPE=Release',
  // Статическая сборка: один файл без соседних библиотек.
  '-DBUILD_SHARED_LIBS=OFF',
  // Без -march=native: бинарник должен работать на любом процессоре, а не только на машине сборки.
  '-DGGML_NATIVE=OFF',
  '-DWHISPER_BUILD_TESTS=OFF',
  '-DWHISPER_BUILD_SERVER=OFF',
  '-DWHISPER_SDL2=OFF',
  '-DWHISPER_CURL=OFF',
];
if (process.platform === 'darwin')
  flags.push('-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64', '-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0', '-DGGML_METAL_EMBED_LIBRARY=ON');
if (process.platform === 'win32') flags.push('-A', 'x64');
run('cmake', flags, src);
run('cmake', ['--build', build, '--config', 'Release', '--target', 'whisper-cli', '-j', String(os.availableParallelism())], src);

const built = [path.join(build, 'bin', exe), path.join(build, 'bin', 'Release', exe)].find((f) => fs.existsSync(f));
if (!built) throw new Error('whisper-cli не найден после сборки');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(built, path.join(outDir, exe));
fs.chmodSync(path.join(outDir, exe), 0o755);
fs.copyFileSync(path.join(src, 'LICENSE'), path.join(outDir, 'LICENSE'));
fs.writeFileSync(stamp, `${VERSION}\n`);
console.log(`whisper-cli ${VERSION}: ${path.join(outDir, exe)}`);
