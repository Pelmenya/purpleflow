import fs from 'node:fs';
import path from 'node:path';
import type { CoreApi } from '../model/api.js';
import type { ChatFile } from '../model/chat.js';
import type { CoreCommand, CoreEvent } from '../model/protocol.js';
import type { RunFile } from '../model/run.js';
import { RunStore } from '../store.js';

export type Access = 'run' | 'chat' | 'project' | 'optionalProject' | 'command' | 'newChat' | 'list' | 'owner' | 'later';

export const CORE_ACCESS = {
  getRun: 'run',
  getLog: 'run',
  getDiff: 'run',
  getChangedFiles: 'run',
  getChangeDocs: 'run',
  isDriving: 'run',
  listBranches: 'run',
  mergeCheck: 'run',
  getAttachment: 'run',
  getVisualShot: 'run',
  prReady: 'run',
  getPrStatus: 'run',
  getPrDetails: 'run',
  startPreview: 'run',
  stopPreview: 'run',
  getPreview: 'run',
  nextPartDraft: 'run',
  getManagerChat: 'run',
  askManager: 'run',
  getManagerImage: 'run',
  resolveManagerAction: 'run',
  getChat: 'chat',
  updateChat: 'chat',
  deleteChat: 'chat',
  sendChat: 'chat',
  allowChatMcp: 'chat',
  grantChatFullAccess: 'chat',
  answerChatPermission: 'chat',
  stopChat: 'chat',
  unqueueChat: 'chat',
  chatToTask: 'chat',
  getChatDiff: 'chat',
  getChatChangedFiles: 'chat',
  compactChat: 'chat',
  detectProject: 'project',
  initRepo: 'project',
  detectCommandsAI: 'project',
  getProjectConfig: 'project',
  checkCommands: 'project',
  getKnowledge: 'project',
  saveKnowledge: 'project',
  saveKnowledgeProfile: 'project',
  removeKnowledgeLesson: 'project',
  refreshProfile: 'project',
  saveProjectConfig: 'project',
  detectForge: 'project',
  projectOverview: 'project',
  forgetProject: 'project',
  projectBranches: 'project',
  cleanWorkingCopy: 'project',
  checkEnvironment: 'project',
  projectStats: 'project',
  listChatFiles: 'project',
  readChatFile: 'project',
  getGitGraph: 'project',
  getGitCommitDiff: 'project',
  listChatSkills: 'optionalProject',
  listOpencodeModels: 'optionalProject',
  dispatch: 'command',
  createChat: 'newChat',
  listRuns: 'list',
  listChats: 'list',
  listProjects: 'list',
  detectTools: 'owner',
  installTool: 'owner',
  detectNode: 'owner',
  installNode: 'owner',
  testConnection: 'owner',
  suggestMode: 'owner',
  chatDefaultModel: 'owner',
  listAgyModels: 'owner',
  getStorage: 'later',
  cleanStorage: 'later',
} satisfies Record<keyof CoreApi, Access>;

export interface AccessContext {
  readonly dataDir: string;
  readonly store: RunStore;
  readonly allowProject: (projectPath: string) => boolean;
  readonly seenRuns: Set<string>;
  readonly seenChats: Set<string>;
}

export class AccessError extends Error {
  constructor(readonly code: 'forbidden' | 'unavailable') {
    super(code === 'forbidden' ? 'Нет доступа' : 'Недоступно в браузере до Ф11');
    this.name = 'AccessError';
  }
}

export function createAccessContext(options: { dataDir: string; allowProject: (projectPath: string) => boolean }): AccessContext {
  return {
    dataDir: options.dataDir,
    store: new RunStore(options.dataDir),
    allowProject: options.allowProject,
    seenRuns: new Set(),
    seenChats: new Set(),
  };
}

function forbidden(): never {
  throw new AccessError('forbidden');
}

export function readChatSubject(dataDir: string, id: unknown): ChatFile {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) forbidden();
  try {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(dataDir, 'chats', `${id}.json`), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) forbidden();
    const chat = value as ChatFile;
    if (chat.projectPath !== undefined && typeof chat.projectPath !== 'string') forbidden();
    return chat;
  } catch (error) {
    if (error instanceof AccessError) throw error;
    forbidden();
  }
}

function readAllowedRun(context: AccessContext, id: unknown): RunFile {
  if (typeof id !== 'string') forbidden();
  const run = context.store.load(id);
  if (!run || !context.allowProject(run.projectPath)) forbidden();
  return run;
}

function readAllowedChat(context: AccessContext, id: unknown): ChatFile {
  const chat = readChatSubject(context.dataDir, id);
  if (chat.projectPath !== undefined && !context.allowProject(chat.projectPath)) forbidden();
  return chat;
}

function addRealPath(paths: Set<string>, value: unknown): void {
  if (typeof value !== 'string') return;
  try {
    paths.add(fs.realpathSync(value));
  } catch {
    // Удалённое вложение больше не может служить источником пути.
  }
}

function allowedAttachmentPaths(context: AccessContext): Set<string> {
  const result = new Set<string>();
  for (const summary of context.store.list()) {
    if (!context.allowProject(summary.projectPath)) continue;
    const run = context.store.load(summary.id);
    if (!run) continue;
    for (const attachment of run.attachments ?? []) addRealPath(result, attachment);
  }

  let files: string[];
  try {
    files = fs.readdirSync(path.join(context.dataDir, 'chats'));
  } catch {
    return result;
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const chat = readAllowedChat(context, file.slice(0, -5));
      for (const message of Array.isArray(chat.messages) ? chat.messages : []) {
        for (const attachment of message.attachments ?? []) addRealPath(result, attachment);
      }
    } catch {
      // Повреждённые и недопущенные чаты не дают источников вложений.
    }
  }
  return result;
}

function admitCommand(context: AccessContext, value: unknown): void {
  if (!value || typeof value !== 'object') forbidden();
  const command = value as CoreCommand;
  if (command.type === 'run.start') {
    const input = command.input;
    if (!input || typeof input !== 'object' || !context.allowProject(input.projectPath)) forbidden();
    if (input.attachmentPaths === undefined) return;
    if (!Array.isArray(input.attachmentPaths) || input.attachmentPaths.some((file) => typeof file !== 'string')) forbidden();
    if (input.attachmentPaths.length === 0) return;
    const allowed = allowedAttachmentPaths(context);
    for (const attachment of input.attachmentPaths) {
      try {
        if (!allowed.has(fs.realpathSync(attachment))) forbidden();
      } catch (error) {
        if (error instanceof AccessError) throw error;
        forbidden();
      }
    }
    return;
  }
  if (!('runId' in command)) forbidden();
  context.seenRuns.add(readAllowedRun(context, command.runId).id);
}

export function admitCall(context: AccessContext, method: keyof CoreApi, args: unknown[]): void {
  switch (CORE_ACCESS[method]) {
    case 'run':
      context.seenRuns.add(readAllowedRun(context, args[0]).id);
      return;
    case 'chat':
      context.seenChats.add(readAllowedChat(context, args[0]).id);
      return;
    case 'project':
      if (typeof args[0] !== 'string' || !context.allowProject(args[0])) forbidden();
      return;
    case 'optionalProject':
      if (args[0] !== undefined && (typeof args[0] !== 'string' || !context.allowProject(args[0]))) forbidden();
      return;
    case 'command':
      admitCommand(context, args[0]);
      return;
    case 'newChat': {
      const options = args[0] as { projectPath?: unknown } | undefined;
      if (!options || typeof options !== 'object') forbidden();
      if (options.projectPath !== undefined && (typeof options.projectPath !== 'string' || !context.allowProject(options.projectPath)))
        forbidden();
      return;
    }
    case 'list':
    case 'owner':
      return;
    case 'later':
      throw new AccessError('unavailable');
  }
}

export function filterResult(context: AccessContext, method: keyof CoreApi, result: unknown): unknown {
  if (!Array.isArray(result)) return result;
  if (method === 'listRuns') {
    return result.filter((run): run is { id: string; projectPath: string } => {
      if (!run || typeof run !== 'object' || typeof run.id !== 'string' || typeof run.projectPath !== 'string') return false;
      if (!context.allowProject(run.projectPath)) return false;
      context.seenRuns.add(run.id);
      return true;
    });
  }
  if (method === 'listChats') {
    return result.filter((chat): chat is { id: string; projectPath?: string } => {
      if (!chat || typeof chat !== 'object' || typeof chat.id !== 'string') return false;
      if (chat.projectPath !== undefined && (typeof chat.projectPath !== 'string' || !context.allowProject(chat.projectPath))) return false;
      context.seenChats.add(chat.id);
      return true;
    });
  }
  if (method === 'listProjects') {
    return result.filter(
      (project) => project && typeof project === 'object' && typeof project.path === 'string' && context.allowProject(project.path),
    );
  }
  return result;
}

export function admitEvent(context: AccessContext, event: CoreEvent): boolean {
  try {
    if (event.type === 'run.updated') {
      if (!context.allowProject(event.run.projectPath)) return false;
      context.seenRuns.add(event.run.id);
      return true;
    }
    if (event.type === 'chat.updated') {
      if (!event.chat.projectPath || !context.allowProject(event.chat.projectPath)) return false;
      context.seenChats.add(event.chat.id);
      return true;
    }
    if (event.type === 'run.deleted') return context.seenRuns.has(event.runId);
    if (event.type === 'chat.deleted') return context.seenChats.has(event.chatId);
    context.seenRuns.add(readAllowedRun(context, event.runId).id);
    return true;
  } catch (error) {
    if (error instanceof AccessError) return false;
    throw error;
  }
}

export function redactSecrets<T>(value: T, secrets: Iterable<string>): T {
  const known = [...new Set(secrets)].filter((secret) => secret.length >= 8);
  const visit = (current: unknown): unknown => {
    if (typeof current === 'string') {
      return known.reduce((text, secret) => text.split(secret).join('***'), current);
    }
    if (Array.isArray(current)) return current.map(visit);
    if (!current || typeof current !== 'object' || current instanceof Date || ArrayBuffer.isView(current)) return current;
    return Object.fromEntries(Object.entries(current).map(([key, item]) => [key, visit(item)]));
  };
  return visit(value) as T;
}
