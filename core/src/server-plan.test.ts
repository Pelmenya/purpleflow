import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { ServerConfig, ServerProject } from './server/config.js';
import { createServerApp } from './server/main.js';
import { fakeClaude, ROOT, serverTestsSkip, startTestHost, untilGate } from './server-testkit.test.js';

const PUBLIC_ORIGIN = 'https://purpleflow.example';
const SECRET = 'секрет владельца';

function configFor(dataDir: string, project: ServerProject): ServerConfig {
  const secretFile = path.join(dataDir, 'secret');
  fs.writeFileSync(secretFile, SECRET, { mode: 0o600 });
  return {
    dataDir,
    promptsDir: path.join(ROOT, 'core', 'prompts'),
    projects: [project],
    publicOrigin: PUBLIC_ORIGIN,
    port: 0,
    secretFile,
    settings: {
      toolPaths: {},
      enabledAgents: ['claude'],
      proxy: { baseUrl: '', apiKey: '' },
      models: { planner: '', executor: '', reviewer: '' },
      agents: { planner: 'claude', executor: 'claude', reviewer: 'claude' },
      agentTimeoutMin: 1,
      testTimeoutMin: 1,
      maxParallel: 1,
    },
  };
}

async function listen(t: TestContext, handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

class Browser {
  private cookie = '';

  async request(origin: string, route: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set('Cookie', this.cookie);
    if ((init.method ?? 'GET').toUpperCase() === 'POST') headers.set('Origin', PUBLIC_ORIGIN);
    const response = await fetch(`${origin}${route}`, { redirect: 'manual', ...init, headers });
    const cookie = response.headers.get('set-cookie');
    if (cookie) this.cookie = cookie.split(';', 1)[0] ?? '';
    return response;
  }

  login(origin: string): Promise<Response> {
    return this.request(origin, '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: SECRET, returnTo: '/' }),
    });
  }
}

function postDecision(browser: Browser, origin: string, runId: string, fields: Record<string, string>): Promise<Response> {
  return browser.request(origin, `/runs/${runId}/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
}

function expectedWaitIdOf(html: string): string {
  const waitId = /name="expectedWaitId" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(waitId);
  return waitId;
}

test('план: уточнение, возврат и утверждение из браузера', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const fake = fakeClaude({
    questions: [{ q: 'Какие числа поддерживать?', options: ['Целые', 'Дробные'], why: 'От этого зависит реализация' }],
    implement: () => {},
    review: () => ({ blocking: [], notes: [] }),
  });
  const fixture = await startTestHost({ runners: { claude: fake.fn as never } });
  t.after(() => fixture.close());
  const origin = await listen(t, createServerApp(configFor(fixture.dataDir, fixture.project), fixture.host));
  const clientA = new Browser();
  const clientB = new Browser();
  assert.equal((await clientA.login(origin)).status, 303);
  assert.equal((await clientB.login(origin)).status, 303);

  const project = await clientA.request(origin, '/projects/p1');
  const submissionId = /name="submissionId" value="([0-9a-f-]+)"/.exec(await project.text())?.[1];
  assert.ok(submissionId);
  const started = await clientA.request(origin, '/projects/p1/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ submissionId, task: 'Добавь mul' }),
  });
  assert.equal(started.status, 303);
  const runId = started.headers.get('location')?.split('/').at(-1);
  assert.ok(runId);
  const gate0 = await untilGate(fixture.core, runId, 'gate0');
  const clarifyPage = await (await clientA.request(origin, `/runs/${runId}`)).text();
  assert.match(clarifyPage, /Какие числа поддерживать\?/);
  assert.match(clarifyPage, /Целые/);
  assert.match(clarifyPage, /От этого зависит реализация/);
  assert.equal(expectedWaitIdOf(clarifyPage), gate0.waitId);
  assert.match(clarifyPage, />Ответить</);
  assert.match(clarifyPage, />Продолжить без ответов</);

  const answered = await postDecision(clientA, origin, runId, {
    expectedWaitId: gate0.waitId!,
    action: 'answer',
    'answers[0][q]': 'Какие числа поддерживать?',
    'answers[0][a]': 'Целые и дробные',
  });
  assert.equal(answered.status, 303);
  const gate1 = await untilGate(fixture.core, runId, 'gate1');
  assert.ok(fake.plans().some((prompt) => prompt.includes('Какие числа поддерживать? — Целые и дробные')));

  const planPage = await (await clientA.request(origin, `/runs/${runId}`)).text();
  assert.match(planPage, /# Умножение/);
  assert.match(planPage, /1\.1 mul в src\/math\.js/);
  assert.equal(expectedWaitIdOf(planPage), gate1.waitId);
  const rejected = await postDecision(clientA, origin, runId, {
    expectedWaitId: gate1.waitId!,
    action: 'reject',
    comment: 'Добавь отрицательные числа',
  });
  assert.equal(rejected.status, 303);
  const returned = await untilGate(fixture.core, runId, 'gate1');
  assert.notEqual(returned.waitId, gate1.waitId);

  const otherClientPage = await (await clientB.request(origin, `/runs/${runId}`)).text();
  assert.match(otherClientPage, /Добавь отрицательные числа/);
  assert.equal(expectedWaitIdOf(otherClientPage), returned.waitId);
  const drive = t.mock.method(fixture.core.kernel.engine, 'drive');
  const approved = await postDecision(clientB, origin, runId, {
    expectedWaitId: returned.waitId!,
    action: 'approve',
  });
  assert.equal(approved.status, 303);
  assert.ok(drive.mock.calls.some((call) => call.arguments[0].next === 'implement'));
});
