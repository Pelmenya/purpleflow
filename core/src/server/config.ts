import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_VARS, loadLoginShellEnv, NETWORK_VARS } from '../env.js';
import { AGENT_KINDS, type AgentKind, type CoreSettings, type ToolName } from '../model/settings.js';

export const SERVER_DEFAULTS: CoreSettings = {
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

export interface ServerProject {
  id: string;
  path: string;
  testCommand?: string;
  setupCommand?: string;
  lintCommand?: string;
}

export interface ServerConfig {
  dataDir: string;
  promptsDir: string;
  projects: ServerProject[];
  publicOrigin: string;
  port: number;
  secretFile: string;
  settings: CoreSettings;
}

type JsonObject = Record<string, unknown>;

const ROOT_KEYS = ['dataDir', 'promptsDir', 'projects', 'publicOrigin', 'port', 'secretFile', 'settings'];
const SETTINGS_KEYS = [
  'toolPaths',
  'models',
  'efforts',
  'agents',
  'enabledAgents',
  'claudeAuth',
  'userConfig',
  'maxParallel',
  'agentTimeoutMin',
  'testTimeoutMin',
];
const TOOL_PATH_KEYS: readonly ToolName[] = ['git', 'claude', 'codex', 'opencode', 'agy', 'openspec'];
const MODEL_KEYS = ['planner', 'executor', 'reviewer', 'visual', 'manager', 'scan'] as const;
const EFFORT_KEYS = ['planner', 'executor', 'reviewer'] as const;
const AGENT_KEYS = ['planner', 'executor', 'reviewer', 'visual', 'manager', 'scan'] as const;
const VISUAL_AGENTS: readonly AgentKind[] = ['claude', 'codex', 'opencode'];

function invalid(file: string, field: string, reason: string): never {
  throw new Error(`Некорректный конфиг ${file}: ${field} — ${reason}`);
}

function objectAt(file: string, value: unknown, field: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(file, field, 'ожидался объект');
  return value as JsonObject;
}

function rejectUnknownKeys(file: string, value: JsonObject, allowed: readonly string[], prefix = ''): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) invalid(file, prefix ? `${prefix}.${key}` : key, 'неизвестный ключ');
  }
}

function absolutePath(file: string, value: unknown, field: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value)) invalid(file, field, 'ожидался абсолютный путь');
  return value;
}

function stringRecord<K extends string>(file: string, value: unknown, field: string, keys: readonly K[]): Partial<Record<K, string>> {
  const record = objectAt(file, value, field);
  rejectUnknownKeys(file, record, keys, field);
  const result: Partial<Record<K, string>> = {};
  for (const key of keys) {
    const item = record[key];
    if (item === undefined) continue;
    if (typeof item !== 'string') invalid(file, `${field}.${key}`, 'ожидалась строка');
    result[key] = item;
  }
  return result;
}

function agentRecord(file: string, value: unknown): Partial<Record<(typeof AGENT_KEYS)[number], AgentKind>> {
  const record = objectAt(file, value, 'settings.agents');
  rejectUnknownKeys(file, record, AGENT_KEYS, 'settings.agents');
  const result: Partial<Record<(typeof AGENT_KEYS)[number], AgentKind>> = {};
  for (const key of AGENT_KEYS) {
    const item = record[key];
    if (item === undefined) continue;
    const allowed = key === 'visual' ? VISUAL_AGENTS : AGENT_KINDS;
    if (typeof item !== 'string' || !allowed.includes(item as AgentKind)) {
      invalid(file, `settings.agents.${key}`, 'неизвестный агент');
    }
    result[key] = item as AgentKind;
  }
  return result;
}

function enabledAgents(file: string, value: unknown): AgentKind[] {
  if (!Array.isArray(value)) invalid(file, 'settings.enabledAgents', 'ожидался массив');
  const result: AgentKind[] = [];
  for (const [index, item] of value.entries()) {
    const field = `settings.enabledAgents[${index}]`;
    if (typeof item !== 'string' || !AGENT_KINDS.includes(item as AgentKind)) invalid(file, field, 'неизвестный агент');
    if (result.includes(item as AgentKind)) invalid(file, field, 'повторный агент');
    result.push(item as AgentKind);
  }
  return result;
}

function booleanAt(file: string, value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(file, field, 'ожидался boolean');
  return value;
}

function integerAt(file: string, value: unknown, field: string, min: number, max = Infinity): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    invalid(file, field, max === Infinity ? `ожидалось целое не меньше ${min}` : `ожидалось целое от ${min} до ${max}`);
  }
  return value;
}

function mergeSettings(file: string, value: unknown, settings: CoreSettings): void {
  const raw = objectAt(file, value, 'settings');
  rejectUnknownKeys(file, raw, SETTINGS_KEYS, 'settings');
  if (raw.toolPaths !== undefined) {
    settings.toolPaths = {
      ...settings.toolPaths,
      ...stringRecord(file, raw.toolPaths, 'settings.toolPaths', TOOL_PATH_KEYS),
    };
  }
  if (raw.models !== undefined) {
    settings.models = { ...settings.models, ...stringRecord(file, raw.models, 'settings.models', MODEL_KEYS) };
  }
  if (raw.efforts !== undefined) {
    settings.efforts = { ...settings.efforts, ...stringRecord(file, raw.efforts, 'settings.efforts', EFFORT_KEYS) };
  }
  if (raw.agents !== undefined) settings.agents = { ...settings.agents, ...agentRecord(file, raw.agents) };
  if (raw.enabledAgents !== undefined) settings.enabledAgents = enabledAgents(file, raw.enabledAgents);
  if (raw.claudeAuth !== undefined) {
    if (raw.claudeAuth !== 'login') invalid(file, 'settings.claudeAuth', 'на сервере поддерживается только login');
    settings.claudeAuth = 'login';
  }
  if (raw.userConfig !== undefined) settings.userConfig = booleanAt(file, raw.userConfig, 'settings.userConfig');
  if (raw.maxParallel !== undefined) settings.maxParallel = integerAt(file, raw.maxParallel, 'settings.maxParallel', 1, 8);
  if (raw.agentTimeoutMin !== undefined) {
    settings.agentTimeoutMin = integerAt(file, raw.agentTimeoutMin, 'settings.agentTimeoutMin', 1);
  }
  if (raw.testTimeoutMin !== undefined) {
    settings.testTimeoutMin = integerAt(file, raw.testTimeoutMin, 'settings.testTimeoutMin', 1);
  }
}

function projectsAt(file: string, value: unknown): ServerConfig['projects'] {
  if (!Array.isArray(value) || value.length === 0) invalid(file, 'projects', 'ожидался непустой массив');
  const ids = new Set<string>();
  return value.map((item, index) => {
    const field = `projects[${index}]`;
    const project = objectAt(file, item, field);
    rejectUnknownKeys(file, project, ['id', 'path', 'testCommand', 'setupCommand', 'lintCommand'], field);
    const id = project.id;
    if (typeof id !== 'string' || /^[A-Za-z0-9_-]+$/.exec(id)?.[0] !== id) {
      invalid(file, `${field}.id`, 'ожидался односегментный идентификатор');
    }
    if (ids.has(id)) invalid(file, `${field}.id`, 'повторный идентификатор');
    ids.add(id);
    const command = (key: 'testCommand' | 'setupCommand' | 'lintCommand'): string | undefined => {
      const value = project[key];
      if (value !== undefined && typeof value !== 'string') invalid(file, `${field}.${key}`, 'ожидалась строка');
      return value as string | undefined;
    };
    return {
      id,
      path: absolutePath(file, project.path, `${field}.path`),
      testCommand: command('testCommand'),
      setupCommand: command('setupCommand'),
      lintCommand: command('lintCommand'),
    };
  });
}

function publicOriginAt(file: string, value: unknown): string {
  if (typeof value !== 'string') invalid(file, 'publicOrigin', 'ожидался HTTPS origin');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid(file, 'publicOrigin', 'ожидался HTTPS origin');
  }
  if (url.protocol !== 'https:' || url.origin !== value) invalid(file, 'publicOrigin', 'ожидался HTTPS origin без пути');
  return value;
}

export function loadServerConfig(file: string): ServerConfig {
  const text = fs.readFileSync(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Не удалось разобрать JSON конфига ${file}`);
  }
  const raw = objectAt(file, parsed, '<корень>');
  rejectUnknownKeys(file, raw, ROOT_KEYS);
  const settings = structuredClone(SERVER_DEFAULTS);
  if (raw.settings !== undefined) mergeSettings(file, raw.settings, settings);
  return {
    dataDir: absolutePath(file, raw.dataDir, 'dataDir'),
    promptsDir:
      raw.promptsDir === undefined
        ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../prompts')
        : absolutePath(file, raw.promptsDir, 'promptsDir'),
    projects: projectsAt(file, raw.projects),
    publicOrigin: publicOriginAt(file, raw.publicOrigin),
    port: integerAt(file, raw.port, 'port', 1, 65535),
    secretFile: absolutePath(file, raw.secretFile, 'secretFile'),
    settings,
  };
}

export function readSecret(file: string): string {
  if ((fs.statSync(file).mode & 0o077) !== 0) {
    throw new Error(`Файл секрета ${file} доступен группе или остальным пользователям`);
  }
  const secret = fs.readFileSync(file, 'utf8').trim();
  if (!secret) throw new Error(`Файл секрета ${file} пуст`);
  return secret;
}

export function buildAgentEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const key of [...BASE_VARS, ...NETWORK_VARS]) {
    if (base[key] !== undefined) clean[key] = base[key];
  }
  clean.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  return loadLoginShellEnv(clean);
}
