import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { ShuttingDownError } from './kernel.js';
import { loadServerConfig } from './server/config.js';
import { createServerApp } from './server/main.js';
import type { Host } from './server/host.js';
import {
  Browser,
  configFor,
  listen,
  makeRepo,
  makeServerStand,
  serverTestsSkip,
  spawnService,
  startTestHost,
} from './server-testkit.test.js';
import { RunStore } from './store.js';
import type { ChatFile } from './types.js';

const chatTest = { skip: serverTestsSkip, timeout: 120_000 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type ChatView = { chat: ChatFile; busy: boolean };
type Fixture = Awaited<ReturnType<typeof startTestHost>> & {
  stand: ReturnType<typeof makeServerStand>;
  origin: string;
  browser: Browser;
};

function deferred(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error('Не дождались состояния чата');
    await sleep(50);
  }
}

async function hostFixture(
  t: TestContext,
  hooks?: NonNullable<Parameters<typeof createServerApp>[2]>['testHooks'],
  stand = makeServerStand(),
): Promise<Fixture> {
  const settings = loadServerConfig(stand.configFile).settings;
  const fixture = await startTestHost({ dataDir: stand.dataDir, settings, project: stand.project });
  t.after(fixture.close);
  const origin = await listen(t, createServerApp(configFor(stand.dataDir, stand.project, settings), fixture.host, { testHooks: hooks }));
  const browser = new Browser();
  assert.equal((await browser.login(origin)).status, 303);
  return { ...fixture, stand, origin, browser };
}

async function createChat(browser: Browser, origin: string, projectId = 'p1'): Promise<string> {
  const page = await browser.request(origin, `/projects/${projectId}/chats`);
  assert.equal(page.status, 200);
  const response = await browser.request(origin, `/projects/${projectId}/chats`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(),
  });
  assert.equal(response.status, 303);
  const chatId = response.headers.get('location')?.split('/').at(-1);
  assert.ok(chatId);
  return chatId;
}

function postMessage(
  browser: Browser,
  origin: string,
  chatId: string,
  submissionId: string,
  text: string,
  signal?: AbortSignal,
): Promise<Response> {
  return browser.request(origin, `/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ submissionId, text }),
    signal,
  });
}

async function readApi(browser: Browser, origin: string, chatId: string): Promise<ChatView> {
  const response = await browser.request(origin, `/api/chats/${chatId}`);
  assert.equal(response.status, 200);
  return (await response.json()) as ChatView;
}

function fakeTurns(stand: ReturnType<typeof makeServerStand>): { args: string[]; prompt: string }[] {
  if (!fs.existsSync(stand.fakeLog)) return [];
  return fs
    .readFileSync(stand.fakeLog, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[]; prompt: string })
    .filter((entry) => entry.args.includes('-p'));
}

test('чат: закрыть клиент до ответа и продолжить с другого устройства', chatTest, async (t) => {
  const fixture = await hostFixture(t);
  fs.writeFileSync(fixture.stand.delayFile, '800');
  const firstClient = fixture.browser;
  const chatId = await createChat(firstClient, fixture.origin);
  const firstSubmission = crypto.randomUUID();
  assert.equal((await postMessage(firstClient, fixture.origin, chatId, firstSubmission, 'Первый вопрос')).status, 303);

  const secondClient = new Browser();
  assert.equal((await secondClient.login(fixture.origin, `/chats/${chatId}`)).status, 303);
  await until(
    () => readApi(secondClient, fixture.origin, chatId),
    (view) => view.busy && view.chat.messages.some((message) => message.role === 'user' && message.text === 'Первый вопрос'),
  );
  const busyPage = await secondClient.request(fixture.origin, `/chats/${chatId}`);
  const busyHtml = await busyPage.text();
  assert.match(busyHtml, /<meta http-equiv="refresh" content="2">/);
  assert.match(busyHtml, /<fieldset disabled>[\s\S]*<textarea[^>]*name="text"[\s\S]*<button[^>]*type="submit"[\s\S]*<\/fieldset>/);
  assert.doesNotMatch(busyHtml, /<form[^>]*disabled/);

  await until(
    () => readApi(secondClient, fixture.origin, chatId),
    (view) => !view.busy && view.chat.messages.some((message) => message.role === 'assistant' && !message.pending),
  );
  const readyPage = await secondClient.request(fixture.origin, `/chats/${chatId}`);
  const readyHtml = await readyPage.text();
  assert.doesNotMatch(readyHtml, /http-equiv="refresh"/);
  assert.doesNotMatch(readyHtml, /<fieldset disabled/);

  fs.writeFileSync(fixture.stand.delayFile, '0');
  assert.equal((await postMessage(secondClient, fixture.origin, chatId, crypto.randomUUID(), 'Второй вопрос')).status, 303);
  const continued = await until(
    () => readApi(secondClient, fixture.origin, chatId),
    (view) => !view.busy && view.chat.messages.filter((message) => message.role === 'user').length === 2,
  );
  assert.equal(continued.chat.messages.filter((message) => message.role === 'assistant' && !message.pending).length, 2);
});

test('чат: создание и остановка службы', chatTest, async (t) => {
  const first = await hostFixture(t);
  const creating = first.host.createChat('p1');
  const closing = first.close();
  await assert.rejects(creating, (error) => error instanceof ShuttingDownError);
  await closing;
  const chatsDir = path.join(first.dataDir, 'chats');
  assert.deepEqual(fs.existsSync(chatsDir) ? fs.readdirSync(chatsDir).filter((file) => file.endsWith('.json')) : [], []);

  const second = await hostFixture(t);
  const createStarted = deferred();
  const createGate = deferred();
  second.core.createChat = async () => {
    createStarted.open();
    await createGate.promise;
    throw new Error('Определение CLI прервано');
  };
  const gated = second.host.createChat('p1');
  await createStarted.promise;
  const secondClosing = second.close();
  createGate.open();
  await assert.rejects(gated, (error) => error instanceof ShuttingDownError);
  await secondClosing;

  const third = await hostFixture(t);
  const thirdClosing = third.close();
  const response = await third.browser.request(third.origin, '/projects/p1/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(),
  });
  assert.equal(response.status, 503);
  await thirdClosing;
});

test('чат: недоступные чаты', chatTest, async (t) => {
  const fixture = await hostFixture(t);
  const allowed = await createChat(fixture.browser, fixture.origin);
  const desktop = await fixture.core.createChat({ projectPath: fixture.project.path, agent: 'claude', edits: true });
  const withoutProject = await fixture.core.createChat({ agent: 'claude', edits: false });
  const foreignPath = makeRepo();
  const foreign = await fixture.core.createChat({ projectPath: foreignPath, agent: 'claude', edits: false });

  const listPage = await fixture.browser.request(fixture.origin, '/projects/p1/chats');
  const listHtml = await listPage.text();
  assert.match(listHtml, new RegExp(`/chats/${allowed}`));
  for (const chat of [desktop, withoutProject, foreign]) assert.doesNotMatch(listHtml, new RegExp(chat.id));

  for (const chat of [desktop, withoutProject, foreign]) {
    assert.equal(await fixture.host.readChat(chat.id), null);
    assert.equal((await fixture.browser.request(fixture.origin, `/chats/${chat.id}`)).status, 404);
    assert.equal((await fixture.browser.request(fixture.origin, `/api/chats/${chat.id}`)).status, 404);
    assert.equal((await postMessage(fixture.browser, fixture.origin, chat.id, crypto.randomUUID(), 'вопрос')).status, 404);
  }
  assert.equal((await fixture.browser.request(fixture.origin, '/projects/missing/chats')).status, 404);
  assert.equal(
    (
      await fixture.browser.request(fixture.origin, '/projects/missing/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(),
      })
    ).status,
    404,
  );
  assert.equal((await fixture.core.getChat(desktop.id))!.chat.edits, true);
});
