import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { ShuttingDownError } from './kernel.js';
import { loadServerConfig } from './server/config.js';
import { createServerApp } from './server/main.js';
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

async function spawnChatService(stand: ReturnType<typeof makeServerStand>): Promise<Awaited<ReturnType<typeof spawnService>>> {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) => socket.close((error) => (error ? reject(error) : resolve())));
  const config = JSON.parse(fs.readFileSync(stand.configFile, 'utf8')) as { port: number };
  config.port = address.port;
  fs.writeFileSync(stand.configFile, JSON.stringify(config));
  return spawnService(stand);
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

test('чат: потерянный ответ POST', chatTest, async (t) => {
  const fixture = await hostFixture(t);
  fs.writeFileSync(fixture.stand.delayFile, '500');
  const chatId = await createChat(fixture.browser, fixture.origin);
  const submissionId = crypto.randomUUID();

  assert.equal((await postMessage(fixture.browser, fixture.origin, chatId, submissionId, 'вопрос')).status, 303);
  assert.equal((await postMessage(fixture.browser, fixture.origin, chatId, submissionId, 'вопрос')).status, 303);
  assert.equal((await postMessage(fixture.browser, fixture.origin, chatId, submissionId, 'другое')).status, 409);
  let view = await until(
    () => readApi(fixture.browser, fixture.origin, chatId),
    (current) => !current.busy,
  );
  assert.deepEqual(
    view.chat.messages.filter((message) => message.role === 'user').map((message) => message.text),
    ['вопрос'],
  );
  assert.equal(fakeTurns(fixture.stand).length, 1);

  fs.writeFileSync(fixture.stand.delayFile, '0');
  const otherKey = crypto.randomUUID();
  assert.equal((await postMessage(fixture.browser, fixture.origin, chatId, otherKey, 'вопрос')).status, 303);
  const spacedKey = crypto.randomUUID();
  assert.equal((await postMessage(fixture.browser, fixture.origin, chatId, spacedKey, 'вопрос\n')).status, 303);
  assert.equal((await postMessage(fixture.browser, fixture.origin, chatId, spacedKey, '  вопрос  ')).status, 303);
  assert.equal((await postMessage(fixture.browser, fixture.origin, chatId, crypto.randomUUID(), '   ')).status, 400);
  view = await until(
    () => readApi(fixture.browser, fixture.origin, chatId),
    (current) => !current.busy && current.chat.messages.filter((message) => message.role === 'user').length === 3,
  );
  assert.deepEqual(
    view.chat.messages.filter((message) => message.role === 'user').map((message) => message.text),
    ['вопрос', 'вопрос', 'вопрос'],
  );
  assert.equal(fakeTurns(fixture.stand).length, 3);
});

test('чат: исход неизвестен после сбоя', chatTest, async (t) => {
  const fixture = await hostFixture(t);
  const chatId = await createChat(fixture.browser, fixture.origin);
  const submissionId = crypto.randomUUID();
  const hash = createHash('sha256')
    .update(JSON.stringify([chatId, 'вопрос']))
    .digest('hex');
  const file = path.join(fixture.dataDir, 'server', 'chat-submissions', `${submissionId}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ submissionId, hash, chatId, createdAt: new Date().toISOString() }));

  const response = await postMessage(fixture.browser, fixture.origin, chatId, submissionId, 'вопрос');
  assert.equal(response.status, 409);
  const html = await response.text();
  assert.match(html, /Исход неизвестен/);
  assert.match(html, new RegExp(`href="/chats/${chatId}"`));
  assert.deepEqual((await readApi(fixture.browser, fixture.origin, chatId)).chat.messages, []);
  assert.equal(fakeTurns(fixture.stand).length, 0);
});

test('чат: одновременные повторы', chatTest, async (t) => {
  const fixture = await hostFixture(t);
  fs.writeFileSync(fixture.stand.delayFile, '500');
  const chatId = await createChat(fixture.browser, fixture.origin);
  const submissionId = crypto.randomUUID();

  const first = fixture.host.sendChat(chatId, 'вопрос', submissionId);
  const repeated = fixture.host.sendChat(chatId, 'вопрос', submissionId);
  const conflict = fixture.host.sendChat(chatId, 'другое', submissionId);
  assert.equal(first, repeated);
  assert.deepEqual(await first, { status: 'accepted' });
  assert.deepEqual(await repeated, { status: 'accepted' });
  assert.deepEqual(await conflict, { status: 'conflict' });
  const view = await until(
    () => fixture.host.readChat(chatId),
    (current) => current !== null && !current.busy,
  );
  assert.deepEqual(
    view!.chat.messages.filter((message) => message.role === 'user').map((message) => message.text),
    ['вопрос'],
  );
  assert.equal(fakeTurns(fixture.stand).length, 1);
});

test('чат: заявка после начала close', chatTest, async (t) => {
  const beforeSend = deferred();
  const beforeSendGate = deferred();
  const first = await hostFixture(t, {
    beforeChatSend: async () => {
      beforeSend.open();
      await beforeSendGate.promise;
    },
  });
  const chatId = await createChat(first.browser, first.origin);
  const submissionId = crypto.randomUUID();
  const oldPosting = postMessage(first.browser, first.origin, chatId, submissionId, 'вопрос');
  await beforeSend.promise;
  await first.close();

  const second = await hostFixture(t, undefined, first.stand);
  const newResponse = await postMessage(second.browser, second.origin, chatId, submissionId, 'вопрос');
  assert.equal(newResponse.status, 303);
  await until(
    () => readApi(second.browser, second.origin, chatId),
    (view) => !view.busy,
  );
  const file = path.join(first.dataDir, 'server', 'chat-submissions', `${submissionId}.json`);
  const before = fs.readFileSync(file, 'utf8');

  beforeSendGate.open();
  assert.equal((await oldPosting).status, 503);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('чат: обрыв соединения после сохранения сообщения', chatTest, async (t) => {
  const beforeRedirect = deferred();
  const beforeRedirectGate = deferred();
  const fixture = await hostFixture(t, {
    beforeChatRedirect: async () => {
      beforeRedirect.open();
      await beforeRedirectGate.promise;
    },
  });
  fs.writeFileSync(fixture.stand.delayFile, '500');
  const chatId = await createChat(fixture.browser, fixture.origin);
  const submissionId = crypto.randomUUID();
  const controller = new AbortController();
  const posting = postMessage(fixture.browser, fixture.origin, chatId, submissionId, 'вопрос', controller.signal);
  await beforeRedirect.promise;
  try {
    controller.abort();
    await assert.rejects(posting);
  } finally {
    beforeRedirectGate.open();
  }

  const otherClient = new Browser();
  assert.equal((await otherClient.login(fixture.origin)).status, 303);
  const view = await until(
    () => readApi(otherClient, fixture.origin, chatId),
    (current) => !current.busy && current.chat.messages.some((message) => message.role === 'assistant' && !message.pending),
  );
  assert.equal(view.chat.messages.filter((message) => message.role === 'user').length, 1);
  assert.equal((await postMessage(otherClient, fixture.origin, chatId, submissionId, 'вопрос')).status, 303);
  assert.equal((await readApi(otherClient, fixture.origin, chatId)).chat.messages.filter((message) => message.role === 'user').length, 1);
  assert.equal(fakeTurns(fixture.stand).length, 1);
});

test('чат: рестарт службы во время ответа', chatTest, async (t) => {
  const stand = makeServerStand();
  const store = new RunStore(stand.dataDir);
  let service = await spawnChatService(stand);
  t.after(() => service.stop());
  const firstClient = new Browser();
  assert.equal((await firstClient.login(service.origin)).status, 303);
  const chatId = await createChat(firstClient, service.origin);
  fs.writeFileSync(stand.delayFile, '30000');
  assert.equal((await postMessage(firstClient, service.origin, chatId, crypto.randomUUID(), 'первый')).status, 303);
  const pids = await until(
    () => store.readPids(`chat:${chatId}`),
    (current) => current.length > 0,
  );
  assert.equal((await postMessage(firstClient, service.origin, chatId, crypto.randomUUID(), 'ожидающий')).status, 303);
  await until(
    () => readApi(firstClient, service.origin, chatId),
    (view) => view.chat.messages.some((message) => message.queued && message.text === 'ожидающий'),
  );

  const exited = new Promise<void>((resolve) => service.proc.once('exit', () => resolve()));
  assert.ok(service.proc.kill('SIGKILL'));
  await exited;
  fs.writeFileSync(stand.delayFile, '0');
  const config = JSON.parse(fs.readFileSync(stand.configFile, 'utf8')) as { projects: unknown[] };
  const projects = config.projects;
  config.projects = [{ id: 'other', path: makeRepo(), testCommand: 'node --version' }];
  fs.writeFileSync(stand.configFile, JSON.stringify(config));

  service = await spawnChatService(stand);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.deepEqual(store.readPids(`chat:${chatId}`), []);
  assert.deepEqual(store.readPids(`chat:${chatId}:task`), []);
  assert.equal(store.pidsTime(`chat:${chatId}`), undefined);
  const withoutProject = new Browser();
  assert.equal((await withoutProject.login(service.origin)).status, 303);
  assert.equal((await withoutProject.request(service.origin, `/chats/${chatId}`)).status, 404);
  assert.equal((await withoutProject.request(service.origin, `/api/chats/${chatId}`)).status, 404);
  await service.stop();

  config.projects = projects;
  fs.writeFileSync(stand.configFile, JSON.stringify(config));
  service = await spawnChatService(stand);
  const client = new Browser();
  assert.equal((await client.login(service.origin, `/chats/${chatId}`)).status, 303);
  const recovered = await readApi(client, service.origin, chatId);
  assert.equal(recovered.busy, false);
  assert.equal(
    recovered.chat.messages.some((message) => message.role === 'assistant' && message.stopped),
    true,
  );
  assert.equal(
    recovered.chat.messages.some((message) => message.queued && message.text === 'ожидающий'),
    true,
  );
  const page = await client.request(service.origin, `/chats/${chatId}`);
  const html = await page.text();
  assert.doesNotMatch(html, /http-equiv="refresh"/);
  assert.doesNotMatch(html, /<fieldset disabled/);
  assert.match(html, /ожидает отправки/);

  assert.equal((await postMessage(client, service.origin, chatId, crypto.randomUUID(), 'новый')).status, 303);
  const continued = await until(
    () => readApi(client, service.origin, chatId),
    (view) => !view.busy && view.chat.messages.some((message) => message.role === 'assistant' && !message.pending && !message.stopped),
  );
  assert.equal(
    continued.chat.messages.some((message) => message.queued),
    false,
  );
  const turns = fakeTurns(stand);
  assert.equal(turns.length, 1);
  assert.match(turns[0]!.prompt, /ожидающий/);
  assert.match(turns[0]!.prompt, /новый/);
});
