import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { main } from './server/main.js';
import { hashSecret, readLoginSecret, verifySecret } from './server/secret.js';

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-server-secret-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('секрет: scrypt с солью, проверка верного и неверного значения', () => {
  const first = hashSecret('секрет владельца');
  const second = hashSecret('секрет владельца');

  assert.match(first, /^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  assert.equal(verifySecret('секрет владельца', first), true);
  assert.equal(verifySecret('другой секрет', first), false);
});

test('секрет: открытый текст и небезопасные права отклоняются', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'secret');
  fs.writeFileSync(file, 'открытый секрет', { mode: 0o600 });

  assert.throws(() => readLoginSecret(file), /Файл секрета содержит открытый текст[\s\S]*hash-secret[\s\S]*\.old/);
  fs.writeFileSync(file, hashSecret('секрет'), { mode: 0o600 });
  assert.equal(readLoginSecret(file), fs.readFileSync(file, 'utf8'));
  fs.chmodSync(file, 0o644);
  assert.throws(() => readLoginSecret(file), /доступен группе или остальным пользователям/);
});

test('команда hash-secret: печатает секрет один раз и не перезаписывает файл', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'secret');
  const output: string[] = [];
  const errors: string[] = [];
  const write = process.stdout.write;
  const error = console.error;
  const previousExitCode = process.exitCode;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk).trim());
    return true;
  }) as typeof process.stdout.write;
  console.error = (value: unknown) => errors.push(String(value));
  t.after(() => {
    process.stdout.write = write;
    console.error = error;
    process.exitCode = previousExitCode;
  });

  await main(['hash-secret', file]);
  assert.equal(process.exitCode, 0);
  assert.equal(output.length, 1);
  assert.match(output[0]!, /^[A-Za-z0-9_-]{43,}$/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const stored = fs.readFileSync(file, 'utf8');
  assert.equal(verifySecret(output[0]!, stored), true);

  await main(['hash-secret', file]);
  assert.equal(process.exitCode, 1);
  assert.equal(output.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), stored);
});
