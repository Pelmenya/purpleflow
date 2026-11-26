// Antigravity CLI (agy) в настройках: включение, модели из `agy models` и пресет для ролей.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, makeSandbox, quit, type Launched, type Sandbox } from './harness';

let box: Sandbox;
let l: Launched;

test.afterEach(async () => {
  const errors = l.errors;
  await quit(l);
  box.cleanup();
  expect(errors, 'необработанные ошибки страницы').toEqual([]);
});

/** Фейковый agy: версия и список моделей аккаунта («слаг<TAB>название», как печатает `agy models`). */
function fakeAgy(dir: string): string {
  const bin = path.join(dir, 'agy');
  fs.writeFileSync(
    bin,
    '#!/bin/sh\nif [ "$1" = "models" ]; then printf "gemini-3.8-flash-low\\tGemini 3.8 Flash (Low)\\ngemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\ngemini-4-hydrogen-medium\\tGemini 4 Hydrogen (Medium)\\n"; else echo "1.5.17"; fi\n',
    { mode: 0o755 },
  );
  return bin;
}

test('быстрая настройка на agy: пресет расставляет модели ролей, а в подсказках — слаги из agy models', async () => {
  box = makeSandbox();
  const settings = path.join(box.profile, 'settings.json');
  const cur = JSON.parse(fs.readFileSync(settings, 'utf8'));
  cur.toolPaths.agy = fakeAgy(box.root);
  cur.enabledAgents = ['claude', 'agy'];
  fs.writeFileSync(settings, JSON.stringify(cur));
  l = await launch(box);

  await l.page.getByRole('button', { name: 'Настройки' }).click();
  await l.page.locator('.settings-tabs').getByText('Модели', { exact: true }).click();
  await l.page.getByRole('button', { name: 'Быстрая настройка' }).click();
  const d = l.page.getByRole('dialog', { name: 'Быстрая настройка' });
  await d.getByRole('radio', { name: 'agy' }).click();
  await d.getByRole('heading', { name: 'Быстрая настройка' }).click();
  await expect(d.locator('.qs-row').filter({ hasText: 'Планировщик' })).toContainText('gemini-3.8-flash-high');
  await expect(d.locator('.qs-row').filter({ hasText: 'Исполнитель' })).toContainText('gemini-3.8-flash-medium');
  await d.getByRole('button', { name: 'Применить' }).click();
  await expect(d).toBeHidden();

  const saved = JSON.parse(fs.readFileSync(settings, 'utf8'));
  expect(saved.agents.planner).toBe('agy');
  expect(saved.agents.reviewer).toBe('agy');
  expect(saved.models.planner).toBe('gemini-3.8-flash-high');
  expect(saved.models.executor).toBe('gemini-3.8-flash-medium');

  // Слаги моделей аккаунта подмешиваются в подсказки поля модели.
  await l.page.getByLabel('Модель: Исполнитель').click();
  await expect(l.page.getByText('gemini-3.8-flash-low', { exact: true }).first()).toBeVisible();
});
