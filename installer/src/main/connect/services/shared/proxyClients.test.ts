import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeLimit } from './proxyClients.js';

test('claudeLimit: у текущих Claude окно 1M, у Haiku 4.5 и моделей до 4.6 — 200K, у чужих моделей — не задаём', () => {
  const big = { context: 1_000_000, output: 128_000 };
  const small = { context: 200_000, output: 64_000 };
  for (const id of [
    'claude-opus-5-5',
    'claude-opus-4-6',
    'claude-opus-4-8',
    'claude-sonnet-4-6',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
    'claude-fable-5',
    'claude-fable-5-2',
  ])
    assert.deepEqual(claudeLimit(id), big, id);
  for (const id of [
    'claude-haiku-4-5-20251001',
    'claude-haiku-4-5',
    'claude-sonnet-4-5',
    'claude-opus-4-1',
    'claude-sonnet-4-20250514',
    'claude-3-7-sonnet-latest',
  ])
    assert.deepEqual(claudeLimit(id), small, id);
  assert.equal(claudeLimit('gpt-6-sol'), undefined);
  assert.equal(claudeLimit('gemini-3.8-flash'), undefined);
});
