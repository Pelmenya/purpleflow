import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODEL_OPTIONS, PROXY_ONLY_BADGE as badge, PROXY_ONLY_TITLE as badgeTitle, mergeModelOptions, proxyOnly } from './models';

const remote = {
  anthropic: [
    { id: 'claude-fable-5-2', displayName: 'Claude Fable 5.2' },
    { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' },
    { id: 'claude-x', displayName: 'claude-x' },
  ],
  openai: [
    { id: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol' },
    { id: 'gemini-4-argon', displayName: 'Gemini 4 Argon' },
    { id: 'gemini-3.8-flash', displayName: '' },
  ],
};

test('mergeModelOptions: без списка прокси — встроенные', () => {
  assert.equal(mergeModelOptions(null), MODEL_OPTIONS);
});

test('mergeModelOptions: новые модели прокси — после встроенных, без дублей', () => {
  const m = mergeModelOptions(remote);
  assert.deepEqual(
    m.claude.map((o) => o.value),
    [...MODEL_OPTIONS.claude.map((o) => o.value), 'claude-opus-5-5', 'claude-x'],
  );
  // У встроенной модели остаётся наша подсказка, у новой — название с сервера; одинаковое с id не повторяем.
  assert.equal(m.claude[0].hint, MODEL_OPTIONS.claude[0].hint);
  assert.equal(m.claude.find((o) => o.value === 'claude-opus-5-5')!.hint, 'Claude Opus 5.5');
  assert.equal(m.claude.find((o) => o.value === 'claude-x')!.hint, undefined);
});

test('mergeModelOptions: модели не своего семейства видны всегда — с пометкой подписки PurpleSchool', () => {
  const m = mergeModelOptions(remote);
  assert.deepEqual(m.codex.slice(MODEL_OPTIONS.codex.length), [
    { value: 'gpt-6.1-sol', label: 'gpt-6.1-sol', hint: 'GPT-6.1 Sol' },
    { value: 'gemini-4-argon', label: 'gemini-4-argon', hint: 'Gemini 4 Argon', badge, badgeTitle },
    { value: 'gemini-3.8-flash', label: 'gemini-3.8-flash', hint: undefined, badge, badgeTitle },
  ]);
});

test('proxyOnly: только помеченные модели из списка; своё и введённое вручную — нет', () => {
  const m = mergeModelOptions(remote);
  assert.equal(proxyOnly(m.codex, 'gemini-4-argon'), true);
  assert.equal(proxyOnly(m.codex, ' gemini-4-argon '), true);
  assert.equal(proxyOnly(m.codex, 'gpt-6.1-sol'), false);
  assert.equal(proxyOnly(m.codex, 'my-local-model'), false);
  assert.equal(proxyOnly(m.codex, ''), false);
});

test('mergeModelOptions: agy с прокси — только Gemini из прокси, без него — все модели аккаунта Google', () => {
  const account = ['gemini-4-neon-high', 'gemini-3.8-flash-low'];
  // С прокси модели аккаунта скрыты, даже если список пришёл: через прокси они дают 404.
  const proxied = mergeModelOptions(remote, [], account, true);
  assert.deepEqual(
    proxied.agy.map((o) => o.value),
    ['gemini-3.8-flash', 'gemini-4-argon'],
  );
  assert.ok(proxied.agy.every((o) => o.badge === undefined));
  // Своя подписка — только модели аккаунта, моделей прокси в списке нет.
  assert.deepEqual(
    mergeModelOptions(remote, [], account, false).agy.map((o) => o.value),
    account,
  );
  // Аккаунт ещё не ответил — модели прокси: их имена agy принимает и со своим входом.
  assert.deepEqual(
    mergeModelOptions(remote, [], [], false).agy.map((o) => o.value),
    ['gemini-3.8-flash', 'gemini-4-argon'],
  );
});
