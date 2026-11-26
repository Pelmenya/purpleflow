import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeOpenaiResponse, probeAnthropicMessage, checkPurpleSchoolToken } from '../../src/main/connect/core/validateToken.js';

const response = { object: 'response', status: 'completed', error: null, output: [] };
const cases = [
  { name: 'completed generation', body: response, ok: true },
  { name: 'failed generation with HTTP 200', body: { ...response, status: 'failed', error: { message: 'Generation failed' } }, ok: false },
  { name: 'failed status without an error message', body: { ...response, status: 'failed' }, ok: false },
  { name: 'error object despite completed status', body: { ...response, error: { message: 'Upstream error' } }, ok: false },
  { name: 'HTTP failure despite completed body', body: response, http: 502, ok: false },
  { name: 'empty error object', body: { ...response, error: {} }, ok: false },
  { name: 'in-progress generation', body: { ...response, status: 'in_progress' }, ok: false },
  { name: 'missing status', body: { object: 'response', output: [] }, ok: false },
  { name: 'wrong API response', body: { type: 'message', content: [] }, ok: false },
  {
    name: 'token-limited generation',
    body: { ...response, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
    ok: true,
    limited: true,
  },
  { name: 'filtered generation', body: { ...response, status: 'incomplete', incomplete_details: { reason: 'content_filter' } }, ok: false },
  { name: 'invalid JSON', raw: 'not JSON', ok: false },
];
for (const item of cases) {
  test(`OpenAI probe: ${item.name}`, async () => {
    const previousFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response(item.raw ?? JSON.stringify(item.body), { status: item.http ?? 200 });
      const result = await probeOpenaiResponse('https://example.invalid', 'test-key', 'gpt-test');
      assert.equal(result.ok, item.ok);
      assert.equal(result.limited === true, item.limited === true);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
}

for (const item of [
  { name: 'valid message', body: { type: 'message', content: [{ type: 'text', text: 'OK' }] }, ok: true },
  { name: 'error body with HTTP 200', body: { type: 'error', error: { message: 'Upstream failure' } }, ok: false },
  { name: 'unrelated JSON body', body: { ok: true }, ok: false },
  { name: 'invalid JSON body', raw: 'not JSON', ok: false },
  { name: 'HTTP failure', body: { error: { message: 'Out of balance' } }, http: 402, ok: false },
]) {
  test(`Anthropic probe: ${item.name}`, async () => {
    const previousFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response(item.raw ?? JSON.stringify(item.body), { status: item.http ?? 200 });
      const result = await probeAnthropicMessage('https://example.invalid', 'test-key', 'claude-test');
      assert.equal(result.ok, item.ok);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
}

test('network failures and rejected model catalogs never report a valid connection', async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw new Error('test network unavailable');
    };
    assert.equal((await probeOpenaiResponse('https://example.invalid', 'test', 'gpt-test')).ok, false);
    assert.equal((await probeAnthropicMessage('https://example.invalid', 'test', 'claude-test')).ok, false);
    assert.equal((await checkPurpleSchoolToken('https://example.invalid', 'test')).status, 'unknown');
    for (const status of [401, 403, 429, 500]) {
      globalThis.fetch = async () => new Response('{}', { status });
      assert.equal((await checkPurpleSchoolToken('https://example.invalid', 'test')).status, status < 404 ? 'invalid' : 'unknown');
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});
