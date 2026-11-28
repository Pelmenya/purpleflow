import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { createServerApp } from './server/main.js';
import { LOGIN_CSP, WINDOW_CSP } from './server/web-assets.js';
import { Browser, configFor, listen, PUBLIC_ORIGIN, serverTestsSkip, startTestHost, waitingRunFixture } from './server-testkit.test.js';

async function webFixture(t: TestContext, built = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-server-web-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const fixture = await startTestHost({ dataDir: root, project: { path: root } });
  t.after(fixture.close);
  const config = configFor(root, fixture.project, fixture.settings);
  const webDir = path.join(root, 'web');
  config.webDir = webDir;
  fs.mkdirSync(path.join(webDir, 'assets'), { recursive: true });
  if (built) {
    fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><html><body><div id="root">Окно</div></body></html>');
    fs.writeFileSync(path.join(webDir, 'login.html'), '<!doctype html><html><body>Вход веб-сборки</body></html>');
    fs.writeFileSync(path.join(webDir, 'assets', 'a.js'), 'export const ok = true;');
  }
  const origin = await listen(t, createServerApp(config, fixture.host));
  return { ...fixture, config, origin, root, webDir };
}

function assertWindowHtml(response: Response, body: string): void {
  assert.equal(response.status, 200);
  assert.match(body, /id="root"/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('content-security-policy'), WINDOW_CSP);
  assert.match(WINDOW_CSP, /object-src 'none'/);
  assert.match(WINDOW_CSP, /base-uri 'none'/);
  assert.match(WINDOW_CSP, /frame-ancestors 'none'/);
  assert.match(WINDOW_CSP, /form-action 'none'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
}

test('веб: вход и ресурсы публичны, маршруты окна после входа отдают index.html', { skip: serverTestsSkip }, async (t) => {
  const { origin } = await webFixture(t);
  const browser = new Browser();
  const runId = crypto.randomUUID();

  const login = await browser.request(origin, '/login');
  assert.equal(login.status, 200);
  assert.match(await login.text(), /Вход веб-сборки/);
  assert.equal(login.headers.get('content-security-policy'), WINDOW_CSP);

  const asset = await browser.request(origin, '/assets/a.js');
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');

  for (const route of ['/', `/runs/${runId}`]) {
    const response = await browser.request(origin, route);
    assert.equal(response.status, 303);
    assert.equal(new URL(response.headers.get('location') ?? '', origin).searchParams.get('returnTo'), route);
  }

  assert.equal((await browser.login(origin)).status, 303);
  for (const route of ['/', `/runs/${runId}`, `/runs/${runId}/log`]) {
    const response = await browser.request(origin, route);
    assertWindowHtml(response, await response.text());
  }
});

test('веб: обход каталога, обратный слэш и ссылка наружу не отдают файлы', { skip: serverTestsSkip }, async (t) => {
  const { origin, root, webDir } = await webFixture(t);
  fs.writeFileSync(path.join(root, 'outside.js'), 'секрет');
  fs.symlinkSync(path.join(root, 'outside.js'), path.join(webDir, 'assets', 'outside.js'));
  const browser = new Browser();
  assert.equal((await browser.login(origin)).status, 303);

  for (const route of [
    '/assets/../config.json',
    '/assets/%2e%2e/x',
    '/assets/..%2f..%2fcore%2fpackage.json',
    '/assets/%5coutside.js',
    '/assets/outside.js',
    '/assets/a.txt',
  ]) {
    const response = await browser.request(origin, route);
    assert.equal(response.status, 404, route);
    assert.doesNotMatch(await response.text(), /секрет/);
  }
});

test('веб: без сборки окно сообщает о build:web, запасной вход и ошибки имеют полный CSP', { skip: serverTestsSkip }, async (t) => {
  const { origin } = await webFixture(t, false);
  const browser = new Browser();

  const login = await browser.request(origin, '/login');
  assert.equal(login.status, 200);
  assert.match(await login.text(), /Вход в PurpleFlow/);
  assert.equal(login.headers.get('content-security-policy'), LOGIN_CSP);
  assert.match(LOGIN_CSP, /object-src 'none'/);
  assert.match(LOGIN_CSP, /base-uri 'none'/);
  assert.match(LOGIN_CSP, /frame-ancestors 'none'/);
  assert.match(LOGIN_CSP, /form-action 'self'/);

  assert.equal((await browser.login(origin)).status, 303);
  const missing = await browser.request(origin, '/');
  assert.equal(missing.status, 503);
  assert.match(await missing.text(), /npm run build:web/);

  const limitedBrowser = new Browser();
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await limitedBrowser.request(origin, '/login', {
      method: 'POST',
      body: new URLSearchParams({ secret: 'неверно', returnTo: '/' }),
    });
    assert.equal(response.status, attempt < 5 ? 401 : 429);
    assert.equal(response.headers.get('content-security-policy'), LOGIN_CSP);
  }
});

test('веб: служба отклоняет непроверенный returnTo', { skip: serverTestsSkip }, async (t) => {
  const { origin } = await webFixture(t);
  const browser = new Browser();
  const response = await browser.request(origin, '/login', {
    method: 'POST',
    headers: { Origin: PUBLIC_ORIGIN },
    body: new URLSearchParams({ secret: 'секрет владельца', returnTo: '/runs/not-a-uuid' }),
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/');
});

test('веб: формы приёмки старой страницы ведут под /legacy', { skip: serverTestsSkip }, async (t) => {
  const fixture = await webFixture(t);
  const run = waitingRunFixture(fixture.config.dataDir, fixture.project.path, { next: 'gate2' });
  fixture.host.readDiff = async () => ({ run, diff: [] });
  const browser = new Browser();
  assert.equal((await browser.login(fixture.origin)).status, 303);

  const response = await browser.request(fixture.origin, `/legacy/runs/${run.id}`);
  assert.equal(response.status, 200);
  const page = await response.text();
  const actions = [...page.matchAll(/<form[^>]+action="([^"]+)"/g)].map((match) => match[1]).filter((action) => action !== '/logout');
  assert.ok(actions.length >= 2);
  for (const action of actions) assert.match(action ?? '', new RegExp(`^/legacy/runs/${run.id}/`));
});
