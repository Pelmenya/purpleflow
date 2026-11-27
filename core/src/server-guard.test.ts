import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ShuttingDownError } from './kernel.js';
import { Orchestrator } from './orchestrator.js';
import { spawnScope } from './proc.js';
import type { CoreOptions } from './runtime.js';
import { ACCEPTED_METHODS, createServerCore } from './server/guard.js';
import type { CoreSettings } from './types.js';

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

function coreOptions(t: { after: (fn: () => void) => void }): CoreOptions {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-server-guard-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    dataDir: path.join(root, 'data'),
    promptsDir: PROMPTS,
    env: process.env,
    getSettings: () => ({ toolPaths: {} }) as unknown as CoreSettings,
  };
}

function checkAcceptedMethods(methods: readonly string[]): void {
  const prototypeMethods = Object.getOwnPropertyNames(Orchestrator.prototype);
  for (const method of methods) assert.ok(prototypeMethods.includes(method), `В Orchestrator нет метода ${method}`);
}

test('обёртка службы: каждое имя ACCEPTED_METHODS — метод Orchestrator', () => {
  checkAcceptedMethods(ACCEPTED_METHODS);
  assert.throws(() => checkAcceptedMethods(['missingMethod']), /В Orchestrator нет метода missingMethod/);
});

test('обёртка службы: принятый метод после shutdown отклонён и ядро не вызвано', async (t) => {
  let calls = 0;
  t.mock.method(Orchestrator.prototype, 'sendChat', async () => {
    calls++;
  });
  const core = createServerCore(coreOptions(t));
  await core.shutdown();

  await assert.rejects(core.sendChat('chat', 'Текст'), ShuttingDownError);
  assert.equal(calls, 0);
});

test('обёртка службы: метод исполняется в контексте своего ядра', (t) => {
  t.mock.method(Orchestrator.prototype, 'settingsChanged', () => spawnScope.getStore());
  const core = createServerCore(coreOptions(t)) as unknown as { settingsChanged(): object | undefined };
  const other = createServerCore(coreOptions(t)) as unknown as { settingsChanged(): object | undefined };

  const scope = core.settingsChanged();
  assert.ok(scope);
  assert.strictEqual(core.settingsChanged(), scope);
  assert.notStrictEqual(other.settingsChanged(), scope);
});
