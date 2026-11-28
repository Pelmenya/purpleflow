import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { parse, stringify } from 'devalue';
import type { CoreEvent } from '@purpleflow/core';
import { createWebBridge, type WebBridgeDeps } from './bridge';
import { WEB_BRIDGE_PLAN } from './plan';

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;
type Listener = (event: MessageEvent) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readyState = 0;
  private listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, data = ''): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data } as MessageEvent);
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
});

function devalueResponse(value: unknown, status = 200): Response {
  return new Response(stringify(value), { status });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

function fixture(handler: FetchHandler = async () => devalueResponse({ ok: true, result: null })) {
  const requests: { url: string; init?: RequestInit }[] = [];
  const assigned: string[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let reloads = 0;
  const deps: WebBridgeDeps = {
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      return handler(url, init);
    },
    EventSource: FakeEventSource as unknown as WebBridgeDeps['EventSource'],
    location: {
      pathname: '/runs/r1',
      search: '?tab=code',
      reload: () => {
        reloads++;
      },
      assign: (url) => assigned.push(url),
    },
    setTimeout: ((fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return timers.length;
    }) as WebBridgeDeps['setTimeout'],
  };
  return {
    bridge: createWebBridge(deps),
    requests,
    assigned,
    timers,
    get reloads() {
      return reloads;
    },
  };
}

function memberPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return prefix ? [prefix] : [];
  const paths: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (path === 'core') continue;
    if (child && typeof child === 'object') paths.push(...memberPaths(child, path));
    else paths.push(path);
  }
  return paths.sort();
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('веб-мост и WEB_BRIDGE_PLAN содержат одинаковые полные пути без масок', () => {
  const { bridge } = fixture();
  assert.deepEqual(memberPaths(bridge), Object.keys(WEB_BRIDGE_PLAN).sort());
  assert.equal(
    Object.keys(WEB_BRIDGE_PLAN).some((path) => path.includes('*')),
    false,
  );
});

test('core.getRun отправляет devalue и возвращает результат службы', async () => {
  const { bridge, requests } = fixture(async () => devalueResponse({ ok: true, result: { id: 'r1' } }));
  assert.deepEqual(await bridge.core.getRun('r1'), { id: 'r1' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/core/getRun');
  assert.equal(requests[0].init?.method, 'POST');
  assert.equal(requests[0].init?.credentials, 'same-origin');
  assert.equal(requests[0].init?.body, stringify(['r1']));
});

test('ошибка службы сохраняет сообщение и code, ответ без devalue сообщает статус', async () => {
  const responses = [
    devalueResponse({ ok: false, error: { message: 'Нет доступа', code: 'forbidden' } }),
    new Response('Не найдено', { status: 404 }),
  ];
  const { bridge } = fixture(async () => responses.shift()!);
  await assert.rejects(bridge.core.getRun('r1'), (error: unknown) => {
    assert.equal(error instanceof Error && error.message, 'Нет доступа');
    assert.equal((error as Error & { code?: string }).code, 'forbidden');
    return true;
  });
  await assert.rejects(bridge.core.getRun('r1'), /Служба ответила 404/);
});

test('ответ 401 ведёт на вход с возвратом на текущий адрес', async () => {
  const { bridge, assigned } = fixture(async () => new Response('Войдите', { status: 401 }));
  await assert.rejects(bridge.core.getRun('r1'), /Служба ответила 401/);
  assert.deepEqual(assigned, [`/login?returnTo=${encodeURIComponent('/runs/r1?tab=code')}`]);
});

test('core.sendChat сохраняет байты вложений в теле запроса', async () => {
  const { bridge, requests } = fixture(async () => devalueResponse({ ok: true, result: undefined }));
  const files = [{ name: 'a.png', data: new Uint8Array([1, 2]) }];
  await bridge.core.sendChat('c1', 't', files);
  const args = parse(String(requests[0].init?.body)) as Parameters<typeof bridge.core.sendChat>;
  assert.deepEqual(args, ['c1', 't', files]);
  assert.deepEqual(args[2]?.[0].data, new Uint8Array([1, 2]));
});

test('два подписчика делят один поток, reset перезагружает один раз, отписка прекращает доставку', () => {
  const stand = fixture();
  const { bridge } = stand;
  const first: CoreEvent[] = [];
  const second: CoreEvent[] = [];
  const offFirst = bridge.onEvent((event) => first.push(event));
  bridge.onEvent((event) => second.push(event));
  assert.equal(FakeEventSource.instances.length, 1);
  assert.equal(FakeEventSource.instances[0].url, '/api/events');
  const event: CoreEvent = { type: 'run.deleted', runId: 'r1' };
  const source = FakeEventSource.instances[0];
  source.emit('message', stringify(event));
  assert.deepEqual(first, [event]);
  assert.deepEqual(second, [event]);
  source.emit('reset', '{}');
  source.emit('reset', '{}');
  assert.equal(stand.reloads, 1);
  offFirst();
  source.emit('message', stringify(event));
  assert.equal(first.length, 1);
  assert.equal(second.length, 2);
});

test('именованные SSE службы доставляются подписчикам', () => {
  const { bridge } = fixture();
  const events: CoreEvent[] = [];
  bridge.onEvent((event) => events.push(event));
  const event: CoreEvent = { type: 'run.deleted', runId: 'r1' };
  FakeEventSource.instances[0].emit('run.deleted', JSON.stringify(event));
  assert.deepEqual(events, [event]);
});

test('недоступные вызовы завершаются ошибкой, результатом AccountResult или отпиской', async () => {
  const { bridge } = fixture();
  const picking = bridge.pickFolder();
  await assert.rejects(picking, /Недоступно в браузере до Ф9/);
  let chimed = false;
  const off = bridge.onChime(() => {
    chimed = true;
  });
  assert.equal(typeof off, 'function');
  off();
  assert.equal(chimed, false);
  assert.deepEqual(await bridge.account.keys(), { ok: false, error: 'Недоступно в браузере до Ф11' });
  assert.doesNotThrow(() => bridge.setupStep('settings'));
});

test('безопасные значения браузерного моста соответствуют таблице', async () => {
  const { bridge } = fixture();
  assert.equal(bridge.web, true);
  assert.equal(bridge.platform, 'web');
  assert.equal(bridge.material, 'none');
  assert.equal(bridge.reportsErrors, false);
  assert.equal(bridge.pathForFile(new File([], 'a.txt')), '');
  assert.deepEqual(await bridge.update.state(), { kind: 'idle' });
  assert.equal(await bridge.proxyModels(), null);
  assert.deepEqual(await bridge.dictation.status(), { engine: false, models: [] });
  assert.deepEqual(await bridge.whatsNew.versions(), { current: '', seen: '' });
  assert.deepEqual(await bridge.whatsNew.releases(), { releases: [] });
  assert.equal(await bridge.whatsNew.seen(), undefined);
});

test('settings.get дополняет настройки службы браузерными полями', async () => {
  const server = {
    toolPaths: { claude: '/bin/claude' },
    models: { claude: 'opus' },
    efforts: { claude: 'high' },
    agents: { plan: 'claude' },
    enabledAgents: ['claude'],
    agentTimeoutMin: 10,
    testTimeoutMin: 20,
    maxParallel: 2,
    claudeAuth: 'env',
    userConfig: true,
    proxy: { baseUrl: 'https://proxy.example', hasKey: true },
  };
  const { bridge, requests } = fixture(async () => jsonResponse(server));
  assert.deepEqual(await bridge.settings.get(), {
    ...server,
    proxy: { baseUrl: 'https://proxy.example', codexBaseUrl: '', hasKey: true, enabled: true },
    onboarded: true,
    authPrompted: true,
    accountEnabled: false,
    diagnostics: false,
    windowGlass: false,
    notify: false,
    sound: false,
    unreadable: false,
    account: null,
  });
  assert.equal(requests[0].url, '/api/settings');
  assert.equal(requests[0].init?.method, 'GET');
  assert.equal(requests[0].init?.credentials, 'same-origin');
});

test('401 на settings.get ведёт на вход', async () => {
  const { bridge, assigned } = fixture(async () => new Response('Войдите', { status: 401 }));
  await assert.rejects(bridge.settings.get(), /Служба ответила 401/);
  assert.deepEqual(assigned, [`/login?returnTo=${encodeURIComponent('/runs/r1?tab=code')}`]);
});

test('закрытый поток запускает одну проверку сессии и 401 ведёт на вход', async () => {
  const { bridge, requests, assigned } = fixture(async () => new Response('Войдите', { status: 401 }));
  bridge.onEvent(() => {});
  const source = FakeEventSource.instances[0];
  source.readyState = 2;
  source.emit('error');
  source.emit('error');
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/settings');
  assert.equal(requests[0].init?.method, 'GET');
  assert.deepEqual(assigned, [`/login?returnTo=${encodeURIComponent('/runs/r1?tab=code')}`]);
});

test('после 503 проверка повторяется через две секунды, 200 перезагружает без нового потока', async () => {
  const statuses = [503, 200];
  const stand = fixture(async () => jsonResponse({}, statuses.shift()));
  const { bridge, requests, timers } = stand;
  bridge.onEvent(() => {});
  const source = FakeEventSource.instances[0];
  source.readyState = 2;
  source.emit('error');
  source.emit('error');
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 2000);
  timers[0].fn();
  await settle();
  assert.equal(requests.length, 2);
  assert.equal(stand.reloads, 1);
  assert.equal(FakeEventSource.instances.length, 1);
});

test('сетевой сбой повторяет проверку, а CONNECTING её не запускает', async () => {
  let fails = true;
  const stand = fixture(async () => {
    if (fails) {
      fails = false;
      throw new TypeError('Сеть недоступна');
    }
    return jsonResponse({});
  });
  const { bridge, requests, timers } = stand;
  bridge.onEvent(() => {});
  const source = FakeEventSource.instances[0];
  source.emit('error');
  await settle();
  assert.equal(requests.length, 0);
  source.readyState = 2;
  source.emit('error');
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(timers.length, 1);
  timers[0].fn();
  await settle();
  assert.equal(requests.length, 2);
  assert.equal(stand.reloads, 1);
});
