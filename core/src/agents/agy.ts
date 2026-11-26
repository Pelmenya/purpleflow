import fs from 'node:fs';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { run } from '../proc.js';
import {
  addUsage,
  c,
  cleanEnv,
  clip,
  crlf,
  defined,
  emptyUsage,
  explainError,
  plainOutput,
  stripAnsi,
  type AgentResult,
  type AgentRunOptions,
  type AgentStep,
} from './common.js';
import { toolName, toolView } from './tools.js';

/**
 * Antigravity CLI через ACP (Agent Client Protocol): `agy acp` — JSON-RPC по stdin/stdout.
 *
 * Почему не `agy -p`: в headless-режиме вход только через аккаунт Google (с проверкой региона), а ACP
 * принимает ключ Gemini API — с ним и GOOGLE_GEMINI_BASE_URL agy ходит в AI-прокси PurpleSchool.
 * И второе: перед действием agy спрашивает разрешение у клиента (session/request_permission), поэтому
 * «только чтение» и «Правки» решает PurpleFlow на каждый вызов, а не промпт.
 */
export interface AgyOptions extends AgentRunOptions {
  /** Стадия не меняет файлы (уточнение, ревью, служебное): правки и команды, кроме читающих, отклоняются. */
  readOnly?: boolean;
  /** Правки в чате без полного доступа: запись — только в папке проекта, .git и git-операции закрыты. */
  limited?: boolean;
  /** Продолжить сохранённую беседу ACP (session/resume). */
  resumeConversation?: string;
  /**
   * Спросить человека о действии, которое режим не пускает (чат в «Правках»). Без него — отказ сразу.
   * once — только этот вызов, always — до конца хода и дальше по allowed, deny — отказ.
   */
  askPermission?: (q: AgyPermissionQuestion) => Promise<AgyPermissionAnswer>;
  /** Ключи действий (agyPermissionKey), которые человек уже разрешил «в этом чате». */
  allowed?: string[];
  /** Человек разрешил действие «в этом чате»: ключ сохранить для следующих ходов. */
  onAllow?: (key: string) => void;
}

export interface AgyPermissionQuestion {
  id: string;
  /** Действие одной строкой, как в ленте. */
  text: string;
  /** Команда или путь целиком. */
  detail?: string;
  /** Почему режим его не пускает. */
  reason: string;
}
export type AgyPermissionAnswer = 'once' | 'always' | 'deny';

/**
 * Ключ «то же самое действие»: команда — дословно, правка — по пути. «Разрешать в этом чате»
 * пускает ровно это, а не все команды или всю запись вне проекта.
 */
export function agyPermissionKey(call: Record<string, unknown>): string {
  const args = (call.rawInput ?? call.args ?? {}) as Record<string, unknown>;
  const command = typeof args.CommandLine === 'string' ? args.CommandLine : typeof args.command === 'string' ? args.command : '';
  if (command) return `command:${command.trim()}`;
  const p = toolPaths(call)[0];
  return `${String(call.kind ?? 'other')}:${p ? path.resolve(p) : String(call.name ?? '')}`;
}

/** Модель по умолчанию через прокси: своя модель agy по умолчанию (gemini-3.1-pro) в прокси не продаётся. */
export const AGY_PROXY_DEFAULT_MODEL = 'gemini-3.8-flash';

/** Каталог данных agy для запусков через прокси: вход по ключу не трогает вход пользователя в Google. */
export const AGY_PROXY_DATA_DIR = 'antigravity-purpleflow';

const EFFORT_SUFFIX = /-(low|medium|high|xhigh)$/;

/** Адрес Gemini API прокси: рядом с anthropic-адресом из настроек. */
export function agyProxyBase(p: NonNullable<AgentRunOptions['proxy']>): string {
  const b = p.baseUrl.trim().replace(/\/+$/, '');
  return `${b.replace(/\/(anthropic|openai)(\/v\d+)?$/, '')}/gemini`;
}

/**
 * Модель ACP: у agy уровень рассуждений — суффикс имени (gemini-3.8-flash-high).
 * Суффикс берём из effort, если в имени его нет и agy знает такую модель; иначе имя как есть.
 */
export function agyModelId(model: string | undefined, effort: string | undefined, available: string[]): string | undefined {
  if (!model) return undefined;
  if (EFFORT_SUFFIX.test(model) || !effort) return model;
  const id = `${model}-${effort}`;
  return available.includes(id) ? id : model;
}

/** Аргументы `agy acp`. Права не снимаются: на каждый вызов agy спросит клиента. */
export function agyArgs(o: Pick<AgyOptions, 'addDirs' | 'proxy'>): string[] {
  const args = ['acp', '--disable-telemetry'];
  if (o.proxy?.baseUrl) args.push('--app-data-dir', AGY_PROXY_DATA_DIR);
  for (const d of o.addDirs ?? []) args.push('--add-dir', d);
  return args;
}

/** Окружение: ключ прокси — только в переменных процесса, не в аргументах и не на диске. */
export function agyEnv(o: Pick<AgyOptions, 'env' | 'proxy'>): NodeJS.ProcessEnv {
  const env = cleanEnv(o.env);
  if (o.proxy?.baseUrl) {
    env.GEMINI_API_KEY = o.proxy.apiKey;
    env.GOOGLE_GEMINI_BASE_URL = agyProxyBase(o.proxy);
    delete env.GOOGLE_API_KEY;
    delete env.GOOGLE_GENAI_USE_VERTEXAI;
  }
  return env;
}

type Part = Record<string, unknown>;

/** Имена инструментов agy → привычные по claude, чтобы чат показывал их так же. */
const TOOL_NAMES: Record<string, string> = {
  run_command: 'Bash',
  read_file: 'Read',
  view_file: 'Read',
  write_file: 'Write',
  write_to_file: 'Write',
  edit_file: 'Edit',
  replace_file_content: 'Edit',
  multi_replace_file_content: 'Edit',
  list_dir: 'LS',
  list_directory: 'LS',
  grep_search: 'Grep',
  find_by_name: 'Glob',
  glob_search: 'Glob',
  search_web: 'WebSearch',
  read_url: 'WebFetch',
  read_url_content: 'WebFetch',
  invoke_subagent: 'Task',
};

/** Аргументы agy → имена claude: главный аргумент должен найти toolView. */
export function agyToolInput(params: Part): Part {
  const out: Part = { ...params };
  const move = (from: string, to: string) => {
    if (params[from] != null && out[to] == null) out[to] = params[from];
    delete out[from];
  };
  move('CommandLine', 'command');
  move('TargetFile', 'file_path');
  move('AbsolutePath', 'file_path');
  move('Path', 'file_path');
  move('DirectoryPath', 'path');
  move('SearchPath', 'path');
  move('CodeContent', 'content');
  move('Content', 'content');
  move('Query', 'pattern');
  move('Pattern', 'pattern');
  move('Url', 'url');
  delete out.toolSummary;
  delete out.WaitMsBeforeAsync;
  return out;
}

function describeTool(name: string, params: Part): string {
  return toolView(TOOL_NAMES[name] ?? name, agyToolInput(params)).text || toolName(TOOL_NAMES[name] ?? name);
}

/** Пути вызова: locations из ACP и аргументы с путём. */
function toolPaths(call: Part): string[] {
  const out: string[] = [];
  for (const l of Array.isArray(call.locations) ? call.locations : []) {
    const p = (l as Part)?.path;
    if (typeof p === 'string') out.push(p);
  }
  const args = ((call.rawInput ?? call.args ?? {}) as Part) || {};
  for (const k of ['Path', 'TargetFile', 'AbsolutePath', 'DirectoryPath', 'SourcePath', 'DestinationPath']) {
    if (typeof args[k] === 'string') out.push(args[k] as string);
  }
  return out;
}

const READ_BINS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'rg',
  'find',
  'fd',
  'tree',
  'pwd',
  'echo',
  'stat',
  'file',
  'du',
  'which',
  'sort',
  'uniq',
  'cut',
  'awk',
  'diff',
  'less',
  'more',
  'jq',
  'basename',
  'dirname',
  'realpath',
  'date',
  'env',
  'printenv',
]);
const GIT_READ = new Set([
  'status',
  'log',
  'diff',
  'show',
  'branch',
  'rev-parse',
  'ls-files',
  'blame',
  'grep',
  'describe',
  'shortlog',
  'tag',
  'remote',
  'cat-file',
  'ls-tree',
  'merge-base',
]);

/**
 * Команда только читает: каждый кусок цепочки — читающая утилита или читающий git,
 * без перенаправлений в файл, подстановок и опасных флагов.
 */
export function readOnlyCommand(cmd: string): boolean {
  const t = cmd.trim();
  if (!t || /[>`]|\$\(|<\(/.test(t)) return false;
  return t.split(/&&|\|\||[|;\n]/).every((seg) => {
    const w = seg.trim().split(/\s+/);
    if (!w[0]) return true;
    const bin = path.basename(w[0]);
    if (bin === 'git') {
      const sub = w.slice(1).find((x) => !x.startsWith('-'));
      if (!sub || !GIT_READ.has(sub)) return false;
      // branch/tag/remote читают только без аргументов-имен: «git branch x» создаёт ветку.
      if (['branch', 'tag', 'remote'].includes(sub) && w.slice(2).some((x) => !x.startsWith('-') && x !== '-v')) return false;
      return !w.some((x) => /^(-D|-d|--delete|-m|-M|--move|--set-upstream)/.test(x));
    }
    if (!READ_BINS.has(bin)) return false;
    if (bin === 'find' && w.some((x) => /^-(delete|exec|execdir|ok|fprint)/.test(x))) return false;
    if (bin === 'awk' && /system\(|print\s*>/.test(seg)) return false;
    return true;
  });
}

/** Git-операции, которые меняют репозиторий: в «Правках» закрыты, как у codex и claude в песочнице. */
const GIT_WRITE =
  /(^|[\s;&|(])git\s+(?:-\S+\s+)*(commit|push|pull|fetch|merge|rebase|reset|checkout|switch|restore|stash|cherry-pick|revert|tag|branch|am|apply|clean|gc|worktree|update-ref|config|init|clone|rm|mv|add)\b/;

export type AgyMode = 'readOnly' | 'limited' | 'full';

export function agyMode(o: Pick<AgyOptions, 'readOnly' | 'limited'>): AgyMode {
  return o.readOnly ? 'readOnly' : o.limited ? 'limited' : 'full';
}

/**
 * Решение по запросу разрешения: null — разрешить, строка — причина отказа.
 * В «Правках» запись — внутри папки проекта и вложений, без .git; команды — без git-операций и .git.
 */
export function agyDecision(mode: AgyMode, call: Part, roots: string[]): string | null {
  if (mode === 'full') return null;
  const kind = String(call.kind ?? 'other');
  const name = String(call.name ?? '');
  const args = (call.rawInput ?? call.args ?? {}) as Part;
  const command = typeof args.CommandLine === 'string' ? args.CommandLine : typeof args.command === 'string' ? args.command : '';
  if (mode === 'readOnly') {
    if (kind === 'read' || kind === 'search' || kind === 'think' || kind === 'fetch') return null;
    if (kind === 'execute' || name === 'run_command')
      return readOnlyCommand(command) ? null : 'стадия только читает: команда может менять проект';
    return 'стадия только читает: правки запрещены';
  }
  if (kind === 'execute' || name === 'run_command') {
    if (GIT_WRITE.test(command) || /(^|[\s/'"])\.git(\/|\s|$|['"])/.test(command)) return 'git-операции доступны только с полным доступом';
    return null;
  }
  if (kind === 'edit' || kind === 'delete' || kind === 'move') {
    const inside = (p: string) => {
      const full = path.resolve(p);
      return roots.some((r) => {
        const rel = path.relative(path.resolve(r), full);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
      });
    };
    for (const p of toolPaths(call)) {
      if (!inside(p)) return 'запись вне папки проекта доступна только с полным доступом';
      if (path.resolve(p).split(path.sep).includes('.git')) return 'папка .git открыта только с полным доступом';
    }
  }
  return null;
}

/** Сколько раз подряд просим продолжить после отказа: модель может упорно повторять запрещённое. */
const MAX_DENIAL_ROUNDS = 2;

/** Продолжение хода после отказа: модель должна закончить без этого действия и ответить. */
export const continueAfterDenial = (why: string) =>
  `PurpleFlow отклонил последнее действие: ${why}. Не повторяй его и не обходи другими средствами. Закончи задачу без него и дай итоговый ответ; если без него никак — так и скажи.`;

/** Метка отказа человеком: в ленте — «Вы отклонили», без карточки «Нужен полный доступ». */
const HUMAN_DENIED = '\0human';

/** Текст отказа: под него настроено распознавание в чате (карточка «Нужен полный доступ»). */
export const denialText = (why: string) => `Operation not permitted: PurpleFlow отклонил действие — ${why}.`;

/** Ответ на запрос разрешения: вариант allow/reject из предложенных agy. */
export function permissionOutcome(options: unknown, allow: boolean): Part {
  const list = (Array.isArray(options) ? options : []) as Part[];
  const want = allow ? 'allow' : 'reject';
  const pick =
    list.find((o) => String(o.kind ?? '').startsWith(want)) ??
    list.find((o) => String(o.optionId ?? '').startsWith(allow ? 'allow' : 'deny'));
  return pick ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : { outcome: { outcome: 'cancelled' } };
}

/** Итог вызова из tool_call_update: rawOutput.output или текст из content. */
function toolOutput(u: Part): string {
  return rawToolOutput(u)
    .replace(/^(Created|Completed) At: .*\n?/gm, '')
    .trim();
}

function rawToolOutput(u: Part): string {
  const raw = u.rawOutput as Part | undefined;
  if (typeof raw?.output === 'string') return raw.output;
  if (typeof raw?.error === 'string') return raw.error;
  const parts: string[] = [];
  for (const it of Array.isArray(u.content) ? u.content : []) {
    const inner = (it as Part)?.content as Part | undefined;
    if (typeof inner?.text === 'string') parts.push(inner.text);
  }
  return parts.join('\n');
}

const EXECUTOR_ERROR = /⚠\s*agent executor error:\s*([\s\S]*)/;

/** Сбой agy понятной фразой. */
export function agyError(raw: string, proxy: boolean, model?: string): string {
  const t = raw.toLowerCase();
  const name = model ? `«${model.replace(EFFORT_SUFFIX, '')}»` : '';
  if (proxy) {
    if (/gemini model is unavailable|not_found|\b404\b/.test(t))
      return `agy: модели${name ? ` ${name}` : ''} нет в AI-прокси PurpleSchool. Выберите другую модель Gemini из списка, например ${AGY_PROXY_DEFAULT_MODEL}.`;
    // Прокси не смог получить ответ у провайдера модели и прячет подробности: дело не в запросе, а в самой модели сейчас.
    if (/api route gemini request failed|provider request failed|upstream_error|\b50[0-4]\b/.test(t))
      return `agy: провайдер модели ${name || 'Gemini'} сейчас отвечает ошибкой на стороне AI-прокси PurpleSchool. Выберите другую модель, например ${AGY_PROXY_DEFAULT_MODEL}, или повторите позже.`;
    if (/\b401\b|\b403\b|api key not valid|invalid api key|unauthenticated|permission_denied/.test(t))
      return 'agy: прокси PurpleSchool отклонил ключ. Выберите действующий ключ в настройках, во вкладке «Аккаунт».';
  }
  if (
    /eligibility check failed|not eligible for antigravity|not (currently )?available in your (location|country|region)|unsupported (region|country)/.test(
      t,
    )
  )
    return proxy
      ? 'agy: Antigravity отклонил запуск по региону.'
      : 'agy: аккаунт Google не прошёл проверку региона Antigravity. Подключите AI-прокси PurpleSchool в настройках — с ним вход в Google не нужен.';
  if (/authentication required|auth_required|not logged in|not signed in|login required|reauth|-32000/.test(t))
    return 'agy: нужен вход. Подключите AI-прокси PurpleSchool в настройках или выполните в терминале «agy» и войдите в аккаунт Google.';
  if (/unknown command "?acp|unknown subcommand/.test(t))
    return 'agy: эта версия не поддерживает ACP. Обновите Antigravity CLI (agy update).';
  if (/quota|rate.?limit|resource_exhausted|\b429\b/.test(t)) return 'agy: исчерпан лимит запросов к модели. Повторите позже.';
  return explainError('agy', raw, proxy ? 'proxy' : 'login');
}

const STOP_ERRORS: Record<string, string> = {
  max_tokens: 'ответ упёрся в лимит токенов',
  max_turn_requests: 'превышен лимит шагов',
  refusal: 'модель отказалась отвечать',
};

/** Минимальный JSON-RPC клиент поверх stdin: запросы с ожиданием ответа, ответы на запросы agy. */
class Rpc {
  private next = 1;
  private waiting = new Map<number, { resolve: (v: Part) => void; reject: (e: Error) => void }>();
  closed = false;
  constructor(private stdin: Writable) {}
  request(method: string, params: Part): Promise<Part> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('agy закрыл соединение'));
      this.waiting.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }
  respond(id: unknown, result: Part) {
    this.write({ jsonrpc: '2.0', id, result });
  }
  fail(id: unknown, message: string) {
    this.write({ jsonrpc: '2.0', id, error: { code: -32601, message } });
  }
  /** Ответ на наш запрос; false — это не ответ. */
  settle(m: Part): boolean {
    if (m.method !== undefined || typeof m.id !== 'number') return false;
    const w = this.waiting.get(m.id);
    if (!w) return false;
    this.waiting.delete(m.id);
    const err = m.error as Part | undefined;
    if (err)
      w.reject(
        new Error(`${String(err.message ?? 'ошибка')}${err.data ? ` ${JSON.stringify(err.data)}` : ''} (${String(err.code ?? '')})`),
      );
    else w.resolve((m.result ?? {}) as Part);
    return true;
  }
  close() {
    this.closed = true;
    for (const w of this.waiting.values()) w.reject(new Error('agy закрыл соединение'));
    this.waiting.clear();
    if (!this.stdin.writableEnded) this.stdin.end();
  }
  private write(m: Part) {
    if (!this.stdin.writableEnded) this.stdin.write(`${JSON.stringify(m)}\n`);
  }
}

export async function runAgy(o: AgyOptions): Promise<AgentResult> {
  const env = agyEnv(o);
  const proxy = Boolean(o.proxy?.baseUrl);
  const mode = agyMode(o);
  const roots = [o.cwd, ...(o.addDirs ?? [])];
  const out = (s: string) => o.onOutput(crlf(s));
  let usage = emptyUsage();
  /** Ответ — текст после последнего вызова инструмента: до него идут рассуждения вслух. */
  let answer = '';
  let toolSince = false;
  /** Причина отказа, после которого ещё не было ответа: ход кончился на нём. */
  let lastDenial = '';
  let agentError = '';
  let stopReason = '';
  let protocolError = '';
  const denied = new Map<string, string>();
  const reported = new Set<string>();
  let rpc: Rpc | null = null;
  let usedModel: string | undefined;
  let ctl: { pauseIdle: (paused: boolean) => void } | null = null;
  const allowed = new Set(o.allowed ?? []);
  let ready: () => void = () => {};
  const started = new Promise<void>((r) => (ready = r));

  const step = (s: AgentStep) => o.onStep?.(s);

  const onUpdate = (u: Part) => {
    const kind = u.sessionUpdate;
    if (kind === 'agent_message_chunk') {
      const text = String(((u.content ?? {}) as Part).text ?? '');
      if (!text) return;
      const err = EXECUTOR_ERROR.exec(text);
      if (err) {
        agentError = err[1].trim();
        out(c.coral(clip(agentError, 600)) + '\n');
        return;
      }
      if (toolSince) {
        answer = '';
        toolSince = false;
      }
      lastDenial = '';
      answer += text;
      out(text);
      step({ kind: 'text', text, delta: true });
    } else if (kind === 'agent_thought_chunk') {
      const text = String(((u.content ?? {}) as Part).text ?? '');
      if (!text) return;
      out(c.dim(clip(text, 500)) + '\n');
      step({ kind: 'thinking', text, delta: true });
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      const id = String(u.toolCallId ?? '');
      const name = String(u.name ?? 'tool');
      const args = (u.rawInput ?? u.args ?? {}) as Part;
      toolSince = true;
      if (kind === 'tool_call') {
        out(c.violet('▸ ') + describeTool(name, args) + '\n');
        step(
          defined({
            kind: 'tool' as const,
            id,
            text: describeTool(name, args),
            detail: plainOutput(JSON.stringify(agyToolInput(args))) || undefined,
          }),
        );
      }
      const status = String(u.status ?? '');
      if ((status === 'completed' || status === 'failed') && !reported.has(id)) {
        reported.add(id);
        const why = denied.get(id);
        const output = why === HUMAN_DENIED ? 'Вы отклонили это действие.' : why ? denialText(why) : toolOutput(u);
        if (status === 'failed' || why) out(c.coral(clip(output, 400)) + '\n');
        step(defined({ kind: 'tool_result' as const, id, ok: status === 'completed' && !why, output: plainOutput(output) || undefined }));
      }
    } else if (kind === 'plan') {
      const items = (Array.isArray(u.entries) ? u.entries : []) as Part[];
      step({
        kind: 'todos',
        items: items.map((e) => ({
          text: String(e.content ?? ''),
          status: e.status === 'completed' ? 'completed' : e.status === 'in_progress' ? 'in_progress' : 'pending',
        })),
      });
    } else if (kind === 'usage_update') {
      const used = Number(u.used);
      const size = Number(u.size);
      if (used > 0) step(defined({ kind: 'meta' as const, context: used, contextWindow: size > 0 ? size : undefined }));
    }
  };

  const onRequest = async (m: Part) => {
    const params = (m.params ?? {}) as Part;
    const conn = rpc!;
    if (m.method === 'session/request_permission') {
      const call = (params.toolCall ?? {}) as Part;
      const id = String(call.toolCallId ?? '');
      const args = (call.rawInput ?? call.args ?? {}) as Part;
      const line = describeTool(String(call.name ?? 'tool'), args);
      const key = agyPermissionKey(call);
      let why = allowed.has(key) ? null : agyDecision(mode, call, roots);
      let human = false;
      if (why && o.askPermission) {
        const command = typeof args.CommandLine === 'string' ? args.CommandLine : undefined;
        out(c.amber(`? ${line} — ждёт решения: ${why}`) + '\n');
        ctl?.pauseIdle(true);
        let answer: AgyPermissionAnswer = 'deny';
        try {
          answer = await o.askPermission(defined({ id, text: line, detail: command ?? toolPaths(call)[0], reason: why }));
        } catch {
          /* чат закрыт или ход остановлен — отказ */
        } finally {
          ctl?.pauseIdle(false);
        }
        if (answer !== 'deny') {
          why = null;
          if (answer === 'always') {
            allowed.add(key);
            o.onAllow?.(key);
          }
        } else human = true;
      }
      if (why) {
        denied.set(id, human ? HUMAN_DENIED : why);
        lastDenial = human ? 'человек отклонил его в чате' : why;
        out(c.amber(`✕ ${line} — ${human ? 'отклонено' : why}`) + '\n');
      }
      conn.respond(m.id, permissionOutcome(params.options, !why));
      return;
    }
    // Файловую систему и терминал клиента мы не объявляли: agy работает со своими.
    conn.fail(m.id, `PurpleFlow не поддерживает ${String(m.method)}`);
  };

  const proc = run(o.bin, agyArgs(o), {
    cwd: o.cwd,
    env,
    timeoutMs: o.timeoutMs,
    idleTimeoutMs: o.idleTimeoutMs,
    group: o.group,
    onStdin: (stdin, control) => {
      ctl = control;
      rpc = new Rpc(stdin);
      ready();
    },
    onStdoutLine: (line) => {
      let m: Part;
      try {
        m = JSON.parse(line);
      } catch {
        if (line.trim()) out(c.dim(stripAnsi(line)) + '\n');
        return;
      }
      if (!rpc || rpc.settle(m)) return;
      if (m.method === 'session/update') onUpdate(((m.params ?? {}) as Part).update as Part);
      else if (m.method !== undefined && m.id !== undefined) void onRequest(m);
    },
  });

  // agy вышел посреди диалога (сбой, вход, kill): ожидающие ответа запросы отклоняются, а не висят.
  void proc.then(() => rpc?.close());

  const dialog = (async () => {
    await Promise.race([started, proc]);
    if (!rpc) return;
    const r = rpc as Rpc;
    try {
      await r.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      if (proxy) await r.request('authenticate', { methodId: 'gemini-api-key' });
      let sessionId = o.resumeConversation ?? '';
      let models: string[] = [];
      const list = (res: Part) =>
        (((res.models as Part | undefined)?.availableModels ?? []) as Part[]).map((x) => String(x.modelId ?? '')).filter(Boolean);
      if (sessionId) {
        models = list(await r.request('session/resume', { sessionId, cwd: o.cwd, mcpServers: [] }));
      } else {
        const res = await r.request(
          'session/new',
          defined({
            cwd: o.cwd,
            mcpServers: [],
            additionalDirectories: o.addDirs?.length ? o.addDirs : undefined,
            _meta: o.systemPrompt ? { antigravity: { systemPrompt: { append: o.systemPrompt } } } : undefined,
          }),
        );
        sessionId = String(res.sessionId ?? '');
        models = list(res);
        if (sessionId) o.onSession?.(sessionId);
      }
      const model = (usedModel = agyModelId(o.model || (proxy ? AGY_PROXY_DEFAULT_MODEL : undefined), o.effort, models));
      if (model) await r.request('session/set_model', { sessionId, modelId: model });
      out(
        c.dim(
          `● agy · ${model ?? 'модель по умолчанию'}${proxy ? ' · AI-прокси PurpleSchool' : ''}${mode === 'readOnly' ? ' · только чтение' : mode === 'limited' ? ' · правки в проекте' : ''}`,
        ) + '\n',
      );
      step(defined({ kind: 'meta' as const, model, cwd: o.cwd }));
      const prompt = mode === 'readOnly' ? `${o.prompt}\n\nРаботай только на чтение: правки и меняющие команды отклоняются.` : o.prompt;
      let blocks: Part[] = [{ type: 'text', text: prompt }, ...imageBlocks(o.images)];
      // После отказа в разрешении agy заканчивает ход без ответа: просим продолжить без отклонённого действия.
      for (let round = 0; ; round++) {
        lastDenial = '';
        const res = await r.request('session/prompt', { sessionId, prompt: blocks });
        stopReason = String(res.stopReason ?? '');
        const u = (res.usage ?? {}) as Part;
        usage = addUsage(usage, {
          input: Number(u.inputTokens ?? 0) || 0,
          output: (Number(u.outputTokens ?? 0) || 0) + (Number(u.thoughtTokens ?? 0) || 0),
          cacheRead: Number(u.cachedReadTokens ?? 0) || 0,
          cacheWrite: Number(u.cachedWriteTokens ?? 0) || 0,
        });
        if (stopReason !== 'end_turn' || !lastDenial || agentError || round >= MAX_DENIAL_ROUNDS) break;
        blocks = [{ type: 'text', text: continueAfterDenial(lastDenial) }];
      }
    } catch (e) {
      protocolError = (e as Error).message;
    } finally {
      r.close();
    }
  })();

  const [res] = await Promise.all([proc, dialog]);
  const text = answer.trim();
  if (res.killed) return { ok: false, text, usage, stopped: true, error: 'Остановлено' };
  if (res.timedOut)
    return {
      ok: false,
      text,
      usage,
      timedOut: true,
      error: res.idle
        ? `agy: молчал ${Math.round((o.idleTimeoutMs ?? 0) / 60000)} мин — похоже, завис; остановлен`
        : `agy: превышен предельный таймаут ${Math.round(o.timeoutMs / 60000)} мин`,
    };
  if (res.spawnError) return { ok: false, text: '', usage, error: `agy не запустился: ${res.spawnError}` };
  const raw = [agentError, protocolError, protocolError || !stopReason ? res.stderr.trim().slice(-1500) : ''].filter(Boolean).join('\n');
  if (agentError || protocolError || !stopReason) {
    if (res.stderr.trim()) out(c.coral(clip(res.stderr, 2000)) + '\n');
    return {
      ok: false,
      text,
      usage,
      error: raw ? agyError(raw, proxy, usedModel) : `agy: завершился без ответа (код выхода ${res.code ?? '—'})`,
    };
  }
  if (stopReason === 'cancelled') return { ok: false, text, usage, stopped: true, error: 'Остановлено' };
  if (STOP_ERRORS[stopReason]) return { ok: false, text, usage, error: `agy: ${STOP_ERRORS[stopReason]}` };
  return { ok: true, text, usage };
}

/** Картинки — блоками image (ACP promptCapabilities.image): base64 из файла. */
function imageBlocks(files: string[] | undefined): Part[] {
  const out: Part[] = [];
  for (const f of files ?? []) {
    const ext = path.extname(f).toLowerCase().slice(1);
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/png';
    try {
      out.push({ type: 'image', mimeType: mime, data: fs.readFileSync(f).toString('base64') });
    } catch {
      /* картинку не прочитали — промпт уйдёт без неё */
    }
  }
  return out;
}
