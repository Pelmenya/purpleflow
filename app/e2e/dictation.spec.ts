// Диктовка: микрофон Chromium подменён файлом с фразой, распознаёт настоящий whisper-cli с настоящей моделью.
// Нужны собранный whisper-cli (npm run whisper) и модель в PURPLEFLOW_WHISPER_MODEL (ggml-small-q5_1.bin) — иначе тест пропускается:
// модель весит 190 МБ, в CI её не качаем.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, makeSandbox, quit } from './harness';

const OS_DIR = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
const BIN = path.join(__dirname, '..', 'whisper-bin', OS_DIR, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
const MODEL = process.env.PURPLEFLOW_WHISPER_MODEL ?? '';
const SPEECH = process.env.PURPLEFLOW_WHISPER_SPEECH ?? '';

test('диктовка: без модели — окно выбора; с моделью — голос с микрофона становится текстом в поле чата', async () => {
  test.skip(!fs.existsSync(BIN) || !fs.existsSync(MODEL) || !fs.existsSync(SPEECH), 'нет whisper-cli, модели или записи речи');
  const box = makeSandbox();
  let l = await launch(box, { PURPLEFLOW_FAKE_MIC: SPEECH });
  try {
    await l.page.getByRole('button', { name: /Создать/ }).click();
    await l.page.getByRole('menuitem', { name: /Чат/ }).click();
    // Модели ещё нет — кнопка открывает выбор модели.
    await l.page.getByRole('button', { name: 'Диктовка', exact: true }).click();
    const dialog = l.page.getByRole('dialog', { name: 'Диктовка' });
    await expect(dialog.getByRole('radio')).toHaveCount(3);
    if (process.env.PURPLEFLOW_SHOTS) {
      await l.page.waitForTimeout(600);
      await l.page.screenshot({ path: path.join(box.root, '..', 'pf-dictation-setup.png') });
    }
    await dialog.getByRole('button', { name: 'Закрыть' }).click();
    await quit(l);

    // Модель «скачана» — копия в данные приложения, как после скачивания.
    fs.mkdirSync(path.join(box.profile, 'whisper-models'), { recursive: true });
    fs.copyFileSync(MODEL, path.join(box.profile, 'whisper-models', 'ggml-small-q5_1.bin'));
    l = await launch(box, { PURPLEFLOW_FAKE_MIC: SPEECH });
    await l.page.getByRole('button', { name: /Создать/ }).click();
    await l.page.getByRole('menuitem', { name: /Чат/ }).click();
    const input = l.page.locator('.chat-compose textarea');
    await input.fill('Задача:');
    await l.page.getByRole('button', { name: 'Диктовка', exact: true }).click();
    await expect(l.page.getByRole('button', { name: 'Остановить диктовку' })).toBeVisible();
    await l.page.waitForTimeout(4000);
    await l.page.getByRole('button', { name: 'Остановить диктовку' }).click();
    await expect(input).toHaveValue(/^Задача: .*кнопку диктовки/i, { timeout: 60_000 });
  } finally {
    await quit(l);
    box.cleanup();
  }
});
