import './server/web-assets.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { test, type TestContext } from 'node:test';
import { checkOrigin, createSessions, isReturnRoute, readBody, registerReturnRoute, rejectBody } from './server/session.js';

test('сессия: два независимых входа действуют одновременно', () => {
  const sessions = createSessions({ secret: 'секрет' });
  const first = sessions.login('секрет');
  const second = sessions.login('секрет');

  assert.equal(first.kind, 'token');
  assert.equal(second.kind, 'token');
  if (first.kind !== 'token' || second.kind !== 'token') return;
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.token, second.token);
  assert.equal(sessions.validate(first.token), true);
  assert.equal(sessions.validate(second.token), true);
});

test('сессия: истекает через 12 часов по подставным часам', () => {
  let now = 1_000_000;
  const sessions = createSessions({ secret: 'секрет', now: () => now });
  const result = sessions.login('секрет');
  assert.equal(result.kind, 'token');
  if (result.kind !== 'token') return;

  now += 12 * 60 * 60 * 1000 - 1;
  assert.equal(sessions.validate(result.token), true);
  now += 1;
  assert.equal(sessions.validate(result.token), false);
});

test('сессия: выход отзывает только текущую, новый экземпляр не принимает старый идентификатор', () => {
  const sessions = createSessions({ secret: 'секрет' });
  const first = sessions.login('секрет');
  const second = sessions.login('секрет');
  assert.equal(first.kind, 'token');
  assert.equal(second.kind, 'token');
  if (first.kind !== 'token' || second.kind !== 'token') return;

  sessions.logout(first.token);
  assert.equal(sessions.validate(first.token), false);
  assert.equal(sessions.validate(second.token), true);

  const restarted = createSessions({ secret: 'секрет' });
  assert.equal(restarted.validate(first.token), false);
  assert.equal(restarted.validate(second.token), false);
});

test('сессия: неверный секрет — invalid, шестой неверный вход за минуту — rateLimited, через минуту по подставным часам снова invalid', () => {
  let now = 50_000;
  const sessions = createSessions({ secret: 'правильно', now: () => now });

  for (let attempt = 0; attempt < 5; attempt++) {
    assert.deepEqual(sessions.login('неверно'), { kind: 'invalid' });
  }
  assert.deepEqual(sessions.login('неверно'), { kind: 'rateLimited', retryAfterSec: 60 });

  now += 30_000;
  assert.deepEqual(sessions.login('неверно'), { kind: 'rateLimited', retryAfterSec: 30 });
  now += 30_000;
  assert.deepEqual(sessions.login('неверно'), { kind: 'invalid' });
});

async function listen(t: TestContext, handler: http.RequestListener) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { origin: `http://127.0.0.1:${address.port}`, port: address.port };
}

function tokenOf(result: ReturnType<ReturnType<typeof createSessions>['login']>): string {
  assert.equal(result.kind, 'token');
  if (result.kind !== 'token') throw new Error('Вход не выполнен');
  return result.token;
}

test('защита: без сессии API 401, страница 303 на вход с returnTo', async (t) => {
  const sessions = createSessions({ secret: 'секрет' });
  let coreCalls = 0;
  const { origin } = await listen(t, (req, res) => {
    if (!sessions.guard(req, res)) return;
    coreCalls++;
    res.end('ok');
  });
  const runId = crypto.randomUUID();

  const api = await fetch(`${origin}/api/overview`);
  assert.equal(api.status, 401);
  assert.equal(coreCalls, 0);

  const page = await fetch(`${origin}/runs/${runId}`, { redirect: 'manual' });
  assert.equal(page.status, 303);
  const location = new URL(page.headers.get('location') ?? '', origin);
  assert.equal(location.pathname, '/login');
  assert.equal(location.searchParams.get('returnTo'), `/runs/${runId}`);
  assert.equal(coreCalls, 0);

  const token = tokenOf(sessions.login('секрет'));
  const allowed = await fetch(`${origin}/api/overview`, { headers: { Cookie: `pf_session=${token}` } });
  assert.equal(allowed.status, 200);
  assert.equal(coreCalls, 1);
});

test('защита: сессия одного экземпляра createSessions не проходит guard другого', async (t) => {
  const first = createSessions({ secret: 'секрет' });
  const second = createSessions({ secret: 'секрет' });
  const token = tokenOf(first.login('секрет'));
  let coreCalls = 0;
  const { origin } = await listen(t, (req, res) => {
    if (!second.guard(req, res)) return;
    coreCalls++;
    res.end('ok');
  });

  const response = await fetch(`${origin}/api/overview`, { headers: { Cookie: `pf_session=${token}` } });
  assert.equal(response.status, 401);
  assert.equal(coreCalls, 0);
});

test('защита: чужой Origin, неверный секрет и протухшая сессия не вызывают ядро', async (t) => {
  let now = 0;
  const sessions = createSessions({ secret: 'секрет', ttlMs: 1000, now: () => now });
  let coreCalls = 0;
  const { origin } = await listen(t, async (req, res) => {
    if (req.method === 'POST' && req.url === '/login') {
      if (!checkOrigin(req, origin)) {
        res.writeHead(403).end();
        return;
      }
      const body = await readBody(req);
      if (body.kind === 'bodyTooLarge' || body.kind === 'timeout') {
        rejectBody(res, body.kind);
        return;
      }
      if (body.kind === 'aborted') return;
      const result = sessions.login(new URLSearchParams(body.body).get('secret') ?? '');
      if (result.kind === 'invalid') {
        res.writeHead(401).end();
        return;
      }
      if (result.kind === 'rateLimited') {
        res.writeHead(429).end();
        return;
      }
      coreCalls++;
      res.end(result.token);
      return;
    }
    if (!sessions.guard(req, res)) return;
    coreCalls++;
    res.end('ok');
  });

  const wrongOrigin = await fetch(`${origin}/login`, {
    method: 'POST',
    headers: { Origin: 'https://attacker.example' },
    body: 'secret=секрет',
  });
  assert.equal(wrongOrigin.status, 403);
  assert.equal(coreCalls, 0);

  const missingOrigin = await fetch(`${origin}/login`, { method: 'POST', body: 'secret=секрет' });
  assert.equal(missingOrigin.status, 403);
  assert.equal(coreCalls, 0);

  const invalid = await fetch(`${origin}/login`, { method: 'POST', headers: { Origin: origin }, body: 'secret=неверно' });
  assert.equal(invalid.status, 401);
  assert.equal(coreCalls, 0);

  const entered = await fetch(`${origin}/login`, { method: 'POST', headers: { Origin: origin }, body: 'secret=секрет' });
  assert.equal(entered.status, 200);
  const token = await entered.text();
  assert.equal(coreCalls, 1);
  coreCalls = 0;

  now = 1000;
  const expired = await fetch(`${origin}/`, { headers: { Cookie: `pf_session=${token}` }, redirect: 'manual' });
  assert.equal(expired.status, 303);
  assert.equal(coreCalls, 0);
});

test('защита: тело входа больше 16 КиБ потоком — клиент получает статус 413 с Connection: close, обработчик не копит больше лимита', async (t) => {
  const { origin } = await listen(t, async (req, res) => {
    const result = await readBody(req);
    if (result.kind === 'bodyTooLarge' || result.kind === 'timeout') {
      rejectBody(res, result.kind);
      return;
    }
    if (result.kind === 'aborted') return;
    res.end(result.body);
  });

  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const request = http.request(`${origin}/login`, { method: 'POST' }, resolve);
    request.on('error', reject);
    request.write(Buffer.alloc(16 * 1024, 'a'));
    request.write(Buffer.alloc(1, 'b'));
    request.end();
  });
  assert.equal(response.statusCode, 413);
  assert.equal(response.headers.connection, 'close');
  response.resume();
  await once(response, 'end');
});

test('защита: тело не дослано дольше timeoutMs — клиент получает 408', async (t) => {
  const { origin } = await listen(t, async (req, res) => {
    const result = await readBody(req, { timeoutMs: 25 });
    if (result.kind === 'bodyTooLarge' || result.kind === 'timeout') {
      rejectBody(res, result.kind);
      return;
    }
    if (result.kind === 'aborted') return;
    res.end(result.body);
  });

  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const request = http.request(`${origin}/login`, { method: 'POST', headers: { 'Content-Length': 1000 } }, resolve);
    t.after(() => request.destroy());
    request.on('error', reject);
    request.write('1234567890');
  });
  assert.equal(response.statusCode, 408);
  assert.equal(response.headers.connection, 'close');
  response.resume();
  await once(response, 'end');
});

test('защита: клиент оборвал частичное тело — readBody один раз даёт aborted, процесс жив, следующий вход обслуживается', async (t) => {
  const outcomes: string[] = [];
  const { origin, port } = await listen(t, async (req, res) => {
    if (req.url === '/login') {
      const result = await readBody(req, { timeoutMs: 1000 });
      outcomes.push(result.kind);
      if (result.kind === 'bodyTooLarge' || result.kind === 'timeout') rejectBody(res, result.kind);
      if (result.kind === 'ok') res.end(result.body);
      return;
    }
    res.end('ok');
  });

  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => {});
  await once(socket, 'connect');
  await new Promise<void>((resolve) => {
    socket.write('POST /login HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 1000\r\n\r\n1234567890', () => {
      socket.destroy();
      resolve();
    });
  });
  for (let attempt = 0; attempt < 100 && outcomes.length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(outcomes, ['aborted']);

  const next = await fetch(`${origin}/health`);
  assert.equal(next.status, 200);
  assert.equal(await next.text(), 'ok');
});

test('тело: содержимое до лимита возвращается один раз', async (t) => {
  const { origin } = await listen(t, async (req, res) => {
    const result = await readBody(req, { limit: 5 });
    if (result.kind === 'bodyTooLarge' || result.kind === 'timeout') {
      rejectBody(res, result.kind);
      return;
    }
    if (result.kind === 'aborted') return;
    res.end(result.body);
  });

  const exact = await fetch(`${origin}/`, { method: 'POST', body: '12345' });
  assert.equal(exact.status, 200);
  assert.equal(await exact.text(), '12345');

  const excess = await fetch(`${origin}/`, { method: 'POST', body: '123456' });
  assert.equal(excess.status, 413);
});

test('возврат: /runs/<UUID> принят; //attacker.example, https://x, /runs/../x и неизвестный путь заменены на /', () => {
  const runId = crypto.randomUUID();
  assert.equal(isReturnRoute('/'), '/');
  assert.equal(isReturnRoute(`/runs/${runId}`), `/runs/${runId}`);
  for (const unsafe of ['//attacker.example', 'https://x', '/runs/../x', '/unknown', '/\\attacker.example']) {
    assert.equal(isReturnRoute(unsafe), '/');
  }

  registerReturnRoute(/^\/logs\/[a-z0-9-]+$/);
  assert.equal(isReturnRoute('/logs/main'), '/logs/main');
  assert.equal(isReturnRoute('/logs/../main'), '/');
});

test('возврат: точки внутри проекта допустимы, обход сегмента и испорченная кодировка отклонены', () => {
  assert.equal(isReturnRoute('/projects/%2Ftmp%2Frepo..demo'), '/projects/%2Ftmp%2Frepo..demo');
  assert.equal(isReturnRoute('/chats?project=%2Ftmp%2Frepo..demo'), '/chats?project=%2Ftmp%2Frepo..demo');
  assert.equal(isReturnRoute('/chats?project=%2Ftmp%2F%D0%BF'), '/chats?project=%2Ftmp%2F%D0%BF');
  assert.equal(isReturnRoute('/chats?project=x&evil=1'), '/chats');
  assert.equal(isReturnRoute('/chats?other=1'), '/chats');
  for (const unsafe of ['/projects/..', '/projects/%2E%2E', '/runs/../x', '//evil', '/a\\b', '/projects/%E0%A4%A']) {
    assert.equal(isReturnRoute(unsafe), '/', unsafe);
  }
});
