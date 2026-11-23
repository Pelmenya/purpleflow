import { constants, copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const [projectRoot, dataDir] = process.argv.slice(2);

function installAssets() {
  const { sha } = JSON.parse(readFileSync(join(projectRoot, '.ralph', 'core.lock'), 'utf8'));
  if (typeof sha !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) {
    throw new Error('Некорректная ревизия в .ralph/core.lock.');
  }

  const revision = join(dataDir, sha);
  const pending = [];

  function conflict(destination) {
    return new Error(`Файл проекта отличается от комплекта Ralph: ${relative(projectRoot, destination)}.`);
  }

  // Проверяем весь комплект до копирования, чтобы конфликт не оставил половину скиллов.
  function planCopy(source, destination) {
    const asset = lstatSync(source);
    const existing = lstatSync(destination, { throwIfNoEntry: false });
    if (asset.isDirectory()) {
      if (existing && !existing.isDirectory()) throw conflict(destination);
      for (const name of readdirSync(source)) {
        planCopy(join(source, name), join(destination, name));
      }
    } else if (!asset.isFile()) {
      throw new Error(`Неожиданный тип файла в комплекте Ralph: ${relative(revision, source)}.`);
    } else if (!existing) {
      pending.push({ source, destination });
    } else if (!existing.isFile() || !readFileSync(source).equals(readFileSync(destination))) {
      throw conflict(destination);
    }
  }

  const projectClaude = join(projectRoot, '.claude');
  const existingClaude = lstatSync(projectClaude, { throwIfNoEntry: false });
  if (existingClaude && !existingClaude.isDirectory()) throw conflict(projectClaude);

  planCopy(join(revision, 'ralph.md'), join(projectRoot, 'ralph.md'));
  planCopy(join(revision, '.claude', 'skills'), join(projectClaude, 'skills'));
  planCopy(join(revision, 'LICENSE'), join(projectRoot, '.ralph', 'LICENSE'));
  for (const { source, destination } of pending) {
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
  }

  console.log('Правила и скиллы Ralph доступны в проекте.');
}

try {
  installAssets();
} catch (error) {
  console.error(`Установка правил и скиллов Ralph: ${error.message}`);
  process.exitCode = 1;
}
