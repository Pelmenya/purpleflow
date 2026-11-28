import './server/web-assets.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { startService } from './server/main.js';
import { hashSecret } from './server/secret.js';
import { readLoginSecret } from './server/secret.js';
import { checkOrigin, createSessions, isReturnRoute, readBody, registerReturnRoute, rejectBody, sessionsFor } from './server/session.js';
import { configFor, serverTestsSkip, startTestHost } from './server-testkit.test.js';

const SECRET = 'секрет';
const SECRET_HASH = hashSecret(SECRET);
const SESSION_TTL = 12 * 60 * 60 * 1000;

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-server-session-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('сессия: два независимых входа действуют одновременно', () => {
  const sessions = createSessions({ secret: SECRET });
  const first = sessions.login(SECRET);
  const second = sessions.login(SECRET);

  assert.equal(first.kind, 'token');
  assert.equal(second.kind, 'token');
  if (first.kind !== 'token' || second.kind !== 'token') return;
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.token, second.token);
  assert.equal(sessions.validate(first.token), true);
  assert.equal(sessions.validate(second.token), true);
});

test('сессия: абсолютный срок и хеш токена сохраняются после рестарта', (t) => {
  const file = path.join(tempDir(t), 'server', 'sessions.json');
  let now = 1_000_000;
  const sessions = createSessions({ secretHash: SECRET_HASH, file, now: () => now });
  const result = sessions.login(SECRET);
  assert.equal(result.kind, 'token');
  if (result.kind !== 'token') return;
  assert.equal(result.maxAgeSec, SESSION_TTL / 1000);
  assert.equal(sessions.expiresAt(result.token), now + SESSION_TTL);
  assert.equal(fs.readFileSync(file, 'utf8').includes(result.token), false);

  const restarted = createSessions({ secretHash: SECRET_HASH, file, now: () => now });
  now += SESSION_TTL - 1;
  assert.equal(restarted.validate(result.token), true);
  assert.equal(restarted.expiresAt(result.token), 1_000_000 + SESSION_TTL);
  now += 1;
  assert.equal(restarted.validate(result.token), false);
  assert.equal(restarted.expiresAt(result.token), undefined);
});

test('сессия: выход отзывает только текущую, выход везде отзывает все и переживает рестарт', (t) => {
  const file = path.join(tempDir(t), 'sessions.json');
  const sessions = createSessions({ secretHash: SECRET_HASH, file });
  const first = tokenOf(sessions.login(SECRET));
  const second = tokenOf(sessions.login(SECRET));

  sessions.logout(first);
  assert.equal(sessions.validate(first), false);
  assert.equal(sessions.validate(second), true);
  const restarted = createSessions({ secretHash: SECRET_HASH, file });
  assert.equal(restarted.validate(first), false);
  assert.equal(restarted.validate(second), true);

  restarted.logoutAll();
  const afterLogoutAll = createSessions({ secretHash: SECRET_HASH, file });
  assert.equal(afterLogoutAll.validate(first), false);
  assert.equal(afterLogoutAll.validate(second), false);
});

test('сессия: десятая неудача блокирует вход на 15 минут, верный секрет тоже отклонён', () => {
  let now = 50_000;
  const sessions = createSessions({ secret: 'правильно', now: () => now });

  for (let attempt = 0; attempt < 9; attempt++) assert.deepEqual(sessions.login('неверно'), { kind: 'invalid' });
  assert.deepEqual(sessions.login('неверно'), { kind: 'rateLimited', retryAfterSec: 900 });
  assert.deepEqual(sessions.login('правильно'), { kind: 'rateLimited', retryAfterSec: 900 });

  now += 450_000;
  assert.deepEqual(sessions.login('правильно'), { kind: 'rateLimited', retryAfterSec: 450 });
  now += 450_000;
  assert.equal(sessions.login('правильно').kind, 'token');
});

test('сессия: успешный вход до блокировки обнуляет счётчик неудач', () => {
  const sessions = createSessions({ secret: 'правильно' });
  for (let attempt = 0; attempt < 9; attempt++) assert.equal(sessions.login('неверно').kind, 'invalid');
  assert.equal(sessions.login('правильно').kind, 'token');
  for (let attempt = 0; attempt < 9; attempt++) assert.equal(sessions.login('неверно').kind, 'invalid');
  assert.equal(sessions.login('неверно').kind, 'rateLimited');
});

test('сессия: другой секрет отзывает старый токен без изменения файла при создании', (t) => {
  const file = path.join(tempDir(t), 'sessions.json');
  const sessions = createSessions({ secretHash: SECRET_HASH, file });
  const token = tokenOf(sessions.login(SECRET));
  const before = fs.readFileSync(file);
  const mtime = fs.statSync(file).mtimeMs;

  const changed = createSessions({ secret: 'другой секрет', file });
  assert.equal(changed.validate(token), false);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
});

test(
  'сессия: файл сохраняет права 0600 при повторной записи с umask 022',
  { skip: process.platform !== 'linux' },
  (t) => {
    const file = path.join(tempDir(t), 'sessions.json');
    const previous = process.umask(0o022);
    t.after(() => process.umask(previous));
    const sessions = createSessions({ secretHash: SECRET_HASH, file });
    const first = tokenOf(sessions.login(SECRET));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    tokenOf(sessions.login(SECRET));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    sessions.logout(first);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  },
);

test('сессия: sessionsFor создаёт каталог server только при первом входе', (t) => {
  const dataDir = tempDir(t);
  const project = path.join(dataDir, 'project');
  fs.mkdirSync(project);
  const config = configFor(dataDir, { id: 'project', path: project });
  const file = path.join(dataDir, 'server', 'sessions.json');
  assert.equal(fs.existsSync(path.dirname(file)), false);
  const sessions = sessionsFor(config);
  assert.equal(fs.existsSync(file), false);

  const token = tokenOf(sessions.login('секрет владельца'));
  if (process.platform === 'linux') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const restarted = sessionsFor(config);
  assert.equal(restarted.validate(token), true);
});

test('сессия: второй startService с другим секретом не меняет хранилище до отказа dataDir', { skip: serverTestsSkip }, async (t) => {
  const stand = await startTestHost();
  await stand.close();
  const config = configFor(stand.dataDir, stand.project, stand.settings);
  const file = path.join(stand.dataDir, 'server', 'sessions.json');
  const seeded = createSessions({ secretHash: readLoginSecret(config.secretFile), file });
  tokenOf(seeded.login('секрет владельца'));
  const before = fs.readFileSync(file);
  const mtime = fs.statSync(file).mtimeMs;

  const first = await startService(config);
  t.after(() => first.stop());
  await first.ready;
  const otherSecret = path.join(stand.dataDir, 'other-secret');
  fs.writeFileSync(otherSecret, hashSecret('другой секрет'), { mode: 0o600 });
  const second = await startService({ ...config, secretFile: otherSecret });
  t.after(() => second.stop().catch(() => {}));
  await assert.rejects(second.ready, /Каталог данных уже обслуживается/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
});

test('сессия: сбой записи не меняет память и не выдаёт новый токен', (t) => {
  const file = path.join(tempDir(t), 'sessions.json');
  const sessions = createSessions({ secretHash: SECRET_HASH, file });
  const first = tokenOf(sessions.login(SECRET));
  const saved = fs.readFileSync(file);
  fs.rmSync(file);
  fs.mkdirSync(path.join(file, 'nonempty'), { recursive: true });

  for (let attempt = 0; attempt < 9; attempt++) assert.equal(sessions.login('неверно').kind, 'invalid');
  assert.deepEqual(sessions.login(SECRET), { kind: 'unavailable' });
  assert.throws(() => sessions.logout(first));
  assert.throws(() => sessions.logoutAll());
  assert.equal(sessions.validate(first), true);

  fs.rmSync(file, { recursive: true });
  fs.writeFileSync(file, saved, { mode: 0o600 });
  assert.deepEqual(sessions.login('неверно'), { kind: 'rateLimited', retryAfterSec: 900 });
  const restarted = createSessions({ secretHash: SECRET_HASH, file });
  assert.equal(restarted.validate(first), true);
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
      if (result.kind === 'unavailable') {
        res.writeHead(503).end();
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
