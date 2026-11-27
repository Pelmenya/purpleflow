import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/coverage-server.ts', import.meta.url));
const TSX = import.meta.resolve('tsx');
const linux = { skip: process.platform !== 'linux' };

const MODULE = `export function a(x: number) {
  if (x > 0) return 1;
  return -1;
}

export function b() {
  return 2;
}
`;

const FULL_TEST = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { a, b } from './server/m.js';

test('покрытие', () => {
  assert.equal(a(1), 1);
  assert.equal(a(-1), -1);
  assert.equal(b(), 2);
});
`;

function project(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-coverage-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  return dir;
}

function write(dir: string, name: string, content: string) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function run(dir: string) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--import', TSX, SCRIPT, '--root', dir], { encoding: 'utf8', env });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

test('порог покрытия: невызванная функция роняет проверку', linux, (t) => {
  const dir = project(t);
  write(dir, 'src/server/m.ts', MODULE);
  write(
    dir,
    'src/server-m.test.ts',
    `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { a } from './server/m.js';

test('покрытие', () => assert.equal(a(1), 1));
`,
  );

  const result = run(dir);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /does not meet threshold/);
});

test('порог покрытия: модуль без тестов считается', linux, (t) => {
  const dir = project(t);
  write(dir, 'src/server/m.ts', MODULE);
  write(dir, 'src/server/n.ts', 'export function missed() {\n  return 0;\n}\n');
  write(dir, 'src/server-m.test.ts', FULL_TEST);

  const result = run(dir);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /n\.ts/);
});

test('порог покрытия: модуль только с константами без тестов роняет проверку', linux, (t) => {
  const dir = project(t);
  write(dir, 'src/server/m.ts', MODULE);
  write(dir, 'src/server/untested.ts', 'export const answer = 42;\n');
  write(dir, 'src/server-m.test.ts', FULL_TEST);

  const result = run(dir);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /untested\.ts/);
});

test('порог покрытия: фактический недобор у границы роняет проверку', linux, (t) => {
  const dir = project(t);
  const functions = Array.from({ length: 20_000 }, (_, i) => `export const f${i} = () => ${i};`).join('\n');
  const covered = Array.from({ length: 10 }, (_, i) => `export const f${i} = () => ${i};`).join('\n');
  write(dir, 'src/server/big.ts', `${functions}\n`);
  write(dir, 'src/server/covered.ts', `${covered}\n`);
  write(
    dir,
    'src/server-big.test.ts',
    `import { test } from 'node:test';
import * as big from './server/big.js';
import * as covered from './server/covered.js';

test('покрытие', () => {
  for (const fn of Object.values(big).slice(0, 16999)) fn();
  for (const fn of Object.values(covered)) fn();
});
`,
  );

  const result = run(dir);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /big\.ts/);
});

test('порог покрытия: полностью покрытый код проходит', linux, (t) => {
  const dir = project(t);
  write(dir, 'src/server/m.ts', MODULE);
  write(dir, 'src/server-m.test.ts', FULL_TEST);

  const result = run(dir);
  assert.equal(result.status, 0, result.output);
});

test('порог покрытия: без серверных тестов и модулей — проход с сообщением', linux, (t) => {
  const dir = project(t);

  const result = run(dir);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /серверных тестов нет/);
});

test('порог покрытия: модули без тестов роняют проверку', linux, (t) => {
  const dir = project(t);
  write(dir, 'src/server/m.ts', MODULE);

  const result = run(dir);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /серверные модули без тестов/);
});

test('порог покрытия: непокрытый файл среди покрытых роняет проверку', linux, (t) => {
  const dir = project(t);
  const functions = Array.from({ length: 100 }, (_, i) => `export const f${i} = () => ${i};`).join('\n');
  write(dir, 'src/server/big.ts', `${functions}\n`);
  write(dir, 'src/server/n.ts', 'export function missed() {\n  return 0;\n}\n');
  write(
    dir,
    'src/server-big.test.ts',
    `import { test } from 'node:test';
import * as big from './server/big.js';

test('покрытие', () => {
  for (const fn of Object.values(big)) fn();
});
`,
  );

  const result = run(dir);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /файл ниже порога/);
  assert.match(result.output, /n\.ts/);
});

test('порог покрытия: частично исполненный модуль роняет проверку', linux, (t) => {
  const dir = project(t);
  const functions = Array.from({ length: 100 }, (_, i) => `export const f${i} = () => ${i};`).join('\n');
  write(dir, 'src/server/big.ts', `${functions}\n`);
  write(dir, 'src/server/n.ts', 'export const marker = 1;\nexport function missed() {\n  return marker;\n}\n');
  write(
    dir,
    'src/server-big.test.ts',
    `import { test } from 'node:test';
import * as big from './server/big.js';

test('покрытие', () => {
  for (const fn of Object.values(big)) fn();
});
`,
  );

  const result = run(dir);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /файл ниже порога/);
  assert.match(result.output, /n\.ts/);
});

test('порог покрытия: модуль только с типами не роняет проверку', linux, (t) => {
  const dir = project(t);
  write(dir, 'src/server/m.ts', MODULE);
  write(dir, 'src/server/types.ts', 'export type Id = string\n');
  write(dir, 'src/server-m.test.ts', FULL_TEST);

  const result = run(dir);
  assert.equal(result.status, 0, result.output);
});

test('порог покрытия: серверные файлы исполняются последовательно', linux, (t) => {
  const dir = project(t);
  write(dir, 'src/server/m.ts', MODULE);
  const serialTest = `import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { a, b } from './server/m.js';

test('последовательность', async () => {
  assert.equal(a(1), 1);
  assert.equal(a(-1), -1);
  assert.equal(b(), 2);
  const lock = ${JSON.stringify(path.join(dir, 'lock'))};
  const overlap = ${JSON.stringify(path.join(dir, 'overlap'))};
  try {
    fs.mkdirSync(lock);
  } catch {
    fs.writeFileSync(overlap, 'parallel');
    return;
  }
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fs.existsSync(overlap), false);
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
});
`;
  write(dir, 'src/server-first.test.ts', serialTest);
  write(dir, 'src/server-second.test.ts', serialTest);

  const result = run(dir);
  assert.equal(result.status, 0, result.output);
});
