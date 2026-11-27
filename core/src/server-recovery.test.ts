import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  Browser,
  makeRepo,
  makeServerStand,
  postDecision,
  serverTestsSkip,
  spawnService,
  waitingRunFixture,
} from './server-testkit.test.js';
import { RunStore } from './store.js';
import type { RunFile } from './types.js';

const recoveryTest = { skip: serverTestsSkip, timeout: 120_000 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error('Не дождались состояния прогона');
    await sleep(100);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

async function startTask(browser: Browser, origin: string, task: string): Promise<string> {
  const project = await browser.request(origin, '/projects/p1');
  const submissionId = /name="submissionId" value="([0-9a-f-]+)"/.exec(await project.text())?.[1];
  assert.ok(submissionId);
  const started = await browser.request(origin, '/projects/p1/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ submissionId, task }),
  });
  assert.equal(started.status, 303);
  const runId = started.headers.get('location')?.split('/').at(-1);
  assert.ok(runId);
  return runId;
}

function stoppedRun(store: RunStore, runId: string): Promise<RunFile> {
  return until(
    () => store.load(runId),
    (run): run is RunFile => run?.status === 'stopped',
  );
}

test('журнал и остановка: вход с возвратом, 404 для чужого прогона, причина ошибки после перезагрузки', recoveryTest, async (t) => {
  const stand = makeServerStand();
  const store = new RunStore(stand.dataDir);
  const foreign = waitingRunFixture(stand.dataDir, makeRepo(), {
    next: 'gate1',
    status: 'stopped',
    message: 'Чужой прогон не менять',
  });
  store.appendLog(foreign.id, 'Чужой журнал не менять\n');
  const foreignBefore = JSON.stringify(store.load(foreign.id));
  const service = await spawnService(stand);
  t.after(service.stop);

  const anonymous = new Browser();
  const anonymousLog = await anonymous.request(service.origin, `/runs/${foreign.id}/log`);
  assert.equal(anonymousLog.status, 303);
  assert.equal(anonymousLog.headers.get('location'), `/login?returnTo=${encodeURIComponent(`/runs/${foreign.id}/log`)}`);

  const client = new Browser();
  assert.equal((await client.login(service.origin)).status, 303);
  const runId = await startTask(client, service.origin, 'Добавь mul. СЛОМАЙ_АГЕНТА');
  const gate1 = await until(
    () => store.load(runId),
    (run): run is RunFile => run?.status === 'waiting' && run.next === 'gate1',
  );
  assert.equal(
    (await postDecision(client, service.origin, runId, { expectedWaitId: gate1.waitId!, action: 'approve' })).status,
    303,
  );
  const failed = await stoppedRun(store, runId);
  assert.ok(failed.message);

  const anonymousStop = await anonymous.request(service.origin, `/runs/${runId}/stop`, { method: 'POST' });
  assert.equal(anonymousStop.status, 303);
  assert.deepEqual(store.load(runId), failed);

  const secondClient = new Browser();
  const loggedIn = await secondClient.login(service.origin, `/runs/${runId}/log`);
  assert.equal(loggedIn.status, 303);
  assert.equal(loggedIn.headers.get('location'), `/runs/${runId}/log`);
  const page = await secondClient.request(service.origin, `/runs/${runId}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), new RegExp(escapeHtml(failed.message).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const log = await secondClient.request(service.origin, `/runs/${runId}/log`);
  assert.equal(log.status, 200);
  assert.match(await log.text(), new RegExp(escapeHtml(failed.message).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const foreignLog = await secondClient.request(service.origin, `/runs/${foreign.id}/log`);
  assert.equal(foreignLog.status, 404);
  const foreignStop = await secondClient.request(service.origin, `/runs/${foreign.id}/stop`, { method: 'POST' });
  assert.equal(foreignStop.status, 404);
  assert.equal(JSON.stringify(store.load(foreign.id)), foreignBefore);
  assert.equal(store.readLog(foreign.id), 'Чужой журнал не менять\n');
  assert.equal(fs.existsSync(store.logFile(runId)), true);
});
