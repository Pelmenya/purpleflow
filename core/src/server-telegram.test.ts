import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AttentionIntent } from './server/attention.js';
import { loadServerConfig } from './server/config.js';
import { createServerApp, startService } from './server/main.js';
import { startTelegram, type TelegramOptions } from './server/telegram.js';
import {
  Browser,
  configFor,
  listen,
  makeServerStand,
  postDecision,
  serverTestsSkip,
  spawnService,
  startTestHost,
  waitingRunFixture,
} from './server-testkit.test.js';

const runId = crypto.randomUUID();
const waitIntent: AttentionIntent = { key: `wait:${runId}:w1`, runId, kind: 'wait', reasonCode: 'gate1' };
const stoppedIntent: AttentionIntent = {
  key: `stopped:${runId}:s1`,
  runId,
  kind: 'stopped',
  reasonCode: 'stage_failed',
};

type QueueEntry = {
  key: string;
  runId: string;
  state: 'pending' | 'delivered' | 'dropped' | 'failed';
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
};

type BotRequest = { url: string; chatId: string | number; text: string };
type BotReply = {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  destroy?: boolean;
  wait?: Promise<void>;
};

class FakeHost {
  failure: Error | null = null;
  private listeners = new Set<(runId: string, intent: AttentionIntent | null) => void>();

  constructor(public current: AttentionIntent[] = []) {}

  intents(): AttentionIntent[] {
    if (this.failure) throw this.failure;
    return this.current;
  }

  onIntentChange(fn: (runId: string, intent: AttentionIntent | null) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  emit(intent: AttentionIntent | null, id = intent?.runId ?? runId): void {
    this.current = intent
      ? this.current.filter((item) => item.runId !== id).concat(intent)
      : this.current.filter((item) => item.runId !== id);
    for (const listener of this.listeners) listener(id, intent);
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

function deferred(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

function intent(label: string, reasonCode = 'gate1'): AttentionIntent {
  const id = crypto.randomUUID();
  return { key: `wait:${id}:${label}`, runId: id, kind: 'wait', reasonCode };
}

function tempDir(t: TestContext): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-telegram-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function queueFile(dataDir: string): string {
  return path.join(dataDir, 'server', 'telegram-queue.json');
}

function readQueue(dataDir: string): QueueEntry[] {
  return JSON.parse(fs.readFileSync(queueFile(dataDir), 'utf8')) as QueueEntry[];
}

async function startBot(t: TestContext, respond: (request: BotRequest) => BotReply | Promise<BotReply> = () => ({})) {
  const requests: BotRequest[] = [];
  const apiBase = await listen(t, (req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      void (async () => {
        const parsed = JSON.parse(body) as { chat_id: string | number; text: string };
        const request = { url: req.url ?? '', chatId: parsed.chat_id, text: parsed.text };
        requests.push(request);
        const reply = await respond(request);
        if (reply.wait) await reply.wait;
        if (reply.destroy) {
          req.socket.destroy();
          return;
        }
        res
          .writeHead(reply.status ?? 200, {
            'Content-Type': 'application/json',
            ...reply.headers,
          })
          .end(reply.body ?? '{"ok":true}');
      })().catch(() => res.destroy());
    });
  });
  return { apiBase, requests };
}

function startHandle(t: TestContext, options: Pick<TelegramOptions, 'dataDir' | 'apiBase' | 'host' | 'now'> & Partial<TelegramOptions>) {
  const handle = startTelegram({
    token: 'secret-token',
    chatId: 'owner',
    publicOrigin: 'https://purpleflow.example',
    ...options,
  });
  t.after(handle.stop);
  return handle;
}

async function waitFor(check: () => boolean, message: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const pause = (ms = 50): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('телеграм: attentionLink строит обе ссылки при изолированном импорте', async () => {
  const moduleUrl = new URL('./server/telegram.ts', import.meta.url).href;
  const source = `
    import { attentionLink } from ${JSON.stringify(moduleUrl)};
    const base = { runId: ${JSON.stringify(runId)}, reasonCode: 'gate1' };
    console.log(JSON.stringify([
      attentionLink('https://purpleflow.example', { ...base, key: 'wait', kind: 'wait' }),
      attentionLink('https://purpleflow.example', { ...base, key: 'stopped', kind: 'stopped' }),
    ]));
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (stdout += chunk));
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const [code, signal] = await within(once(child, 'exit'));
  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
  assert.deepEqual(JSON.parse(stdout), [`https://purpleflow.example/runs/${runId}`, `https://purpleflow.example/runs/${runId}/log`]);
});

test('телеграм: ожидание доставляется один раз со ссылкой на прогон', async (t) => {
  const bot = await startBot(t);
  const host = new FakeHost();
  startHandle(t, { dataDir: tempDir(t), apiBase: bot.apiBase, host });

  host.emit(waitIntent);
  await waitFor(() => bot.requests.length === 1, 'Ожидание не доставлено');
  assert.equal(bot.requests[0]?.chatId, 'owner');
  assert.match(bot.requests[0]?.text ?? '', /утверждение плана/i);
  assert.ok(bot.requests[0]?.text.includes(`https://purpleflow.example/runs/${runId}`));
  await pause();
  assert.equal(bot.requests.length, 1);

  host.emit(stoppedIntent);
  await waitFor(() => bot.requests.length === 2, 'Остановка не доставлена');
  assert.match(bot.requests[1]?.text ?? '', /остановлен с ошибкой/i);
  assert.ok(bot.requests[1]?.text.includes(`https://purpleflow.example/runs/${runId}/log`));
});

test('телеграм: ответ ok, запись delivered падает — немедленного повтора нет', async (t) => {
  const dataDir = tempDir(t);
  const errors: string[] = [];
  t.mock.method(console, 'error', (message: string) => errors.push(message));
  const bot = await startBot(t, () => {
    fs.rmSync(queueFile(dataDir), { force: true });
    fs.mkdirSync(queueFile(dataDir));
    fs.writeFileSync(path.join(queueFile(dataDir), 'occupied'), 'x');
    return {};
  });
  const host = new FakeHost([waitIntent]);
  const handle = startHandle(t, { dataDir, apiBase: bot.apiBase, host });
  await waitFor(() => handle.status().lastDeliveredAt !== null, 'Ответ Bot API не обработан');
  host.emit(waitIntent);
  await pause();
  assert.equal(bot.requests.length, 1);
  assert.ok(errors.length > 0);
  assert.ok(errors.every((line) => !line.includes('secret-token')));
  assert.match(errors.join('\n'), /EISDIR|ENOTEMPTY|EPERM/);
});

test('телеграм: новый intent во время fetch не теряется', async (t) => {
  const first = intent('first');
  const second = intent('second');
  const firstResponse = deferred();
  const secondResponse = deferred();
  t.after(secondResponse.open);
  const bot = await startBot(t, (request) => ({
    wait: request.text.includes(first.runId) ? firstResponse.promise : secondResponse.promise,
  }));
  const dataDir = tempDir(t);
  const host = new FakeHost([first]);
  const handle = startHandle(t, { dataDir, apiBase: bot.apiBase, host });
  await waitFor(() => bot.requests.length === 1, 'Первый запрос не начат');
  host.emit(second);
  firstResponse.open();
  await waitFor(() => bot.requests.length === 2, 'Второй запрос не начат');
  const states = new Map(readQueue(dataDir).map((entry) => [entry.runId, entry.state]));
  assert.equal(states.get(first.runId), 'delivered');
  assert.equal(states.get(second.runId), 'pending');
  const beforeStop = fs.readFileSync(queueFile(dataDir));
  await handle.stop();
  assert.deepEqual(fs.readFileSync(queueFile(dataDir)), beforeStop);
  secondResponse.open();
});

test('телеграм: огромный retry_after ограничен сутками', async (t) => {
  const current = intent('limited');
  const now = () => 1_000_000;
  const bot = await startBot(t, () => ({ status: 429, body: '{"parameters":{"retry_after":3000000}}' }));
  const dataDir = tempDir(t);
  const handle = startHandle(t, { dataDir, apiBase: bot.apiBase, host: new FakeHost([current]), now });
  await waitFor(() => Boolean(readQueue(dataDir)[0]?.lastError), '429 не обработан');
  const entry = readQueue(dataDir)[0]!;
  assert.equal(entry.state, 'pending');
  assert.equal(entry.nextAttemptAt, now() + 86_400_000);
  assert.ok(Number.isFinite(entry.nextAttemptAt));
  await pause();
  assert.equal(bot.requests.length, 1);
  const beforeStop = fs.readFileSync(queueFile(dataDir));
  const startedAt = Date.now();
  await handle.stop();
  assert.ok(Date.now() - startedAt < 2_000);
  assert.deepEqual(fs.readFileSync(queueFile(dataDir)), beforeStop);
});

test('телеграм: результаты всех трёх ответов 429 сохранены в очереди', async (t) => {
  const limited = intent('seconds');
  const missing = intent('missing');
  const invalid = intent('invalid');
  const now = () => 2_000_000;
  const bot = await startBot(t, (request) => {
    if (request.text.includes(limited.runId)) return { status: 429, body: '{"parameters":{"retry_after":30}}' };
    if (request.text.includes(missing.runId)) return { status: 429, body: '{}' };
    return { status: 429, body: '{"parameters":{"retry_after":"30"}}' };
  });
  const dataDir = tempDir(t);
  startHandle(t, { dataDir, apiBase: bot.apiBase, host: new FakeHost([limited, missing, invalid]), now });
  await waitFor(() => {
    const entries = new Map(readQueue(dataDir).map((entry) => [entry.runId, entry]));
    return (
      entries.get(limited.runId)?.nextAttemptAt === now() + 30_000 &&
      entries.get(missing.runId)?.nextAttemptAt === now() + 5_000 &&
      entries.get(invalid.runId)?.nextAttemptAt === now() + 5_000
    );
  }, 'Не все ответы 429 сохранены в очереди');
  const entries = new Map(readQueue(dataDir).map((entry) => [entry.runId, entry]));
  assert.equal(entries.get(limited.runId)?.nextAttemptAt, now() + 30_000);
  assert.equal(entries.get(missing.runId)?.nextAttemptAt, now() + 5_000);
  assert.equal(entries.get(invalid.runId)?.nextAttemptAt, now() + 5_000);
});

test('телеграм: закрытая таблица исходов HTTP и тела', async (t) => {
  const cases = [
    { intent: intent('404'), status: 404, body: '', state: 'failed' },
    { intent: intent('400-empty'), status: 400, body: '', state: 'failed' },
    { intent: intent('400-null'), status: 400, body: '{"description":null}', state: 'failed' },
    { intent: intent('200-broken'), status: 200, body: 'not json', state: 'pending' },
    { intent: intent('200-false'), status: 200, body: '{"ok":false}', state: 'pending' },
    { intent: intent('200-null'), status: 200, body: 'null', state: 'pending' },
    { intent: intent('302'), status: 302, body: '', state: 'pending', headers: { Location: '/redirected' } },
  ];
  const bot = await startBot(t, (request) => {
    const item = cases.find(({ intent }) => request.text.includes(intent.runId))!;
    return { status: item.status, body: item.body, headers: item.headers };
  });
  const dataDir = tempDir(t);
  startHandle(t, { dataDir, apiBase: bot.apiBase, host: new FakeHost(cases.map(({ intent }) => intent)) });
  await waitFor(() => bot.requests.length === cases.length, 'Не все HTTP-исходы обработаны');
  await pause();
  const entries = new Map(readQueue(dataDir).map((entry) => [entry.runId, entry]));
  for (const item of cases) assert.equal(entries.get(item.intent.runId)?.state, item.state, item.intent.key);
  assert.equal(bot.requests.length, cases.length);
  assert.equal(
    bot.requests.some(({ url }) => url.includes('/redirected')),
    false,
  );
});

test('телеграм: failed после исправления конфигурации и рестарта доставляется', async (t) => {
  const current = intent('fixed');
  let authorized = false;
  const bot = await startBot(t, () => (authorized ? {} : { status: 401, body: '{"description":"Unauthorized"}' }));
  const dataDir = tempDir(t);
  const host = new FakeHost([current]);
  const first = startHandle(t, { dataDir, apiBase: bot.apiBase, host });
  await waitFor(() => readQueue(dataDir)[0]?.state === 'failed', '401 не переведён в failed');
  await pause();
  assert.equal(bot.requests.length, 1);
  await first.stop();

  authorized = true;
  startHandle(t, { dataDir, apiBase: bot.apiBase, host });
  await waitFor(() => readQueue(dataDir)[0]?.state === 'delivered', 'Исправленная конфигурация не доставлена');
  assert.equal(bot.requests.length, 2);
});

test('телеграм: сброс ответа оставляет pending и повторяет позже', async (t) => {
  const current = intent('reset');
  let reset = true;
  const bot = await startBot(t, () => {
    if (reset) {
      reset = false;
      return { destroy: true };
    }
    return {};
  });
  const dataDir = tempDir(t);
  const host = new FakeHost([current]);
  let now = 1_000_000;
  const first = startHandle(t, { dataDir, apiBase: bot.apiBase, host, now: () => now });
  await waitFor(() => Boolean(readQueue(dataDir)[0]?.lastError), 'Сброс соединения не обработан');
  assert.equal(readQueue(dataDir)[0]?.state, 'pending');
  await first.stop();

  now += 5_000;
  startHandle(t, { dataDir, apiBase: bot.apiBase, host, now: () => now });
  await waitFor(() => readQueue(dataDir)[0]?.state === 'delivered', 'Повтор после сброса не доставлен');
  assert.equal(bot.requests.length, 2);
});

test('телеграм: рестарт после сохранённого delivered не повторяет, отложенная запись ждёт nextAttemptAt', async (t) => {
  const delivered = intent('delivered');
  const delayed = intent('delayed');
  let delayedAttempts = 0;
  const bot = await startBot(t, (request) => {
    if (!request.text.includes(delayed.runId)) return {};
    delayedAttempts += 1;
    return delayedAttempts === 1 ? { status: 429, body: '{"parameters":{"retry_after":30}}' } : {};
  });
  const dataDir = tempDir(t);
  const host = new FakeHost([delivered, delayed]);
  let now = 5_000_000;
  const first = startHandle(t, { dataDir, apiBase: bot.apiBase, host, now: () => now });
  await waitFor(() => bot.requests.length === 2, 'Первый запуск не обработал очередь');
  await first.stop();

  now += 1_000;
  const second = startHandle(t, { dataDir, apiBase: bot.apiBase, host, now: () => now });
  await pause();
  assert.equal(bot.requests.length, 2);
  await second.stop();

  now = 5_031_000;
  startHandle(t, { dataDir, apiBase: bot.apiBase, host, now: () => now });
  await waitFor(() => bot.requests.length === 3, 'Отложенная запись не отправлена по nextAttemptAt');
  assert.ok(bot.requests[2]?.text.includes(delayed.runId));
  assert.ok(readQueue(dataDir).every((entry) => entry.state === 'delivered'));
});

test('телеграм: intent без записи в очереди восполняется сверкой', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const current = intent('reconciled');
  const bot = await startBot(t, () => ({ wait: new Promise<void>(() => {}) }));
  const dataDir = tempDir(t);
  const host = new FakeHost();
  startHandle(t, { dataDir, apiBase: bot.apiBase, host });
  host.current = [current];
  t.mock.timers.tick(60_000);
  assert.equal(readQueue(dataDir).find((entry) => entry.key === current.key)?.state, 'pending');
});

test('телеграм: разрешённое до повтора ожидание снимается без отправки', async (t) => {
  const current = intent('resolved');
  const bot = await startBot(t, () => ({ status: 429, body: '{"parameters":{"retry_after":30}}' }));
  const dataDir = tempDir(t);
  const host = new FakeHost([current]);
  let now = 10_000_000;
  const first = startHandle(t, { dataDir, apiBase: bot.apiBase, host, now: () => now });
  await waitFor(() => Boolean(readQueue(dataDir)[0]?.lastError), 'Ожидание не отложено');
  host.emit(null, current.runId);
  assert.equal(readQueue(dataDir)[0]?.state, 'dropped');
  await first.stop();

  now += 31_000;
  startHandle(t, { dataDir, apiBase: bot.apiBase, host, now: () => now });
  await pause();
  assert.equal(bot.requests.length, 1);
  assert.equal(readQueue(dataDir)[0]?.state, 'dropped');
});

test('телеграм: два одновременных обновления — одна отправка', async (t) => {
  const current = intent('duplicate-event');
  const bot = await startBot(t);
  const dataDir = tempDir(t);
  const host = new FakeHost();
  startHandle(t, { dataDir, apiBase: bot.apiBase, host });
  host.emit(current);
  host.emit(current);
  await waitFor(() => readQueue(dataDir)[0]?.state === 'delivered', 'Обновление не доставлено');
  await pause();
  assert.equal(bot.requests.length, 1);
});

test('телеграм: ошибка worker не роняет процесс', async (t) => {
  const current = intent('worker-error');
  const bot = await startBot(t);
  const dataDir = tempDir(t);
  const host = new FakeHost();
  startHandle(t, { dataDir, apiBase: bot.apiBase, host });
  host.failure = new Error(`Сбой intents с secret-token`);
  host.emit(current);
  await waitFor(() => readQueue(dataDir)[0]?.nextAttemptAt !== 0, 'Worker не обработал ошибку');
  const entry = readQueue(dataDir)[0]!;
  assert.equal(entry.state, 'pending');
  assert.equal(entry.attempts, 0);
  assert.equal(entry.lastError, 'Error');
  assert.equal(bot.requests.length, 0);
});

test('телеграм: токен не попадает в причины', async (t) => {
  const rejected = intent('rejected');
  const reset = intent('reset-token');
  const token = 'token-marker-123';
  const errors: string[] = [];
  t.mock.method(console, 'error', (message: string) => errors.push(message));
  const bot = await startBot(t, (request) => {
    if (request.text.includes(reset.runId)) return { destroy: true };
    return { status: 400, body: JSON.stringify({ description: `Bad ${token} request` }) };
  });
  const dataDir = tempDir(t);
  const handle = startHandle(t, { dataDir, apiBase: bot.apiBase, host: new FakeHost([rejected, reset]), token });
  await waitFor(() => readQueue(dataDir).length === 2 && readQueue(dataDir).every((entry) => entry.attempts === 1), 'Ошибки не обработаны');
  const probe = await handle.probe();
  const exposed = [JSON.stringify(readQueue(dataDir)), JSON.stringify(handle.status()), JSON.stringify(probe), errors.join('\n')].join(
    '\n',
  );
  assert.equal(exposed.includes(token), false);
  assert.ok(exposed.includes('***'));
  assert.equal(probe.ok, false);
});

test('телеграм: токен на границе обрезания не попадает в причины', async (t) => {
  const current = intent('truncated-token');
  const token = 'token-marker-boundary-123';
  const description = `${'x'.repeat(190)}${token}`;
  const bot = await startBot(t, () => ({ status: 400, body: JSON.stringify({ description }) }));
  const dataDir = tempDir(t);
  const handle = startHandle(t, { dataDir, apiBase: bot.apiBase, host: new FakeHost([current]), token });
  await waitFor(() => readQueue(dataDir)[0]?.state === 'failed', 'Ошибка Bot API не сохранена');

  const probe = await handle.probe();
  const expected = `HTTP 400: ${'x'.repeat(190)}***`;
  assert.equal(readQueue(dataDir)[0]?.lastError, expected);
  assert.equal(probe.error, expected);
  assert.equal(handle.status().lastError, expected);
  const exposed = [JSON.stringify(readQueue(dataDir)), JSON.stringify(handle.status()), JSON.stringify(probe)].join('\n');
  assert.equal(exposed.includes(token.slice(0, 10)), false);
});

test('телеграм: stop отписывается и прерывает отправку', async (t) => {
  const current = intent('abort');
  const response = deferred();
  t.after(response.open);
  const bot = await startBot(t, () => ({ wait: response.promise }));
  const dataDir = tempDir(t);
  const host = new FakeHost([current]);
  const handle = startHandle(t, { dataDir, apiBase: bot.apiBase, host });
  await waitFor(() => bot.requests.length === 1, 'Запрос не начат');
  const beforeStop = fs.readFileSync(queueFile(dataDir));
  const startedAt = Date.now();
  await handle.stop();
  assert.ok(Date.now() - startedAt < 2_000);
  assert.deepEqual(fs.readFileSync(queueFile(dataDir)), beforeStop);
  assert.equal(host.listenerCount(), 0);
  host.emit(intent('after-stop'));
  await pause();
  assert.equal(bot.requests.length, 1);
  assert.deepEqual(fs.readFileSync(queueFile(dataDir)), beforeStop);
  response.open();
});

test('телеграм: сбой записи очереди в слушателе не роняет ядро', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const current = intent('write-failure');
  const response = deferred();
  t.after(response.open);
  const bot = await startBot(t, () => ({ wait: response.promise }));
  const dataDir = tempDir(t);
  const host = new FakeHost();
  startHandle(t, { dataDir, apiBase: bot.apiBase, host });
  fs.rmSync(queueFile(dataDir));
  fs.mkdirSync(queueFile(dataDir));
  fs.writeFileSync(path.join(queueFile(dataDir), 'occupied'), 'x');
  assert.doesNotThrow(() => host.emit(current));
  await pause();
  fs.rmSync(queueFile(dataDir), { recursive: true });
  t.mock.timers.tick(60_000);
  assert.equal(readQueue(dataDir).find((entry) => entry.key === current.key)?.state, 'pending');
});

test('телеграм: dropped возвращается при повторной актуальности', async (t) => {
  const current = intent('resumed');
  let calls = 0;
  const bot = await startBot(t, () => {
    calls += 1;
    return calls === 1 ? { status: 429, body: '{"parameters":{"retry_after":30}}' } : {};
  });
  const dataDir = tempDir(t);
  const host = new FakeHost([current]);
  startHandle(t, { dataDir, apiBase: bot.apiBase, host });
  await waitFor(() => Boolean(readQueue(dataDir)[0]?.lastError), 'Первая попытка не отложена');
  host.emit(null, current.runId);
  assert.equal(readQueue(dataDir)[0]?.state, 'dropped');
  host.emit(current);
  await waitFor(() => readQueue(dataDir)[0]?.state === 'delivered', 'Вернувшееся ожидание не доставлено');
  await pause();
  assert.equal(bot.requests.length, 2);
});

test('телеграм: stop во время отсрочки', async (t) => {
  const current = intent('delayed-stop');
  const bot = await startBot(t, () => ({ status: 429, body: '{"parameters":{"retry_after":300}}' }));
  const dataDir = tempDir(t);
  const handle = startHandle(t, { dataDir, apiBase: bot.apiBase, host: new FakeHost([current]) });
  await waitFor(() => Boolean(readQueue(dataDir)[0]?.lastError), 'Отсрочка не сохранена');
  const beforeStop = fs.readFileSync(queueFile(dataDir));
  const startedAt = Date.now();
  await handle.stop();
  assert.ok(Date.now() - startedAt < 2_000);
  assert.deepEqual(fs.readFileSync(queueFile(dataDir)), beforeStop);
  await pause();
  assert.equal(bot.requests.length, 1);
});

const integrationTest = { skip: serverTestsSkip, timeout: 60_000 };

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

function addTelegramConfig(stand: ReturnType<typeof makeServerStand>, apiBase: string): void {
  const config = JSON.parse(fs.readFileSync(stand.configFile, 'utf8')) as Record<string, unknown>;
  const tokenFile = path.join(stand.dataDir, 'telegram-token');
  fs.writeFileSync(tokenFile, 'process-token', { mode: 0o600 });
  config.telegram = { tokenFile, chatId: 'owner', apiBase };
  fs.writeFileSync(stand.configFile, JSON.stringify(config));
}

async function spawnTelegramService(stand: ReturnType<typeof makeServerStand>) {
  const config = JSON.parse(fs.readFileSync(stand.configFile, 'utf8')) as { port: number };
  config.port = await freePort();
  fs.writeFileSync(stand.configFile, JSON.stringify(config));
  return spawnService(stand);
}

async function within<T>(promise: Promise<T>, ms = 10_000): Promise<T> {
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Процесс не завершился вовремя')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

async function terminate(service: Awaited<ReturnType<typeof spawnService>>): Promise<void> {
  const exited = once(service.proc, 'exit');
  service.proc.kill('SIGTERM');
  const [code, signal] = await within(exited);
  assert.equal(code, 0);
  assert.equal(signal, null);
}

test('настройки: проба доставлена, без раздела — не подключён', integrationTest, async (t) => {
  const fixture = await startTestHost();
  t.after(fixture.close);
  const bot = await startBot(t);
  const config = configFor(fixture.dataDir, fixture.project, fixture.settings);
  const tokenFile = path.join(fixture.dataDir, 'telegram-token');
  fs.writeFileSync(tokenFile, 'settings-token', { mode: 0o600 });
  config.telegram = { tokenFile, chatId: 'owner', apiBase: bot.apiBase };
  const telegram = startTelegram({
    dataDir: fixture.host.dataDir,
    token: 'settings-token',
    chatId: 'owner',
    apiBase: bot.apiBase,
    publicOrigin: config.publicOrigin,
    host: fixture.host,
  });
  t.after(telegram.stop);
  const origin = await listen(t, createServerApp(config, fixture.host, { telegram }));
  const browser = new Browser();
  assert.equal((await browser.login(origin)).status, 303);
  const settings = await browser.request(origin, '/legacy/settings');
  assert.equal(settings.status, 200);
  assert.match(await settings.text(), /Telegram подключён/);
  const probe = await browser.request(origin, '/legacy/settings/telegram/probe', { method: 'POST' });
  assert.equal(probe.status, 200);
  assert.match(await probe.text(), /Пробное сообщение доставлено/);
  assert.equal(bot.requests.length, 1);
  assert.match(bot.requests[0]?.text ?? '', /Пробное уведомление/);

  const withoutTelegram = await listen(t, createServerApp(configFor(fixture.dataDir, fixture.project, fixture.settings), fixture.host));
  const other = new Browser();
  assert.equal((await other.login(withoutTelegram)).status, 303);
  const disconnected = await other.request(withoutTelegram, '/legacy/settings');
  assert.equal(disconnected.status, 200);
  assert.match(await disconnected.text(), /Telegram не подключён/);
});

test('телеграм недоступен: ожидание в обзоре и решение через браузер проходят', integrationTest, async (t) => {
  const fixture = await startTestHost();
  t.after(fixture.close);
  const waiting = waitingRunFixture(fixture.dataDir, fixture.project.path, { next: 'gate1' });
  fixture.core.kernel.save(waiting);
  const telegram = startTelegram({
    dataDir: fixture.host.dataDir,
    token: 'unavailable-token',
    chatId: 'owner',
    apiBase: 'http://127.0.0.1:1',
    publicOrigin: 'https://purpleflow.example',
    host: fixture.host,
  });
  t.after(telegram.stop);
  const origin = await listen(
    t,
    createServerApp(configFor(fixture.dataDir, fixture.project, fixture.settings), fixture.host, { telegram }),
  );
  const browser = new Browser();
  await browser.login(origin);
  const overview = await browser.request(origin, '/legacy/');
  assert.match(await overview.text(), new RegExp(waiting.id));
  const decision = await postDecision(browser, origin, waiting.id, { expectedWaitId: waiting.waitId!, action: 'approve' });
  assert.equal(decision.status, 303);
  const current = await fixture.host.readRun(waiting.id);
  assert.ok(current?.gates.some((gate) => gate.gate === 'gate1'));
});

test('ссылка уведомления после входа открывает прогон и журнал, переход не принимает решение', integrationTest, async (t) => {
  const fixture = await startTestHost();
  t.after(fixture.close);
  const waiting = waitingRunFixture(fixture.dataDir, fixture.project.path, { next: 'gate1' });
  fixture.core.kernel.save(waiting);
  const stopped = waitingRunFixture(fixture.dataDir, fixture.project.path, {
    next: 'gate1',
    status: 'stopped',
    stop: { reason: 'stage_failed', id: 'stop-link', at: new Date().toISOString() },
  });
  fixture.core.kernel.save(stopped);
  fixture.core.kernel.store.appendLog(stopped.id, 'Журнал остановки\n');
  const config = configFor(fixture.dataDir, fixture.project, fixture.settings);
  config.webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-telegram-web-'));
  t.after(() => fs.rmSync(config.webDir!, { recursive: true, force: true }));
  fs.writeFileSync(path.join(config.webDir, 'index.html'), '<div id="root">Окно</div>');
  const origin = await listen(t, createServerApp(config, fixture.host));

  for (const [run, route, expected] of [
    [waiting, `/runs/${waiting.id}`, /Ожидающий прогон/],
    [stopped, `/runs/${stopped.id}/log`, /Журнал остановки/],
  ] as const) {
    const before = await fixture.host.readRun(run.id);
    const browser = new Browser();
    const anonymous = await browser.request(origin, route);
    assert.equal(anonymous.status, 303);
    assert.equal(new URL(anonymous.headers.get('location') ?? '', origin).searchParams.get('returnTo'), route);
    const login = await browser.login(origin, route);
    assert.equal(login.status, 303);
    assert.equal(login.headers.get('location'), route);
    const page = await browser.request(origin, route);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="root"/);
    const legacy = await browser.request(origin, route.replace('/runs/', '/legacy/runs/'));
    assert.equal(legacy.status, 200);
    assert.match(await legacy.text(), expected);
    assert.deepEqual(await fixture.host.readRun(run.id), before);
  }
});

test(
  'конфиг telegram: относительный tokenFile, пустой chatId, apiBase с путём — отказ с именем поля; tokenFile 0644 — отказ startService без вызова startHost',
  integrationTest,
  async (t) => {
    const stand = makeServerStand();
    t.after(() => fs.rmSync(path.dirname(stand.configFile), { recursive: true, force: true }));
    const original = JSON.parse(fs.readFileSync(stand.configFile, 'utf8')) as Record<string, unknown>;
    const invalidTelegram = (telegram: unknown): void => {
      fs.writeFileSync(stand.configFile, JSON.stringify({ ...original, telegram }));
      assert.throws(() => loadServerConfig(stand.configFile), /telegram\.(tokenFile|chatId|apiBase)/);
    };
    invalidTelegram({ tokenFile: 'relative', chatId: 'owner' });
    invalidTelegram({ tokenFile: path.join(stand.dataDir, 'token'), chatId: '' });
    invalidTelegram({ tokenFile: path.join(stand.dataDir, 'token'), chatId: 'owner', apiBase: 'http://127.0.0.1/path' });

    const tokenFile = path.join(stand.dataDir, 'token');
    fs.writeFileSync(tokenFile, 'token', { mode: 0o644 });
    fs.writeFileSync(stand.configFile, JSON.stringify({ ...original, telegram: { tokenFile, chatId: 'owner' } }));
    let hostStarted = false;
    await assert.rejects(
      startService(loadServerConfig(stand.configFile), {
        startHost: async () => {
          hostStarted = true;
          throw new Error('startHost не должен вызываться');
        },
      }),
      /доступен группе или остальным/,
    );
    assert.equal(hostStarted, false);
  },
);

test('телеграм: очередь в каноническом каталоге хоста', integrationTest, async (t) => {
  const fixture = await startTestHost();
  t.after(fixture.close);
  const aliases = tempDir(t);
  const other = tempDir(t);
  const link = path.join(aliases, 'data-link');
  fs.symlinkSync(fixture.dataDir, link, 'dir');
  const config = configFor(link, fixture.project, fixture.settings);
  config.port = 0;
  const tokenFile = path.join(fixture.dataDir, 'canonical-token');
  fs.writeFileSync(tokenFile, 'canonical-token', { mode: 0o600 });
  config.telegram = { tokenFile, chatId: 'owner', apiBase: 'http://127.0.0.1:1' };
  const service = await startService(config, { startHost: async () => fixture.host });
  t.after(service.stop);
  await service.ready;
  fs.unlinkSync(link);
  fs.symlinkSync(other, link, 'dir');
  await pause();
  assert.equal(fs.existsSync(queueFile(fixture.dataDir)), true);
  assert.equal(fs.existsSync(queueFile(other)), false);
  await service.stop();
});

test('телеграм: новый круг плана — новое уведомление, reconnect — без дубля', async (t) => {
  const first = intent('plan-first');
  const bot = await startBot(t);
  const dataDir = tempDir(t);
  const host = new FakeHost();
  startHandle(t, { dataDir, apiBase: bot.apiBase, host });
  host.emit(first);
  await waitFor(() => bot.requests.length === 1, 'Первый план не доставлен');
  host.emit(first);
  await pause();
  assert.equal(bot.requests.length, 1);
  host.emit({ ...first, key: `wait:${first.runId}:plan-second` });
  await waitFor(() => bot.requests.length === 2, 'Новый круг плана не доставлен');
});

test('служба: SIGTERM с подключённым Telegram', integrationTest, async (t) => {
  const response = deferred();
  t.after(response.open);
  const bot = await startBot(t, () => ({ wait: response.promise }));
  const stand = makeServerStand();
  t.after(() => fs.rmSync(path.dirname(stand.configFile), { recursive: true, force: true }));
  addTelegramConfig(stand, bot.apiBase);
  waitingRunFixture(stand.dataDir, stand.root, { next: 'gate1' });
  const service = await spawnTelegramService(stand);
  t.after(service.stop);
  await waitFor(() => bot.requests.length === 1, 'Служба не начала отправку');
  await terminate(service);
  const count = bot.requests.length;
  await pause();
  assert.equal(bot.requests.length, count);
  response.open();
});

test('служба: SIGTERM во время зависшей пробы', integrationTest, async (t) => {
  const response = deferred();
  t.after(response.open);
  const bot = await startBot(t, () => ({ wait: response.promise }));
  const stand = makeServerStand();
  t.after(() => fs.rmSync(path.dirname(stand.configFile), { recursive: true, force: true }));
  addTelegramConfig(stand, bot.apiBase);
  const service = await spawnTelegramService(stand);
  t.after(service.stop);
  const browser = new Browser();
  await browser.login(service.origin);
  const probing = browser.request(service.origin, '/legacy/settings/telegram/probe', { method: 'POST' });
  await waitFor(() => bot.requests.length === 1, 'Проба не началась');
  await terminate(service);
  await probing.catch(() => undefined);
  const count = bot.requests.length;
  await pause();
  assert.equal(bot.requests.length, count);
  response.open();
});

test('служба: SIGTERM во время отсрочки после 429', integrationTest, async (t) => {
  const bot = await startBot(t, () => ({ status: 429, body: '{"parameters":{"retry_after":300}}' }));
  const stand = makeServerStand();
  t.after(() => fs.rmSync(path.dirname(stand.configFile), { recursive: true, force: true }));
  addTelegramConfig(stand, bot.apiBase);
  waitingRunFixture(stand.dataDir, stand.root, { next: 'gate1' });
  const service = await spawnTelegramService(stand);
  t.after(service.stop);
  await waitFor(() => fs.existsSync(queueFile(stand.dataDir)) && Boolean(readQueue(stand.dataDir)[0]?.lastError), 'Отсрочка не сохранена');
  const beforeStop = fs.readFileSync(queueFile(stand.dataDir));
  await terminate(service);
  assert.deepEqual(fs.readFileSync(queueFile(stand.dataDir)), beforeStop);
  await pause();
  assert.equal(bot.requests.length, 1);
});

test('служба: битая очередь Telegram — ready отклонён, хост закрыт', integrationTest, async (t) => {
  const bot = await startBot(t);
  const stand = makeServerStand();
  t.after(() => fs.rmSync(path.dirname(stand.configFile), { recursive: true, force: true }));
  addTelegramConfig(stand, bot.apiBase);
  const config = JSON.parse(fs.readFileSync(stand.configFile, 'utf8')) as { port: number };
  config.port = await freePort();
  fs.writeFileSync(stand.configFile, JSON.stringify(config));
  fs.mkdirSync(path.dirname(queueFile(stand.dataDir)), { recursive: true });
  fs.writeFileSync(queueFile(stand.dataDir), '{broken');
  const distMain = fileURLToPath(new URL('../dist/server/main.js', import.meta.url));
  const child = spawn(process.execPath, [distMain, '--config', stand.configFile], { stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const [code, signal] = await within(once(child, 'exit'));
  assert.equal(code, 1, stderr);
  assert.equal(signal, null);
  assert.match(stderr, /Не удалось разобрать очередь Telegram/);

  fs.writeFileSync(queueFile(stand.dataDir), '[]');
  const service = await spawnTelegramService(stand);
  t.after(service.stop);
  const response = await fetch(`${service.origin}/login`);
  assert.equal(response.status, 200);
  await service.stop();
});
