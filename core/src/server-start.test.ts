import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { AgentRunOptions } from './agents/common.js';
import { SERVER_DEFAULTS, type ServerConfig, type ServerProject } from './server/config.js';
import { createServerApp } from './server/main.js';
import type { Host } from './server/host.js';
import { fakeClaude, ROOT, serverTestsSkip, startTestHost, untilGate } from './server-testkit.test.js';

const PUBLIC_ORIGIN = 'https://purpleflow.example';
const SECRET = 'секрет владельца';

function deferred(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

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
    settings: structuredClone(SERVER_DEFAULTS),
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

  login(origin: string, returnTo = '/'): Promise<Response> {
    return this.request(origin, '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: SECRET, returnTo }),
    });
  }
}

function submissionIdOf(html: string): string {
  const id = /name="submissionId" value="([0-9a-f-]+)"/.exec(html)?.[1];
  assert.ok(id);
  return id;
}

function postTask(browser: Browser, origin: string, submissionId: string, task = 'Добавь mul', signal?: AbortSignal) {
  return browser.request(origin, '/projects/p1/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ submissionId, task }),
    signal,
  });
}

test('старт: задача из браузера продолжается после закрытия клиента', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const plannerStarted = deferred();
  const plannerGate = deferred();
  const redirectStarted = deferred();
  const redirectGate = deferred();
  const fake = fakeClaude({ implement: () => {}, review: () => ({ blocking: [], notes: [] }) });
  const fixture = await startTestHost({
    runners: {
      claude: (async (o: AgentRunOptions) => {
        if (/планировщик/.test(o.systemPrompt ?? '')) {
          plannerStarted.open();
          await plannerGate.promise;
        }
        return fake.fn(o);
      }) as never,
    },
  });
  t.after(() => fixture.close());
  const config = configFor(fixture.dataDir, fixture.project);
  const origin = await listen(
    t,
    createServerApp(config, fixture.host, {
      testHooks: {
        beforeStartRedirect: async () => {
          redirectStarted.open();
          await redirectGate.promise;
        },
      },
    }),
  );
  const clientA = new Browser();
  const clientB = new Browser();

  try {
    const anonymous = await clientA.request(origin, '/projects/p1');
    assert.equal(anonymous.status, 303);
    const loginLocation = new URL(anonymous.headers.get('location') ?? '', origin);
    assert.equal(loginLocation.searchParams.get('returnTo'), '/projects/p1');
    const entered = await clientA.login(origin, '/projects/p1');
    assert.equal(entered.status, 303);
    assert.equal(entered.headers.get('location'), '/projects/p1');

    const overview = await (await clientA.request(origin, '/')).text();
    assert.match(overview, /href="\/projects\/p1"/);
    const form = await clientA.request(origin, '/projects/p1');
    assert.equal(form.status, 200);
    const submissionId = submissionIdOf(await form.text());
    const controller = new AbortController();
    const posting = postTask(clientA, origin, submissionId, undefined, controller.signal);
    const early = await Promise.race([
      posting.then((response) => ({ kind: 'response' as const, response })),
      redirectStarted.promise.then(() => ({ kind: 'redirect' as const })),
    ]);
    if (early.kind === 'response') {
      assert.equal(early.response.status, 303);
    } else {
      controller.abort();
      await assert.rejects(posting);
    }
    await plannerStarted.promise;
    const runs = await fixture.core.listRuns();
    assert.equal(runs.length, 1);
    const runId = runs[0]!.id;
    plannerGate.open();
    redirectGate.open();
    await untilGate(fixture.core, runId, 'gate1');

    await clientB.login(origin);
    const page = await clientB.request(origin, `/runs/${runId}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, new RegExp(runId));
    assert.match(html, /gate1/);
  } finally {
    plannerGate.open();
    redirectGate.open();
  }
});
