import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { CoreSettings, RunStatus, StageId } from '../types.js';
import type { Listener } from '../runtime.js';
import { createServerCore, type ServerCore } from './guard.js';

export interface StartHostOptions {
  dataDir: string;
  promptsDir: string;
  projects: { id: string; path: string }[];
  settings: CoreSettings;
  agentEnv: NodeJS.ProcessEnv;
  onEvent?: Listener;
}

export interface HostSnapshot {
  projects: { id: string; name: string }[];
  runs: { id: string; projectId: string; title: string; status: RunStatus; next: StageId }[];
}

export interface Host {
  snapshot(): Promise<HostSnapshot>;
  close(): Promise<void>;
}

function lockAddress(realDataDir: string): string {
  return `\0purpleflow-data-${createHash('sha256').update(realDataDir).digest('hex')}`;
}

function listen(server: net.Server, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(address);
  });
}

function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function startHost(opts: StartHostOptions): Promise<Host> {
  if (process.platform !== 'linux') throw new Error('Серверный хост поддерживается только на Linux');

  fs.mkdirSync(opts.dataDir, { recursive: true });
  const realDataDir = fs.realpathSync(opts.dataDir);
  const server = net.createServer((socket) => socket.destroy());
  let core: ServerCore | undefined;

  try {
    await listen(server, lockAddress(realDataDir)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') throw new Error('Каталог данных уже обслуживается', { cause: error });
      throw error;
    });

    const ids = new Set<string>();
    const paths = new Set<string>();
    const projects = opts.projects.map((project) => {
      if (/^[A-Za-z0-9_-]+$/.exec(project.id)?.[0] !== project.id) throw new Error(`Некорректный id проекта: ${project.id}`);
      if (ids.has(project.id)) throw new Error(`Повторный id проекта: ${project.id}`);
      ids.add(project.id);
      const realPath = fs.realpathSync(project.path);
      if (paths.has(realPath)) throw new Error(`Проекты ссылаются на один каталог: ${project.id}`);
      paths.add(realPath);
      return { id: project.id, path: realPath, name: path.basename(realPath) };
    });
    const projectByPath = new Map(projects.map((project) => [project.path, project]));
    const allowProject = (projectPath: string): boolean => {
      try {
        return projectByPath.has(fs.realpathSync(projectPath));
      } catch {
        return false;
      }
    };

    core = createServerCore({
      dataDir: realDataDir,
      promptsDir: opts.promptsDir,
      env: opts.agentEnv,
      getSettings: () => opts.settings,
      allowProject,
    });
    if (opts.onEvent) core.on(opts.onEvent);
    await core.recover();
    const runningCore = core;

    let closing: Promise<void> | undefined;
    return {
      async snapshot() {
        const runs = await runningCore.listRuns();
        return {
          projects: projects.map(({ id, name }) => ({ id, name })),
          runs: runs.flatMap((run) => {
            let realPath: string;
            try {
              realPath = fs.realpathSync(run.projectPath);
            } catch {
              return [];
            }
            const project = projectByPath.get(realPath);
            return project ? [{ id: run.id, projectId: project.id, title: run.title, status: run.status, next: run.next }] : [];
          }),
        };
      },
      close() {
        closing ??= (async () => {
          try {
            await runningCore.shutdown();
          } finally {
            await closeServer(server);
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    if (core) await core.shutdown().catch(() => {});
    await closeServer(server);
    throw error;
  }
}
