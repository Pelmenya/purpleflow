import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { ShuttingDownError } from '../kernel.js';
import { gateMessage } from '../gates.js';
import type { Orchestrator } from '../orchestrator.js';
import { killPid } from '../proc.js';
import type { CoreOptions, Listener } from '../runtime.js';
import { isGate } from '../stage-info.js';
import { RunStore, writeAtomic } from '../store.js';
import type { ChangeDocs, ChatFile, ChatSummary, CoreSettings, DiffFile, GateId, RunFile, RunStatus, StageId } from '../types.js';
import { attentionIntent, type AttentionIntent } from './attention.js';
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
export type StopResult = { status: 'ok' } | { status: 'notFound' } | { status: 'conflict'; snapshot: RunFile };
export type SendChatResult =
  { status: 'accepted' } | { status: 'conflict' } | { status: 'unknown' } | { status: 'notFound' } | { status: 'invalid'; message: string };

export interface Host {
  snapshot(): Promise<HostSnapshot>;
  startTask(projectId: string, input: { task: string; submissionId: string }): Promise<StartTaskResult>;
  listChats(projectId: string): Promise<ChatSummary[] | null>;
  createChat(projectId: string): Promise<ChatFile | null>;
  readChat(chatId: string): Promise<{ chat: ChatFile; busy: boolean } | null>;
  sendChat(chatId: string, text: string, submissionId: string): Promise<SendChatResult>;
  readRun(id: string): Promise<RunFile | null>;
  intents(): AttentionIntent[];
  onIntentChange(fn: (runId: string, intent: AttentionIntent | null) => void): () => void;
  readLog(id: string): Promise<string | null>;
  readChangeDocs(id: string): Promise<{ run: RunFile; docs: ChangeDocs | null } | null>;
  readDiff(id: string): Promise<{ run: RunFile; diff: DiffFile[] | null } | null>;
  decide(runId: string, command: ExpectedDecision): Promise<DecideResult>;
  stop(id: string): Promise<StopResult>;
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

interface ChatSubmission {
  submissionId: string;
  hash: string;
  chatId: string;
  createdAt: string;
  accepted?: boolean;
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

    const store = new RunStore(realDataDir);
    let chatFiles: string[] = [];
    try {
      chatFiles = fs.readdirSync(path.join(realDataDir, 'chats')).filter((file) => file.endsWith('.json'));
    } catch {
      chatFiles = [];
    }
    for (const file of chatFiles) {
      const id = file.slice(0, -5);
      for (const group of [`chat:${id}`, `chat:${id}:task`]) {
        const pids = store.readPids(group);
        const recordedAt = store.pidsTime(group);
        for (const pid of pids) await killPid(pid, recordedAt);
        store.writePids(group, []);
      }
    }

    core = createServerCore({
      dataDir: realDataDir,
      promptsDir: opts.promptsDir,
      env: opts.agentEnv,
      getSettings: () => opts.settings,
      allowProject,
      keepFailedStart: true,
      runners: opts.runners,
    });
    const runningCore = core;
    const readAllowedRun = (id: string): RunFile | null => {
      const run = runningCore.kernel.store.load(id);
      return run && allowProject(run.projectPath) ? run : null;
    };
    const readRun = async (id: string): Promise<RunFile | null> => readAllowedRun(id);
    const intentListeners = new Set<{
      fn: (runId: string, intent: AttentionIntent | null) => void;
      keys: Map<string, string | null>;
    }>();
    core.on((event) => {
      if (event.type !== 'run.updated' || !allowProject(event.run.projectPath)) return;
      const intent = attentionIntent(event.run);
      const key = intent?.key ?? null;
      for (const listener of intentListeners) {
        const seen = listener.keys.has(event.run.id);
        if (seen && listener.keys.get(event.run.id) === key) continue;
        listener.keys.set(event.run.id, key);
        if (seen || intent) listener.fn(event.run.id, intent);
      }
    });
    if (opts.onEvent) core.on(opts.onEvent);
    opts.onCore?.(core);
    await core.recover();
    const submissionsDir = path.join(realDataDir, 'server', 'submissions');
    const submissionFile = (submissionId: string) => path.join(submissionsDir, `${submissionId}.json`);
    const saveSubmission = (submission: Submission): void => {
      writeAtomic(submissionFile(submission.submissionId), JSON.stringify(submission, null, 2) + '\n');
    };
    const readChat = async (id: string): Promise<{ chat: ChatFile; busy: boolean } | null> => {
      const result = await runningCore.getChat(id);
      if (!result || result.chat.edits || !result.chat.projectPath || !allowProject(result.chat.projectPath)) return null;
      return result;
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

    const chatSubmissionsDir = path.join(realDataDir, 'server', 'chat-submissions');
    const chatSubmissionFile = (submissionId: string): string => path.join(chatSubmissionsDir, `${submissionId}.json`);
    const saveChatSubmission = (submission: ChatSubmission): void => {
      writeAtomic(chatSubmissionFile(submission.submissionId), JSON.stringify(submission, null, 2) + '\n');
    };
    const readChatSubmission = async (submissionId: string): Promise<ChatSubmission | undefined> => {
      try {
        return JSON.parse(await fs.promises.readFile(chatSubmissionFile(submissionId), 'utf8')) as ChatSubmission;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    };
    const performChatSend = async (chatId: string, text: string, submissionId: string, hash: string): Promise<SendChatResult> => {
      if (!(await readChat(chatId))) return { status: 'notFound' };
      const existing = await readChatSubmission(submissionId);
      if (existing) {
        if (existing.hash !== hash) return { status: 'conflict' };
        if (existing.accepted) return { status: 'accepted' };
        if (existing.error !== undefined) return { status: 'invalid', message: existing.error };
        return { status: 'unknown' };
      }

      const submission: ChatSubmission = { submissionId, hash, chatId, createdAt: new Date().toISOString() };
      saveChatSubmission(submission);
      try {
        await runningCore.sendChat(chatId, text);
        saveChatSubmission({ ...submission, accepted: true });
        return { status: 'accepted' };
      } catch (error) {
        if (error instanceof ShuttingDownError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        saveChatSubmission({ ...submission, error: message });
        return { status: 'invalid', message };
      }
    };

    const inFlight = new Map<string, { hash: string; promise: Promise<StartTaskResult> }>();
    const chatInFlight = new Map<string, { hash: string; promise: Promise<SendChatResult> }>();
    let hostClosing = false;
    let activeOperations = 0;
    let notifyOperationsIdle: (() => void) | undefined;
    const operationStarted = (): void => {
      activeOperations++;
    };
    const operationFinished = (): void => {
      activeOperations--;
      if (activeOperations === 0) {
        notifyOperationsIdle?.();
        notifyOperationsIdle = undefined;
      }
    };
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
        operationStarted();
        const promise = performStartTask(projectId, task, submissionId, hash).finally(() => {
          if (inFlight.get(submissionId)?.promise === promise) inFlight.delete(submissionId);
          operationFinished();
        });
        inFlight.set(submissionId, { hash, promise });
        return promise;
      },
      async listChats(projectId) {
        const project = projectById.get(projectId);
        if (!project) return null;
        const summaries = await runningCore.listChats();
        const allowed = await Promise.all(
          summaries.map(async (summary) => {
            const view = await readChat(summary.id);
            if (!view) return null;
            return fs.realpathSync(view.chat.projectPath!) === project.path ? summary : null;
          }),
        );
        return allowed.filter((summary): summary is ChatSummary => summary !== null);
      },
      createChat(projectId) {
        if (hostClosing) throw new ShuttingDownError();
        const project = projectById.get(projectId);
        if (!project) return Promise.resolve(null);
        operationStarted();
        return (async () => {
          try {
            let chat: ChatFile;
            try {
              chat = await runningCore.createChat({ projectPath: project.path, edits: false });
            } catch (error) {
              if (hostClosing || runningCore.kernel.closing) throw new ShuttingDownError();
              throw error;
            }
            const saved = await runningCore.getChat(chat.id);
            if (!saved) throw new ShuttingDownError();
            return saved.chat;
          } finally {
            operationFinished();
          }
        })();
      },
      readChat,
      sendChat(chatId, text, submissionId) {
        if (hostClosing) throw new ShuttingDownError();
        const message = text.trim();
        if (!message) return Promise.resolve({ status: 'invalid', message: 'Введите сообщение' });
        if (!submissionIdPattern.test(submissionId)) {
          return Promise.resolve({ status: 'invalid', message: 'Некорректный идентификатор отправки' });
        }
        const hash = createHash('sha256')
          .update(JSON.stringify([chatId, message]))
          .digest('hex');
        const existing = chatInFlight.get(submissionId);
        if (existing) return existing.hash === hash ? existing.promise : Promise.resolve({ status: 'conflict' });
        operationStarted();
        const promise = performChatSend(chatId, message, submissionId, hash).finally(() => {
          if (chatInFlight.get(submissionId)?.promise === promise) chatInFlight.delete(submissionId);
          operationFinished();
        });
        chatInFlight.set(submissionId, { hash, promise });
        return promise;
      },
      readRun,
      intents() {
        const intents: AttentionIntent[] = [];
        for (const summary of runningCore.kernel.store.list()) {
          const run = readAllowedRun(summary.id);
          const intent = run ? attentionIntent(run) : null;
          if (intent) intents.push(intent);
        }
        return intents;
      },
      onIntentChange(fn) {
        const listener = { fn, keys: new Map<string, string | null>() };
        intentListeners.add(listener);
        let subscribed = true;
        return () => {
          if (!subscribed) return;
          subscribed = false;
          intentListeners.delete(listener);
        };
      },
      async readLog(id) {
        if (!(await readRun(id))) return null;
        return runningCore.getLog(id);
      },
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
      async stop(id) {
        if (!(await readRun(id))) return { status: 'notFound' };
        const result = await runningCore.stopActive(id);
        if (result.ok) return { status: 'ok' };
        const snapshot = await readRun(id);
        return snapshot ? { status: 'conflict', snapshot } : { status: 'notFound' };
      },
      close() {
        if (closing) return closing;
        hostClosing = true;
        const stopping = runningCore.shutdown();
        closing = (async () => {
          try {
            if (activeOperations > 0) {
              await new Promise<void>((resolve) => (notifyOperationsIdle = resolve));
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
