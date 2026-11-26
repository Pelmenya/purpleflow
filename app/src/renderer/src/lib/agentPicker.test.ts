import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickerSections } from './agentPicker';

const OPTS = {
  claude: [
    { value: 'opus', label: 'opus' },
    { value: 'sonnet', label: 'sonnet' },
  ],
  codex: [{ value: 'gpt-6-sol', label: 'gpt-6-sol' }],
  opencode: [{ value: 'openrouter/qwen', label: 'openrouter/qwen' }],
  agy: [{ value: 'gemini-3.8-flash-high', label: 'gemini-3.8-flash-high' }],
};

test('pickerSections: разделы по включённым агентам, «по умолчанию» первым', () => {
  const s = pickerSections(['claude', 'opencode'], OPTS, 'claude', '');
  assert.deepEqual(
    s.map((x) => x.agent),
    ['claude', 'opencode'],
  );
  assert.deepEqual(
    s[0].items.map((i) => i.model),
    ['', 'opus', 'sonnet'],
  );
  assert.deepEqual(
    s[1].items.map((i) => i.model),
    ['', 'openrouter/qwen'],
  );
});

test('pickerSections: поиск скрывает пустые разделы; незнакомое имя — своя модель у текущего агента', () => {
  const found = pickerSections(['claude', 'codex', 'opencode'], OPTS, 'claude', 'qwen');
  assert.deepEqual(
    found.map((x) => x.agent),
    ['claude', 'opencode'],
  );
  assert.deepEqual(found[0].items, [{ agent: 'claude', model: 'qwen', custom: true }]);
  assert.equal(found[1].items[0].model, 'openrouter/qwen');
  // Точное совпадение — без «своей».
  const exact = pickerSections(['claude', 'codex'], OPTS, 'codex', 'opus');
  assert.deepEqual(
    exact.map((x) => x.agent),
    ['claude'],
  );
  assert.equal(
    exact[0].items.some((i) => i.custom),
    false,
  );
});
