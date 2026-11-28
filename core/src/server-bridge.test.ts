import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { CoreEvent } from './types.js';
import { Browser, PUBLIC_ORIGIN, configFor, listen, serverTestsSkip, startTestHost, waitingRunFixture } from './server-testkit.test.js';
import { createServerApp } from './server/main.js';
import { closeAllStreams, closeSessionStreams } from './server/bridge-http.js';

const linux = { skip: serverTestsSkip };

type CoreReply = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

async function encode(value: unknown): Promise<string> {
  return (await import('devalue')).stringify(value);
}

async function decode(response: Response): Promise<CoreReply> {
  return (await import('devalue')).parse(await response.text()) as CoreReply;
}

async function fixture(t: TestContext, opts: NonNullable<Parameters<typeof startTestHost>[0]> = {}) {
  const stand = await startTestHost(opts);
  const config = configFor(stand.dataDir, stand.project, stand.settings);
  const origin = await listen(t, createServerApp(config, stand.host));
  t.after(stand.close);
  t.after(() => closeAllStreams());
  const browser = new Browser();
  const login = await browser.login(origin);
  assert.equal(login.status, 303);
  return { ...stand, config, origin, browser };
}

async function postCore(browser: Browser, origin: string, method: string, body: unknown = [], headers?: HeadersInit): Promise<Response> {
  return browser.request(origin, `/api/core/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers },
    body: await encode(body),
  });
}

interface SseEvent {
  id: string;
  event: string;
  data: CoreEvent | Record<string, never>;
}

class SseClient {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  private buffer = '';

  constructor(response: Response) {
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.ok(response.body);
    this.reader = response.body.getReader();
  }

  async next(timeoutMs = 2_000): Promise<SseEvent> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.readEvent(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Событие SSE не пришло')), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async readEvent(): Promise<SseEvent> {
    for (;;) {
      const end = this.buffer.indexOf('\n\n');
      if (end !== -1) {
        const block = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        if (block.startsWith(':')) continue;
        const lines = block.split('\n');
        const data = lines
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6))
          .join('\n');
        return {
          id: lines.find((line) => line.startsWith('id: '))?.slice(4) ?? '',
          event: lines.find((line) => line.startsWith('event: '))?.slice(7) ?? 'message',
          data: JSON.parse(data) as CoreEvent,
        };
      }
      const chunk = await this.reader.read();
      if (chunk.done) throw new Error('Поток SSE закрылся до события');
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
  }

  async closed(): Promise<void> {
    for (;;) {
      const chunk = await this.reader.read();
      if (chunk.done) return;
    }
  }

  async close(): Promise<void> {
    await this.reader.cancel();
  }
}

async function openEvents(browser: Browser, origin: string, lastEventId?: string, headers: HeadersInit = {}): Promise<Response> {
  return browser.request(origin, '/api/events', {
    headers: { ...headers, ...(lastEventId === undefined ? {} : { 'Last-Event-ID': lastEventId }) },
  });
}

test('мост: без сессии все маршруты отвечают 401 и не вызывают ядро', linux, async (t) => {
  const { origin, core } = await fixture(t);
  let calls = 0;
  core.getRun = async (id) => {
    calls++;
    return { id } as never;
  };
  const anonymous = new Browser();

  assert.equal((await anonymous.request(origin, '/api/settings')).status, 401);
  assert.equal((await anonymous.request(origin, '/api/events')).status, 401);
  assert.equal((await postCore(anonymous, origin, 'getRun', ['missing'])).status, 401);
  assert.equal(calls, 0);
});

test('мост: вызов ядра, одинаковый forbidden, неизвестные методы и ошибки запроса', linux, async (t) => {
  const { origin, browser, core, dataDir, project } = await fixture(t);
  const own = waitingRunFixture(dataDir, project.path, { id: 'own-run', next: 'gate1' });
  const foreignPath = fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-foreign-'));
  t.after(() => fs.rmSync(foreignPath, { recursive: true, force: true }));
  const foreign = waitingRunFixture(dataDir, foreignPath, { id: 'foreign-run', next: 'gate1' });
  let calls = 0;
  const getRun = core.getRun.bind(core);
  core.getRun = async (id) => {
    calls++;
    return getRun(id);
  };

  const ownReply = await postCore(browser, origin, 'getRun', [own.id]);
  assert.equal(ownReply.status, 200);
  const ownBody = await decode(ownReply);
  assert.equal(ownBody.ok, true);
  assert.equal(ownBody.ok && (ownBody.result as { id: string }).id, own.id);

  const foreignReply = await postCore(browser, origin, 'getRun', [foreign.id]);
  const missingReply = await postCore(browser, origin, 'getRun', ['missing']);
  assert.equal(foreignReply.status, 403);
  assert.equal(missingReply.status, 403);
  assert.deepEqual(await decode(foreignReply), await decode(missingReply));
  assert.deepEqual(await postCore(browser, origin, 'getRun', [foreign.id]).then(decode), {
    ok: false,
    error: { code: 'forbidden', message: 'Нет доступа' },
  });
  assert.equal(calls, 1);

  assert.equal((await postCore(browser, origin, '__proto__')).status, 404);
  assert.equal((await postCore(browser, origin, 'constructor')).status, 404);
  assert.equal((await postCore(browser, origin, 'getRun', { id: own.id })).status, 400);
  const malformed = await browser.request(origin, '/api/core/getRun', {
    method: 'POST',
    body: 'не devalue',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await postCore(browser, origin, 'getRun', [own.id], { Origin: 'https://foreign.example' })).status, 403);
  assert.equal(calls, 1);
});

test('мост: тело больше 32 МиБ отклоняется до разбора', linux, async (t) => {
  const { origin, browser } = await fixture(t);
  const response = await browser.request(origin, '/api/core/getRun', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: ' '.repeat(32 * 1024 * 1024 + 1),
  });
  assert.equal(response.status, 413);
});

test('мост: sendChat сохраняет байты Uint8Array', linux, async (t) => {
  const { origin, browser, core, project } = await fixture(t);
  const chat = await core.createChat({ projectPath: project.path });
  let received: Uint8Array | undefined;
  core.sendChat = async (_id, _text, files) => {
    received = files?.[0]?.data;
  };

  const response = await postCore(browser, origin, 'sendChat', [
    chat.id,
    'Байты',
    [{ name: 'raw.bin', data: new Uint8Array([0, 255, 7]) }],
  ]);
  assert.equal(response.status, 200);
  assert.deepEqual(await decode(response), { ok: true, result: undefined });
  assert.ok(received instanceof Uint8Array);
  assert.deepEqual([...received], [0, 255, 7]);
});

test('мост: настройки не содержат apiKey и окружение агентов', linux, async (t) => {
  const settings = {
    toolPaths: {},
    proxy: { baseUrl: 'https://proxy.example', codexBaseUrl: 'https://codex.example', apiKey: 'proxy-secret-123' },
    models: { planner: '', executor: '', reviewer: '' },
    agents: { planner: 'claude' as const, executor: 'claude' as const, reviewer: 'claude' as const },
    enabledAgents: ['claude' as const],
    agentTimeoutMin: 5,
    testTimeoutMin: 2,
    maxParallel: 2,
    claudeAuth: 'env' as const,
    userConfig: false,
  };
  const { origin, browser } = await fixture(t, { settings });
  const response = await browser.request(origin, '/api/settings');
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.doesNotMatch(text, /proxy-secret-123|apiKey|agentEnv/);
  assert.deepEqual(JSON.parse(text).proxy, { baseUrl: 'https://proxy.example', codexBaseUrl: 'https://codex.example', hasKey: true });
  assert.equal(JSON.parse(text).claudeAuth, 'env');
});

test('мост: секреты редактируются в результате, ошибке и событии', linux, async (t) => {
  const agentSecret = 'agent-secret-12345';
  const { origin, browser, core, dataDir, project } = await fixture(t, {
    agentEnv: { ...process.env, ANTHROPIC_API_KEY: agentSecret },
  });
  const run = waitingRunFixture(dataDir, project.path, { id: 'own-run', next: 'gate1' });
  core.testConnection = async () => [{ agent: 'claude', ok: false, model: '', durationMs: 1, error: `Ключ: ${agentSecret}` }];
  const result = await postCore(browser, origin, 'testConnection');
  const resultText = await result.text();
  assert.doesNotMatch(resultText, new RegExp(agentSecret));
  assert.match(resultText, /\*\*\*/);

  core.testConnection = async () => {
    throw new Error(`Ошибка ${agentSecret}`);
  };
  const failure = await decode(await postCore(browser, origin, 'testConnection'));
  assert.deepEqual(failure, { ok: false, error: { code: 'error', message: 'Ошибка ***' } });

  const stream = new SseClient(await openEvents(browser, origin));
  core.kernel.emit({ type: 'agent.output', runId: run.id, stage: 'implement', text: `Вывод ${agentSecret}` });
  const event = await stream.next();
  assert.equal(event.event, 'agent.output');
  assert.equal(event.data.type === 'agent.output' && event.data.text, 'Вывод ***');
  await stream.close();
});

test('поток: повтор после Last-Event-ID, reset и фильтр чужих событий', linux, async (t) => {
  const { origin, browser, core, dataDir, project } = await fixture(t);
  const own = waitingRunFixture(dataDir, project.path, { id: 'own-run', next: 'gate1' });
  const foreignPath = fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-foreign-event-'));
  t.after(() => fs.rmSync(foreignPath, { recursive: true, force: true }));
  const foreign = waitingRunFixture(dataDir, foreignPath, { id: 'foreign-run', next: 'gate1' });
  const output = (runId: string, text: string): CoreEvent => ({ type: 'agent.output', runId, stage: 'implement', text });

  const first = new SseClient(await openEvents(browser, origin));
  core.kernel.emit(output(own.id, 'один'));
  const initial = await first.next();
  assert.match(initial.id, /^[a-f0-9]+-1$/);
  await first.close();
  core.kernel.emit(output(own.id, 'два'));
  core.kernel.emit(output(own.id, 'три'));

  const replayed = new SseClient(await openEvents(browser, origin, initial.id));
  const second = await replayed.next();
  const third = await replayed.next();
  assert.equal(second.data.type === 'agent.output' && second.data.text, 'два');
  assert.equal(third.data.type === 'agent.output' && third.data.text, 'три');
  core.kernel.emit(output(foreign.id, 'чужой'));
  core.kernel.emit(output(own.id, 'четыре'));
  const fourth = await replayed.next();
  assert.equal(fourth.data.type === 'agent.output' && fourth.data.text, 'четыре');
  await replayed.close();

  const reset = new SseClient(await openEvents(browser, origin, 'other-epoch-1'));
  assert.equal((await reset.next()).event, 'reset');
  await reset.close();
});

test('поток: Origin и Sec-Fetch-Site проверяются, отсутствие заголовков допустимо', linux, async (t) => {
  const { origin, browser } = await fixture(t);
  assert.equal((await openEvents(browser, origin, undefined, { Origin: 'https://foreign.example' })).status, 403);
  assert.equal((await openEvents(browser, origin, undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const sameOrigin = new SseClient(
    await openEvents(browser, origin, undefined, { Origin: PUBLIC_ORIGIN, 'Sec-Fetch-Site': 'same-origin' }),
  );
  await sameOrigin.close();
});

test('поток: потоки закрываются по токену сессии и все сразу', linux, async (t) => {
  const { origin, browser, core, dataDir, project } = await fixture(t);
  const run = waitingRunFixture(dataDir, project.path, { id: 'own-run', next: 'gate1' });
  const secondBrowser = new Browser();
  assert.equal((await secondBrowser.login(origin)).status, 303);
  const first = new SseClient(await openEvents(browser, origin));
  const second = new SseClient(await openEvents(secondBrowser, origin));

  closeSessionStreams(browser.sessionToken);
  await first.closed();
  core.kernel.emit({ type: 'agent.output', runId: run.id, stage: 'implement', text: 'второй сессии' });
  assert.equal((await second.next()).event, 'agent.output');

  const firstAgain = new SseClient(await openEvents(browser, origin));
  closeAllStreams();
  await Promise.all([firstAgain.closed(), second.closed()]);
});

test('мост: close ждёт принятый вызов и отклоняет новые', linux, async (t) => {
  const { origin, browser, core, host, project } = await fixture(t);
  const chat = await core.createChat({ projectPath: project.path });
  let calls = 0;
  let markEntered = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => (markEntered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  core.deleteChat = async () => {
    calls++;
    markEntered();
    await gate;
  };

  const acceptedResponse = postCore(browser, origin, 'deleteChat', [chat.id]);
  await entered;
  let closed = false;
  const closing = host.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(closed, false);
  release();
  assert.equal((await acceptedResponse).status, 200);
  await closing;

  const rejected = await postCore(browser, origin, 'deleteChat', [chat.id]);
  assert.equal(rejected.status, 503);
  assert.deepEqual(await decode(rejected), {
    ok: false,
    error: { code: 'shutting-down', message: 'Служба останавливается' },
  });
  assert.equal(calls, 1);
});
