import fs from 'node:fs';
import path from 'node:path';
import { readJsonc, removeJsoncField } from './jsonc.js';
import { homeDir, linuxConfigHome, platform } from './os.js';
import { readWindowsUserEnvVar, removeWindowsUserEnvVars } from './shellRc.js';
import { RC_BLOCK_START, RC_BLOCK_END } from '../constants.js';
import type { ModelCatalog } from './models.js';

/** How a conflict can be cleaned up. "manual" = we found it but won't edit the file for the user. */
export type ConflictFix = { kind: 'json'; file: string; path: (string | number)[] } | { kind: 'winenv'; key: string } | { kind: 'manual' };

export interface SettingsConflict {
  description: string;
  fix: ConflictFix;
}

export function claudeSettingsPath(): string {
  return path.join(claudeConfigDir(), 'settings.json');
}

export function claudeJsonPath(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR ? claudeConfigDir() : homeDir(), '.claude.json');
}

function claudeConfigDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  if (configured && !path.isAbsolute(configured))
    throw new Error('CLAUDE_CONFIG_DIR должен содержать абсолютный путь. Исправь переменную и повтори запуск; настройки не изменены.');
  return configured || path.join(homeDir(), '.claude');
}

const PROVIDER_SWITCHES = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];

function enabled(value: unknown): boolean {
  return typeof value === 'string' && !['', '0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

export function claudeEnvConflicts(key: string, value: string | undefined): boolean {
  return key === 'ANTHROPIC_AUTH_TOKEN' ? Boolean(value) : enabled(value);
}

/** Accept only a single literal; expansions, commands and compound statements stay ambiguous. */
function shellLiteral(value: string): string | undefined {
  const match = value.match(/^\s*(?:'([^']*)'|"([^"\\$`]*)"|([^\s'"\\$`;#]*))\s*(?:#.*)?$/);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

export function shellClaudeEnvConflicts(text: string, key: string): boolean {
  const assignment = new RegExp(`^\\s*(?:export\\s+${key}=(.*)|set\\s+-gx\\s+${key}(?:\\s+(.*))?)$`);
  return text.split(/\r?\n/).some((line) => {
    const match = line.match(assignment);
    if (!match) return false;
    const value = shellLiteral(match[1] ?? match[2] ?? '');
    return value === undefined || claudeEnvConflicts(key, value);
  });
}

/**
 * Env vars that break our setup outright when left over from a previous, hand-rolled
 * configuration. ANTHROPIC_AUTH_TOKEN is the big one: with both it and ANTHROPIC_API_KEY set,
 * Claude Code prefers the token and sends it as `Authorization: Bearer`, while the PurpleSchool
 * proxy authenticates via `x-api-key` — the request reaches the proxy and comes back
 * `401 Invalid token payload`. Claude Code itself warns about the combination on startup.
 * ANTHROPIC_BASE_URL is listed because a stale one silently points at the wrong proxy.
 */
const LEGACY_ENV_VARS: Record<string, string> = {
  ANTHROPIC_AUTH_TOKEN:
    'перебивает ANTHROPIC_API_KEY: Claude Code шлёт его как `Authorization: Bearer`, а прокси PurpleSchool ждёт `x-api-key` → 401 Invalid token payload',
  ANTHROPIC_BASE_URL: 'старый адрес прокси может перебить наш',
  ANTHROPIC_API_KEY: 'дубль ключа — мы прописываем его сами, старое значение может оказаться неактуальным',
};

function readEnvBlock(filePath: string): Record<string, unknown> | undefined {
  const env = readJsonc<Record<string, unknown>>(filePath)?.env;
  return env && typeof env === 'object' ? (env as Record<string, unknown>) : undefined;
}

/**
 * Finds leftovers from previous manual Claude Code setups that our own config can't override.
 * Covers every place a credential can hide: ~/.claude/settings.json, ~/.claude.json (which
 * Claude Code does read an `env` block from, confirmed on v2.1.273), the user's shell rc
 * outside our marker block, and Windows user env vars in the registry.
 *
 * Deliberately conservative: only entries we have concrete evidence about, never a general
 * "unknown key" heuristic — Claude Code has plenty of legitimate env vars (Bedrock/Vertex auth,
 * custom headers, compact-window tuning) that a broad rule would flag as false positives.
 */
export function detectClaudeConflicts(proxyModels?: ModelCatalog): SettingsConflict[] {
  const conflicts: SettingsConflict[] = [];
  const settingsPath = claudeSettingsPath();
  const jsonPath = claudeJsonPath();

  const settings = readJsonc<Record<string, unknown>>(settingsPath);

  // Documented behavior (Anthropic's own gateway-connect guide): apiKeyHelper's output is sent
  // in both the Authorization and x-api-key headers and takes precedence over env.ANTHROPIC_API_KEY —
  // if it points anywhere other than our key, our env block gets silently overridden.
  if (settings && 'apiKeyHelper' in settings) {
    conflicts.push({
      description: `${settingsPath}: apiKeyHelper (${JSON.stringify(settings.apiKeyHelper)}) — по документации Anthropic имеет приоритет над env.ANTHROPIC_API_KEY`,
      fix: { kind: 'json', file: settingsPath, path: ['apiKeyHelper'] },
    });
  }

  const settingsEnv = readEnvBlock(settingsPath);
  for (const key of PROVIDER_SWITCHES) {
    if (enabled(settingsEnv?.[key]))
      conflicts.push({
        description: `${settingsPath}: env.${key} выбирает другого провайдера вместо API-прокси PurpleSchool`,
        fix: { kind: 'json', file: settingsPath, path: ['env', key] },
      });
  }
  if (settingsEnv && 'CLAUDE_CODE_DISABLE_GATEWAY' in settingsEnv) {
    conflicts.push({
      description: `${settingsPath}: env.CLAUDE_CODE_DISABLE_GATEWAY — нет в документации Anthropic; судя по названию, отключает обработку ANTHROPIC_BASE_URL как шлюза`,
      fix: { kind: 'json', file: settingsPath, path: ['env', 'CLAUDE_CODE_DISABLE_GATEWAY'] },
    });
  }
  if (settingsEnv && 'ANTHROPIC_AUTH_TOKEN' in settingsEnv) {
    conflicts.push({
      description: `${settingsPath}: env.ANTHROPIC_AUTH_TOKEN — ${LEGACY_ENV_VARS.ANTHROPIC_AUTH_TOKEN}`,
      fix: { kind: 'json', file: settingsPath, path: ['env', 'ANTHROPIC_AUTH_TOKEN'] },
    });
  }

  // ~/.claude.json is Anthropic's project-state file, but v2.1.273 does read an `env` block from
  // it — a real user hit exactly this: a hand-added ANTHROPIC_AUTH_TOKEN there produced the
  // "Both ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY set" warning and a hard 401 on every request.
  // We settle every credential in settings.json, so anything Anthropic-ish here is a leftover.
  const jsonEnv = readEnvBlock(jsonPath);
  for (const key of Object.keys(jsonEnv ?? {})) {
    if (key in LEGACY_ENV_VARS || (PROVIDER_SWITCHES.includes(key) && enabled(jsonEnv?.[key]))) {
      conflicts.push({
        description: `${jsonPath}: env.${key} — ${LEGACY_ENV_VARS[key] ?? 'выбирает другого провайдера'} (мы прописываем всё в ${settingsPath}, здесь дубль лишний)`,
        fix: { kind: 'json', file: jsonPath, path: ['env', key] },
      });
    }
  }

  // A model pinned via /model lives in ~/.claude.json and is sent on every request. Anything
  // outside the proxy's catalogue fails — a leftover "sonnet[1m]" pin is a common one, since
  // the 1M-context variant isn't proxied. Сверяем только с каталогом, который прокси вернул
  // сам: зашитый список устаревает, и по нему мы бы «чинили» рабочую модель вроде claude-sonnet-5.
  const pinnedModel = readJsonc<{ model?: unknown }>(jsonPath)?.model;
  if (proxyModels && typeof pinnedModel === 'string' && !(pinnedModel in proxyModels)) {
    conflicts.push({
      description: `${jsonPath}: model = ${JSON.stringify(pinnedModel)} — этой модели нет в каталоге прокси PurpleSchool, запросы к ней будут падать`,
      fix: { kind: 'json', file: jsonPath, path: ['model'] },
    });
  }

  conflicts.push(...detectShellLeftovers());
  for (const key of ['ANTHROPIC_AUTH_TOKEN', ...PROVIDER_SWITCHES]) {
    if (claudeEnvConflicts(key, process.env[key]))
      conflicts.push({
        description: `В окружении текущего терминала установлена ${key}. Убери её из источника настройки и открой новый терминал перед повторным запуском мастера.`,
        fix: { kind: 'manual' },
      });
  }

  return conflicts;
}

/**
 * Credentials exported straight from a shell rc (not via our marker block) or, on Windows, set
 * with `setx` by a previous manual setup. We never rewrite a line we didn't author, so rc hits
 * are reported as manual — the registry ones we can delete cleanly.
 */
function detectShellLeftovers(): SettingsConflict[] {
  const conflicts: SettingsConflict[] = [];

  if (platform() === 'win32') {
    // Our own writes contain API_KEY/BASE_URL, never a token or another provider selector.
    for (const key of ['ANTHROPIC_AUTH_TOKEN', ...PROVIDER_SWITCHES])
      if (claudeEnvConflicts(key, readWindowsUserEnvVar(key))) {
        conflicts.push({
          description: `Переменная Windows ${key} (HKCU\\Environment) — ${LEGACY_ENV_VARS[key] ?? 'может выбрать другого провайдера'}`,
          fix: { kind: 'winenv', key },
        });
      }
    return conflicts;
  }

  for (const file of candidateShellRcFiles()) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    // Strip our own block first — the vars we manage there are not leftovers.
    const outside = text.replace(new RegExp(`${RC_BLOCK_START}[\\s\\S]*?${RC_BLOCK_END}`, 'gm'), '');
    for (const key of ['ANTHROPIC_AUTH_TOKEN', ...PROVIDER_SWITCHES])
      if (shellClaudeEnvConflicts(outside, key)) {
        conflicts.push({
          description: `${file}: ${key} выставляется вручную вне нашего блока — ${LEGACY_ENV_VARS[key] ?? 'может выбрать другого провайдера'}. Убери эту строку сам: чужие строки в rc-файле мы не трогаем`,
          fix: { kind: 'manual' },
        });
      }
  }

  return conflicts;
}

/** Every rc file a leftover export could plausibly live in — we scan all of them, not just the active shell's. */
function candidateShellRcFiles(): string[] {
  const home = homeDir();
  return [
    ...new Set([
      path.join(home, '.zshrc'),
      path.join(home, '.bashrc'),
      path.join(home, '.bash_profile'),
      path.join(home, '.profile'),
      path.join(process.env.ZDOTDIR || home, '.zshrc'),
      path.join(linuxConfigHome(), 'fish', 'config.fish'),
    ]),
  ];
}

/** Applies a conflict's cleanup. Returns false for conflicts only the user can resolve. */
export function fixConflict(conflict: SettingsConflict): boolean {
  switch (conflict.fix.kind) {
    case 'json':
      removeJsoncField(conflict.fix.file, conflict.fix.path);
      return true;
    case 'winenv':
      removeWindowsUserEnvVars([conflict.fix.key]);
      return true;
    case 'manual':
      return false;
  }
}
