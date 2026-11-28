import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { claudeEnv } from './agents/claude.js';
import { buildAgentEnv, loadServerConfig } from './server/config.js';
import type { ServerConfig } from './server/config.js';
import { startHost } from './server/host.js';
import { createServerApp } from './server/main.js';
import { hashSecret } from './server/secret.js';
import { Browser, listen, makeServerStand, serverTestsSkip } from './server-testkit.test.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CHECKOUT = ROOT.replace(/[\\/]$/, '');
const linuxOnly = { skip: process.platform !== 'linux' };

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-server-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function installConfig(dir: string, dataDir = path.join(dir, 'service-data')) {
  return {
    dataDir,
    promptsDir: path.join(CHECKOUT, 'core', 'prompts'),
    projects: [{ id: 'project', path: path.join(dir, 'project'), testCommand: 'node --version' }],
    publicOrigin: 'https://purpleflow.example.com',
    port: 4173,
    secretFile: path.join(dir, 'secret'),
    settings: {
      toolPaths: {
        claude: path.join(dir, 'bin', 'claude'),
        openspec: path.join(CHECKOUT, 'node_modules', '.bin', 'openspec'),
      },
      agents: { planner: 'claude', executor: 'claude', reviewer: 'claude' },
      enabledAgents: ['claude'],
    },
  };
}

function writeConfig(dir: string, value: unknown): string {
  const file = path.join(dir, 'server.json');
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  return file;
}

function substituted(file: string, replacements: Record<string, string>): string {
  let text = fs.readFileSync(file, 'utf8');
  for (const [placeholder, value] of Object.entries(replacements)) text = text.replaceAll(placeholder, value);
  return text;
}

function validateUnit(text: string): void {
  const values = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z]+)=(.*)$/.exec(line);
    if (match) values.set(match[1]!, match[2]!);
  }
  const command = values.get('ExecStart')?.split(' ') ?? [];
  assert.equal(command.length, 4);
  const [node, main, configFlag, config] = command;
  assert.ok(node && path.isAbsolute(node), 'исполняемый файл node должен быть абсолютным');
  assert.equal(path.basename(node), 'node');
  assert.equal(main, path.join(CHECKOUT, 'core', 'dist', 'server', 'main.js'));
  assert.ok(path.isAbsolute(main));
  assert.ok(fs.existsSync(main), 'сначала соберите core/dist/server/main.js');
  assert.equal(configFlag, '--config');
  assert.ok(config && path.isAbsolute(config), 'путь конфига должен быть абсолютным');
  assert.equal(values.get('KillMode'), 'control-group');
  assert.equal(values.get('Restart'), 'on-failure');
  assert.equal(values.get('WantedBy'), 'default.target');
}

test('пример unit совпадает со сборкой', linuxOnly, () => {
  const file = path.join(CHECKOUT, 'docs', 'server', 'purpleflow.service');
  const replacements = {
    __NODE__: process.execPath,
    __CHECKOUT__: CHECKOUT,
    __CONFIG__: path.join(CHECKOUT, 'purpleflow.json'),
  };
  const valid = substituted(file, replacements);
  validateUnit(valid);

  const execStart = valid.split('\n').find((line) => line.startsWith('ExecStart='));
  assert.ok(execStart);
  const invalid = [
    execStart.replace(process.execPath, 'node'),
    execStart.replace(path.join(CHECKOUT, 'core', 'dist', 'server', 'main.js'), 'core/dist/server/main.js'),
    execStart.replace(path.join(CHECKOUT, 'purpleflow.json'), 'purpleflow.json'),
  ];
  for (const command of invalid) {
    assert.throws(() => validateUnit(valid.replace(execStart, command)));
  }
});

function readExampleConfig(dir: string): { file: string; value: ReturnType<typeof installConfig> } {
  const secretFile = path.join(dir, 'secret');
  fs.writeFileSync(secretFile, hashSecret('секрет владельца'), { mode: 0o600 });
  const text = substituted(path.join(CHECKOUT, 'docs', 'server', 'config.example.json'), {
    __CHECKOUT__: CHECKOUT,
    __DATA_DIR__: path.join(dir, 'service-data'),
    __PROJECT_DIR__: path.join(dir, 'project'),
    __SECRET_FILE__: secretFile,
    __CLAUDE__: path.join(dir, 'bin', 'claude'),
    __CODEX__: path.join(dir, 'bin', 'codex'),
  });
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, text, { mode: 0o600 });
  return { file, value: JSON.parse(text) as ReturnType<typeof installConfig> };
}

test('пример конфига разбирается loadServerConfig', linuxOnly, (t) => {
  const dir = tempDir(t);
  const { file, value } = readExampleConfig(dir);
  const config = loadServerConfig(file);
  assert.equal(config.dataDir, value.dataDir);
  assert.equal(config.promptsDir, value.promptsDir);
  assert.deepEqual(config.projects, value.projects);
  assert.equal(config.publicOrigin, value.publicOrigin);
  assert.equal(config.port, value.port);
  assert.equal(config.secretFile, value.secretFile);
  assert.deepEqual(config.settings.toolPaths, value.settings.toolPaths);
  assert.equal(config.settings.claudeAuth, 'login');
  assert.equal(config.telegram, undefined);
});

test('пример конфига: пути toolPaths абсолютные', linuxOnly, (t) => {
  const { value } = readExampleConfig(tempDir(t));
  for (const toolPath of Object.values(value.settings.toolPaths)) assert.ok(path.isAbsolute(toolPath), toolPath);
});

test('каталог данных настольного приложения отклоняется', linuxOnly, (t) => {
  const dir = tempDir(t);
  const xdg = path.join(dir, 'config');
  const previous = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    HOME: process.env.HOME,
    PURPLEFLOW_USER_DATA: process.env.PURPLEFLOW_USER_DATA,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.XDG_CONFIG_HOME = xdg;
  delete process.env.PURPLEFLOW_USER_DATA;

  const rejects = (dataDir: string) => {
    const file = writeConfig(dir, installConfig(dir, dataDir));
    assert.throws(() => loadServerConfig(file), /dataDir.*настольного приложения/);
  };

  rejects(path.join(xdg, 'PurpleFlow', 'data'));
  rejects(path.join(xdg, 'PS Flow', 'data'));

  const dangling = path.join(dir, 'pf-data');
  fs.symlinkSync(path.join(xdg, 'PurpleFlow', 'data'), dangling, 'dir');
  rejects(dangling);

  fs.mkdirSync(path.join(dir, 'x'));
  fs.symlinkSync(path.join(xdg, 'PurpleFlow', 'sub'), path.join(dir, 'x', 'link'), 'dir');
  rejects(`${dir}/x/link/../data`);

  fs.symlinkSync(path.join(xdg, 'PurpleFlow'), path.join(dir, 'pf-link'), 'dir');
  rejects(`${dir}/pf-missing/../pf-link/data`);

  fs.symlinkSync(path.join(dir, 'loop-b'), path.join(dir, 'loop-a'), 'dir');
  fs.symlinkSync(path.join(dir, 'loop-a'), path.join(dir, 'loop-b'), 'dir');
  const loop = writeConfig(dir, installConfig(dir, path.join(dir, 'loop-a')));
  assert.throws(() => loadServerConfig(loop), /слишком много символических ссылок/);

  fs.mkdirSync(xdg, { recursive: true });
  fs.writeFileSync(path.join(xdg, 'PurpleFlow'), 'не каталог');
  assert.doesNotThrow(() => loadServerConfig(writeConfig(dir, installConfig(dir))));

  process.env.PURPLEFLOW_USER_DATA = path.join(dir, 'desktop-profile');
  rejects(path.join(process.env.PURPLEFLOW_USER_DATA, 'data'));

  delete process.env.XDG_CONFIG_HOME;
  delete process.env.PURPLEFLOW_USER_DATA;
  process.env.HOME = dir;
  rejects(path.join(dir, '.config', 'PurpleFlow', 'data'));
  rejects(path.join(dir, '.config', 'PS Flow', 'data'));
  assert.doesNotThrow(() => loadServerConfig(writeConfig(dir, installConfig(dir, path.join(dir, 'separate-data')))));
});

test(
  'вход через провайдера: переменная из ~/.bash_profile доходит до claude',
  { skip: process.platform !== 'linux' || !fs.existsSync('/bin/bash') },
  (t) => {
    const home = tempDir(t);
    fs.writeFileSync(path.join(home, '.bash_profile'), 'export ANTHROPIC_BASE_URL=https://provider.example/\n', { mode: 0o600 });

    const env = buildAgentEnv({ HOME: home, USER: 'service', LOGNAME: 'service', SHELL: '/bin/bash' });
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://provider.example/');
    assert.equal(claudeEnv({ env, claudeAuth: 'env' }).ANTHROPIC_BASE_URL, 'https://provider.example/');
    assert.equal(claudeEnv({ env, claudeAuth: 'login' }).ANTHROPIC_BASE_URL, undefined);
  },
);

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const { port } = address;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function startBuiltService(t: TestContext, configFile: string, port: number): Promise<string> {
  const proc: ChildProcess = spawn(process.execPath, [path.join(CHECKOUT, 'core', 'dist', 'server', 'main.js'), '--config', configFile], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.ok(proc.pid);
  let stderr = '';
  proc.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = once(proc, 'exit');
  let stopping: Promise<void> | undefined;
  t.after(() => {
    stopping ??= (async () => {
      if (proc.exitCode === null && proc.signalCode === null) process.kill(-proc.pid!, 'SIGTERM');
      const killTimer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) process.kill(-proc.pid!, 'SIGKILL');
      }, 10_000);
      try {
        await exited;
      } finally {
        clearTimeout(killTimer);
      }
    })();
    return stopping;
  });

  const origin = `http://127.0.0.1:${port}`;
  const earlyExit = exited.then(([code, signal]) => {
    throw new Error(`Служба завершилась до готовности: код ${code ?? '—'}, сигнал ${signal ?? '—'}\n${stderr}`);
  });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Служба не открыла /login за 20 с\n${stderr}`)), 20_000);
  });
  let polling = true;
  const readiness = (async () => {
    while (polling) {
      try {
        const response = await fetch(`${origin}/login`, { signal: AbortSignal.timeout(1000) });
        if (response.status === 200) return;
      } catch {
        // Служба ещё не слушает порт или восстанавливает прогоны.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  try {
    await Promise.race([readiness, earlyExit, deadline]);
  } finally {
    polling = false;
    if (timer) clearTimeout(timer);
  }
  return origin;
}

async function startRun(browser: Browser, origin: string): Promise<string> {
  const project = await browser.request(origin, '/legacy/projects/p1');
  assert.equal(project.status, 200);
  const submissionId = /name="submissionId" value="([0-9a-f-]+)"/.exec(await project.text())?.[1];
  assert.ok(submissionId);
  const started = await browser.request(origin, '/legacy/projects/p1/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ submissionId, task: 'Добавь mul' }),
  });
  assert.equal(started.status, 303);
  const route = started.headers.get('location');
  assert.ok(route && route.startsWith('/legacy/runs/'));
  return route;
}

async function waitForPlan(browser: Browser, origin: string, route: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const response = await browser.request(origin, route);
    assert.equal(response.status, 200);
    const text = await response.text();
    if (text.includes('data-status="waiting"') && text.includes('<dt>Стадия</dt><dd>gate1</dd>')) return;
    if (text.includes('data-status="stopped"')) throw new Error(`Прогон остановился до gate1: ${text}`);
    if (Date.now() > deadline) throw new Error(`Прогон не дошёл до gate1: ${text}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('собранная служба: глубокая ссылка через вход и выход', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const stand = makeServerStand();
  t.after(() => fs.rmSync(path.dirname(stand.dataDir), { recursive: true, force: true }));
  const port = await freePort();
  const config = JSON.parse(fs.readFileSync(stand.configFile, 'utf8')) as ServerConfig;
  config.port = port;
  fs.writeFileSync(stand.configFile, JSON.stringify(config), { mode: 0o600 });
  const origin = await startBuiltService(t, stand.configFile, port);

  const owner = new Browser();
  assert.equal((await owner.login(origin)).status, 303);
  const runRoute = await startRun(owner, origin);
  await waitForPlan(owner, origin, runRoute);
  assert.ok(fs.readFileSync(stand.fakeLog, 'utf8').trim());

  const anonymous = new Browser();
  const protectedPage = await anonymous.request(origin, runRoute);
  assert.equal(protectedPage.status, 303);
  const loginLocation = new URL(protectedPage.headers.get('location') ?? '', origin);
  assert.equal(loginLocation.pathname, '/login');
  const returnTo = loginLocation.searchParams.get('returnTo');
  assert.equal(returnTo, runRoute);
  const entered = await anonymous.login(origin, returnTo!);
  assert.equal(entered.status, 303);
  assert.equal(entered.headers.get('location'), runRoute);
  assert.equal((await anonymous.request(origin, runRoute)).status, 200);

  const loggedOut = await anonymous.request(origin, '/logout', { method: 'POST' });
  assert.equal(loggedOut.status, 303);
  assert.equal(loggedOut.headers.get('location'), '/');
  const afterLogout = await anonymous.request(origin, runRoute);
  assert.equal(afterLogout.status, 303);
  const afterLogoutLocation = new URL(afterLogout.headers.get('location') ?? '', origin);
  assert.equal(afterLogoutLocation.searchParams.get('returnTo'), runRoute);
  const reentered = await anonymous.login(origin, runRoute);
  assert.equal(reentered.status, 303);
  assert.equal(reentered.headers.get('location'), runRoute);
  assert.equal((await anonymous.request(origin, runRoute)).status, 200);
});

test('истёкший вход возвращает к тому же прогону', { skip: serverTestsSkip, timeout: 60_000 }, async (t) => {
  const stand = makeServerStand();
  t.after(() => fs.rmSync(path.dirname(stand.dataDir), { recursive: true, force: true }));
  const config = loadServerConfig(stand.configFile);
  let currentTime = Date.now();
  const host = await startHost({
    dataDir: config.dataDir,
    promptsDir: config.promptsDir,
    projects: config.projects,
    settings: config.settings,
    agentEnv: { HOME: process.env.HOME, PATH: process.env.PATH },
  });
  t.after(() => host.close());
  const origin = await listen(t, createServerApp(config, host, { now: () => currentTime }));

  const browser = new Browser();
  const login = await browser.login(origin);
  assert.equal(login.status, 303);
  const sessionCookie = /pf_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')?.[0];
  assert.ok(sessionCookie);
  const runRoute = await startRun(browser, origin);
  await waitForPlan(browser, origin, runRoute);

  const beforeExpiry = await fetch(`${origin}${runRoute}`, { redirect: 'manual', headers: { Cookie: sessionCookie } });
  assert.equal(beforeExpiry.status, 200);
  currentTime += 12 * 60 * 60 * 1000 + 1000;
  const expired = await fetch(`${origin}${runRoute}`, { redirect: 'manual', headers: { Cookie: sessionCookie } });
  assert.equal(expired.status, 303);
  const loginLocation = new URL(expired.headers.get('location') ?? '', origin);
  assert.equal(loginLocation.pathname, '/login');
  assert.equal(loginLocation.searchParams.get('returnTo'), runRoute);

  const fresh = new Browser();
  const entered = await fresh.login(origin, runRoute);
  assert.equal(entered.status, 303);
  assert.equal(entered.headers.get('location'), runRoute);
  assert.equal((await fresh.request(origin, runRoute)).status, 200);
});
