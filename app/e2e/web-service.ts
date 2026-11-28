import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { ServerConfig } from '../../core/src/server/config.js';
import { hashSecret } from '../../core/src/server/secret.js';
import type { CoreSettings } from '../../core/src/types.js';
import type { Sandbox } from './harness';

const HERE = __dirname;
const APP_DIR = path.dirname(HERE);
const ROOT = path.dirname(APP_DIR);
const DEFAULT_SETTINGS: CoreSettings = {
  toolPaths: {},
  proxy: { baseUrl: '', apiKey: '' },
  models: { planner: 'opus', executor: 'sonnet', reviewer: '', visual: '', manager: '', scan: '' },
  efforts: {},
  agents: { planner: 'claude', executor: 'claude', reviewer: 'codex' },
  enabledAgents: ['claude', 'codex'],
  claudeAuth: 'login',
  userConfig: true,
  maxParallel: 2,
  agentTimeoutMin: 30,
  testTimeoutMin: 10,
};

export interface WebService {
  origin: string;
  secret: string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Не удалось выбрать порт веб-пробы');
  const { port } = address;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

export async function startWebService(box: Sandbox): Promise<WebService> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const secret = 'секрет веб-пробы';
  const secretFile = path.join(box.root, 'web-secret');
  fs.writeFileSync(secretFile, hashSecret(secret), { mode: 0o600 });
  const saved = JSON.parse(fs.readFileSync(path.join(box.profile, 'settings.json'), 'utf8')) as CoreSettings;
  const config: ServerConfig = {
    dataDir: path.join(box.profile, 'data'),
    promptsDir: path.join(ROOT, 'core', 'prompts'),
    projects: [{ id: 'demo', path: box.repo, testCommand: 'npm test' }],
    publicOrigin: origin,
    port,
    secretFile,
    webDir: path.join(APP_DIR, 'out', 'web'),
    settings: {
      ...DEFAULT_SETTINGS,
      ...saved,
      toolPaths: { ...DEFAULT_SETTINGS.toolPaths, ...saved.toolPaths },
      proxy: { ...DEFAULT_SETTINGS.proxy, ...saved.proxy },
      models: { ...DEFAULT_SETTINGS.models, ...saved.models },
      efforts: { ...DEFAULT_SETTINGS.efforts, ...saved.efforts },
      agents: { ...DEFAULT_SETTINGS.agents, ...saved.agents },
    },
  };

  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', __filename], {
    env: { ...process.env, PURPLEFLOW_WEB_CONFIG: JSON.stringify(config) },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Служба веб-пробы не запустилась за 60 секунд')), 60_000);
      const onMessage = (message: unknown) => {
        if (message === 'ready') settle();
        else if (typeof message === 'object' && message && 'error' in message) settle(new Error(String(message.error)));
      };
      const onExit = (code: number | null) => settle(new Error(`Служба веб-пробы завершилась со статусом ${code ?? 'null'}`));
      const settle = (error?: Error) => {
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('exit', onExit);
        if (error) reject(error);
        else resolve();
      };
      child.on('message', onMessage);
      child.once('exit', onExit);
    });
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
    throw error;
  }

  return {
    origin,
    secret,
    async stop() {
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
      await exited;
    },
  };
}

async function runChild(): Promise<void> {
  const raw = process.env.PURPLEFLOW_WEB_CONFIG;
  if (!raw) throw new Error('PURPLEFLOW_WEB_CONFIG не задан');
  const { startService } = await import('../../core/src/server/main.js');
  const service = await startService(JSON.parse(raw) as ServerConfig);
  await service.ready;
  process.send?.('ready');
  process.disconnect();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void service.stop().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  void runChild().catch((error: unknown) => {
    process.send?.({ error: error instanceof Error ? error.message : String(error) });
    console.error(error);
    process.exitCode = 1;
  });
}
