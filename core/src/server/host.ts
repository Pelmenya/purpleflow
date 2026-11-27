import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { ShuttingDownError } from '../kernel.js';
import { gateMessage } from '../gates.js';
import type { Orchestrator } from '../orchestrator.js';
import type { CoreOptions, Listener } from '../runtime.js';
import { isGate } from '../stage-info.js';
import { writeAtomic } from '../store.js';
import type { ChangeDocs, CoreSettings, DiffFile, GateId, RunFile, RunStatus, StageId } from '../types.js';
import type { ServerProject } from './config.js';
import type { ExpectedDecision } from './decisions.js';
import { createServerCore, type ServerCore } from './guard.js';

export interface StartHostOptions {
  dataDir: string;
  promptsDir: string;
  projects: ServerProject[];
  settings: CoreSettings;
  agentEnv: NodeJS.ProcessEnv;
  onEvent?: Listener;
  runners?: CoreOptions['runners'];
  onCore?: (core: Orchestrator) => void;
}

export type StartTaskResult =
  | { status: 'started'; runId: string }
  | { status: 'conflict' }
  | { status: 'unknown' }
  | { status: 'notFound' }
  | { status: 'rejected'; message: string };

export interface HostSnapshot {
  projects: { id: string; name: string }[];
  runs: {
    id: string;
    projectId: string;
    title: string;
    status: RunStatus;
    next: StageId;
    waitId?: string;
    gate?: GateId;
    reason?: string;
    limit?: { cause: 'loop' | 'attempts'; attempts: number; max: number };
  }[];
}

export type DecideResult =
  { status: 'ok' | 'conflict'; snapshot: RunFile } | { status: 'notFound' } | { status: 'invalid'; message: string };

export interface Host {
  snapshot(): Promise<HostSnapshot>;
  startTask(projectId: string, input: { task: string; submissionId: string }): Promise<StartTaskResult>;
  readRun(id: string): Promise<RunFile | null>;
  readChangeDocs(id: string): Promise<{ run: RunFile; docs: ChangeDocs | null } | null>;
  readDiff(id: string): Promise<{ run: RunFile; diff: DiffFile[] | null } | null>;
  decide(runId: string, command: ExpectedDecision): Promise<DecideResult>;
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

interface Submission {
  submissionId: string;
  hash: string;
  projectId: string;
  createdAt: string;
  runId?: string;
  error?: string;
}

const submissionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      return { ...project, path: realPath, name: path.basename(realPath) };
    });
    const projectById = new Map(projects.map((project) => [project.id, project]));
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
      runners: opts.runners,
    });
    if (opts.onEvent) core.on(opts.onEvent);
    opts.onCore?.(core);
    await core.recover();
    const runningCore = core;
    const submissionsDir = path.join(realDataDir, 'server', 'submissions');
    const submissionFile = (submissionId: string) => path.join(submissionsDir, `${submissionId}.json`);
    const saveSubmission = (submission: Submission): void => {
      writeAtomic(submissionFile(submission.submissionId), JSON.stringify(submission, null, 2) + '\n');
    };
    const readRun = async (id: string): Promise<RunFile | null> => {
      const run = await runningCore.getRun(id);
      return run && allowProject(run.projectPath) ? run : null;
    };
    const readSubmission = async (submissionId: string): Promise<Submission | undefined> => {
      try {
        return JSON.parse(await fs.promises.readFile(submissionFile(submissionId), 'utf8')) as Submission;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    };
    const performStartTask = async (projectId: string, task: string, submissionId: string, hash: string): Promise<StartTaskResult> => {
      const existing = await readSubmission(submissionId);
      if (existing) {
        if (existing.hash !== hash) return { status: 'conflict' };
        if (existing.runId !== undefined) {
          const run = await readRun(existing.runId);
          return run ? { status: 'started', runId: existing.runId } : { status: 'unknown' };
        }
        if (existing.error !== undefined) return { status: 'rejected', message: existing.error };
        return { status: 'unknown' };
      }

      const project = projectById.get(projectId);
      if (!project) return { status: 'notFound' };
      const savedConfig = await runningCore.getProjectConfig(project.path);
      const testCommand = (project.testCommand ?? savedConfig?.testCommand ?? '').trim();
      const submission: Submission = {
        submissionId,
        hash,
        projectId,
        createdAt: new Date().toISOString(),
      };
      if (!testCommand) {
        const message = 'Для проекта не задана команда тестов';
        saveSubmission({ ...submission, error: message });
        return { status: 'rejected', message };
      }
      if (savedConfig?.multiRepo) {
        const message = 'Серверный запуск не поддерживает проект из нескольких репозиториев';
        saveSubmission({ ...submission, error: message });
        return { status: 'rejected', message };
      }

      saveSubmission(submission);
      try {
        const { runId } = await runningCore.dispatch({
          type: 'run.start',
          input: {
            projectPath: project.path,
            task,
            testCommand,
            setupCommand: project.setupCommand ?? savedConfig?.setupCommand,
            lintCommand: project.lintCommand ?? savedConfig?.lintCommand,
            mode: 'task',
            workspace: 'worktree',
          },
        });
        saveSubmission({ ...submission, runId });
        return { status: 'started', runId };
      } catch (error) {
        if (error instanceof ShuttingDownError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        saveSubmission({ ...submission, error: message });
        return { status: 'rejected', message };
      }
    };

    const inFlight = new Map<string, { hash: string; promise: Promise<StartTaskResult> }>();
    let hostClosing = false;
    let activeStartTasks = 0;
    let notifyStartTasksIdle: (() => void) | undefined;
    let closing: Promise<void> | undefined;
    return {
      async snapshot() {
        const runs = await runningCore.listRuns();
        const summaries = await Promise.all(
          runs.map(async (run): Promise<HostSnapshot['runs']> => {
            let realPath: string;
            try {
              realPath = fs.realpathSync(run.projectPath);
            } catch {
              return [];
            }
            const project = projectByPath.get(realPath);
            if (!project) return [];
            const summary = { id: run.id, projectId: project.id, title: run.title, status: run.status, next: run.next };
            if (run.status !== 'waiting' || !isGate(run.next)) return [summary];
            const full = await runningCore.getRun(run.id);
            if (!full) return [summary];
            const gate = run.next as GateId;
            return [
              {
                ...summary,
                waitId: full.waitId,
                gate,
                reason: gateMessage(full) ?? full.message,
                ...(gate === 'limit'
                  ? {
                      limit: {
                        cause: full.stuck ? ('loop' as const) : ('attempts' as const),
                        attempts: full.implAttemptsUsed,
                        max: full.implAttemptsLimit,
                      },
                    }
                  : {}),
              },
            ];
          }),
        );
        return {
          projects: projects.map(({ id, name }) => ({ id, name })),
          runs: summaries.flat(),
        };
      },
      startTask(projectId, input) {
        if (hostClosing) throw new ShuttingDownError();
        const task = input.task.trim();
        const submissionId = input.submissionId;
        if (!task) return Promise.resolve({ status: 'rejected', message: 'Опишите задачу' });
        if (!submissionIdPattern.test(submissionId)) {
          return Promise.resolve({ status: 'rejected', message: 'Некорректный идентификатор отправки' });
        }
        const hash = createHash('sha256').update(JSON.stringify({ projectId, task })).digest('hex');
        const existing = inFlight.get(submissionId);
        if (existing) return existing.hash === hash ? existing.promise : Promise.resolve({ status: 'conflict' });
        activeStartTasks++;
        const promise = performStartTask(projectId, task, submissionId, hash).finally(() => {
          activeStartTasks--;
          if (inFlight.get(submissionId)?.promise === promise) inFlight.delete(submissionId);
          if (activeStartTasks === 0) {
            notifyStartTasksIdle?.();
            notifyStartTasksIdle = undefined;
          }
        });
        inFlight.set(submissionId, { hash, promise });
        return promise;
      },
      readRun,
      async readChangeDocs(id) {
        const first = await readRun(id);
        if (!first) return null;
        let previous = first;
        for (let attempt = 0; attempt < 3; attempt++) {
          const docs = await runningCore.getChangeDocs(id);
          const current = await readRun(id);
          if (!current) return null;
          if (current.status === previous.status && current.next === previous.next && current.waitId === previous.waitId) {
            return { run: current, docs };
          }
          previous = current;
        }
        return { run: previous, docs: null };
      },
      async readDiff(id) {
        const first = await readRun(id);
        if (!first) return null;
        let previous = first;
        for (let attempt = 0; attempt < 3; attempt++) {
          let diff: DiffFile[];
          try {
            diff = await runningCore.getDiff(id);
          } catch (error) {
            if (!(await readRun(id))) return null;
            throw error;
          }
          const current = await readRun(id);
          if (!current) return null;
          if (
            current.status === previous.status &&
            current.next === previous.next &&
            current.waitId === previous.waitId &&
            current.waitDecided === previous.waitDecided
          ) {
            return { run: current, diff };
          }
          previous = current;
        }
        return { run: previous, diff: null };
      },
      async decide(runId, command) {
        let snapshot = await readRun(runId);
        if (!snapshot) return { status: 'notFound' };
        if (
          !isGate(snapshot.next) ||
          (snapshot.status !== 'waiting' && snapshot.status !== 'stopped') ||
          snapshot.waitId !== command.expectedWaitId ||
          snapshot.waitDecided
        ) {
          return { status: 'conflict', snapshot };
        }

        const actionAllowed =
          snapshot.next === 'gate0'
            ? command.action === 'answer' || command.action === 'skip'
            : snapshot.next === 'gate1'
              ? command.action === 'approve' || command.action === 'reject' || command.action === 'cancel'
              : snapshot.next === 'gate2'
                ? snapshot.mode === 'review'
                  ? command.action === 'approve' || command.action === 'cancel'
                  : command.action === 'approve' || command.action === 'reject'
                : snapshot.next === 'limit'
                  ? command.action === 'approve' || command.action === 'cancel'
                  : false;
        if (!actionAllowed) return { status: 'invalid', message: 'Действие недопустимо для текущего ожидания' };
        if (command.action === 'answer' && (!command.answers.length || command.answers.some(({ q, a }) => !q.trim() || !a.trim()))) {
          return { status: 'invalid', message: 'Ответьте на каждый вопрос' };
        }
        if (command.action === 'reject' && !command.comment.trim()) {
          return { status: 'invalid', message: 'Добавьте комментарий к возврату' };
        }

        const result = await runningCore.decideExpected(runId, command.expectedWaitId, command);
        snapshot = await readRun(runId);
        if (!snapshot) return { status: 'notFound' };
        return { status: result.ok ? 'ok' : 'conflict', snapshot };
      },
      close() {
        if (closing) return closing;
        hostClosing = true;
        const stopping = runningCore.shutdown();
        closing = (async () => {
          try {
            if (activeStartTasks > 0) {
              await new Promise<void>((resolve) => (notifyStartTasksIdle = resolve));
            }
            await stopping;
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
