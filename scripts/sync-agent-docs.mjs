import { readFileSync, writeFileSync } from 'node:fs';

const source = new URL('../CLAUDE.md', import.meta.url);
const generated = new URL('../AGENTS.md', import.meta.url);
const banner = '<!-- Сгенерировано из CLAUDE.md командой node scripts/sync-agent-docs.mjs. Правки вноси в CLAUDE.md. -->';

function readMarkdown(file) {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function sync(check) {
  const expected = `${banner}\n\n${readMarkdown(source)}`;
  try {
    if (readMarkdown(generated) === expected) return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (check) {
    console.error('AGENTS.md разошёлся с CLAUDE.md. Выполни node scripts/sync-agent-docs.mjs.');
    process.exitCode = 1;
  } else {
    writeFileSync(generated, expected);
  }
}

if (process.argv.includes('--after-edit')) {
  const { tool_input: input } = JSON.parse(readFileSync(0, 'utf8'));
  if (/([/\\]|^)CLAUDE\.md$/.test(input?.file_path ?? '')) sync(false);
} else {
  sync(process.argv.includes('--check'));
}
