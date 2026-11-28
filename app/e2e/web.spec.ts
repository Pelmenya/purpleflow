import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { parse, stringify } from 'devalue';
import { makeSandbox } from './harness';
import { startWebService, type WebService } from './web-service';

type CoreReply = { ok: true; result: { runId: string } } | { ok: false; error: { message: string } };

async function startRun(service: WebService, projectPath: string): Promise<string> {
  const login = await fetch(`${service.origin}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: service.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret: service.secret, returnTo: '/' }),
  });
  expect(login.status).toBe(303);
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  expect(cookie).toMatch(/^pf_session=/);

  const response = await fetch(`${service.origin}/api/core/dispatch`, {
    method: 'POST',
    headers: { Origin: service.origin, Cookie: cookie! },
    body: stringify([
      {
        type: 'run.start',
        input: { projectPath, task: 'Проверка адреса окна', testCommand: 'npm test', mode: 'task' },
      },
    ]),
  });
  expect(response.status).toBe(200);
  const reply = parse(await response.text()) as CoreReply;
  if (!reply.ok) throw new Error(reply.error.message);
  return reply.result.runId;
}

test('окно в браузере: вход с возвратом, перезагрузка, журнал и история экранов', async () => {
  const box = makeSandbox();
  let service: WebService | undefined;
  let app: ElectronApplication | undefined;
  const errors: string[] = [];
  try {
    service = await startWebService(box);
    const runId = await startRun(service, box.repo);
    const runUrl = `${service.origin}/runs/${runId}`;
    app = await electron.launch({
      cwd: path.dirname(__dirname),
      args: [...(process.platform === 'linux' ? ['--no-sandbox', '--password-store=basic'] : []), path.join(__dirname, 'web-main.cjs')],
      env: {
        ...process.env,
        PURPLEFLOW_WEB_URL: runUrl,
        PURPLEFLOW_USER_DATA: path.join(box.profile, 'web'),
        PURPLEFLOW_MUTE: '1',
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      } as Record<string, string>,
    });
    const page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));

    await page.getByLabel('Секрет').fill(service.secret);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(page).toHaveURL(runUrl);
    await expect(page.getByRole('button', { name: /^Принять план/ })).toBeVisible({ timeout: 60_000 });

    await page.reload();
    await expect(page).toHaveURL(runUrl);
    await expect(page.getByRole('button', { name: /^Принять план/ })).toBeVisible({ timeout: 60_000 });

    await page.goto(`${runUrl}/log`);
    await expect(page.getByRole('tab', { name: 'Лог', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: /^Принять план/ })).toBeVisible({ timeout: 60_000 });
    await page.goBack();
    await expect(page).toHaveURL(runUrl);
    await expect(page.getByRole('tab', { name: 'Таймлайн', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.goForward();
    await expect(page).toHaveURL(`${runUrl}/log`);
    await expect(page.getByRole('tab', { name: 'Лог', exact: true })).toHaveAttribute('aria-selected', 'true');

    await page.getByRole('button', { name: /^Принять план/ }).click();
    await expect(page.getByRole('tab', { name: /^Код/ })).toHaveAttribute('aria-selected', 'true', { timeout: 60_000 });

    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    await expect(page).toHaveURL(`${service.origin}/settings`);
    await expect(page.getByRole('heading', { name: 'Настройки', level: 1 })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(`${runUrl}/log`);
    await expect(page.getByRole('tab', { name: 'Лог', exact: true })).toHaveAttribute('aria-selected', 'true');
  } finally {
    if (app) await app.close();
    if (service) await service.stop();
    box.cleanup();
  }
  expect(errors, 'необработанные ошибки страницы').toEqual([]);
});
