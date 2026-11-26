import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { homeDir, linuxConfigHome, platform, windowsSystemTool } from './os.js';
import { RC_BLOCK_START, RC_BLOCK_END } from '../constants.js';
import { backupFile } from './backup.js';
import { isDryRun } from './runtime.js';

type EnvVarSet = Record<string, string>;

interface ShellRc {
  file: string;
  syntax: 'posix' | 'fish';
}

function detectShellRc(): ShellRc {
  const shell = process.env.SHELL ?? '';
  if (shell.includes('fish')) {
    return { file: path.join(linuxConfigHome(), 'fish', 'config.fish'), syntax: 'fish' };
  }
  if (shell.includes('zsh')) {
    return { file: path.join(process.env.ZDOTDIR || homeDir(), '.zshrc'), syntax: 'posix' };
  }
  if (shell.includes('bash')) {
    // macOS Terminal.app starts a login shell, which reads .bash_profile, not .bashrc.
    const file = platform() === 'darwin' ? path.join(homeDir(), '.bash_profile') : path.join(homeDir(), '.bashrc');
    return { file, syntax: 'posix' };
  }
  return { file: path.join(homeDir(), '.profile'), syntax: 'posix' };
}

function renderBlock(vars: EnvVarSet, syntax: ShellRc['syntax']): string {
  const lines = Object.entries(vars).map(([key, value]) => {
    const escaped = value.replace(syntax === 'fish' ? /[\\"$]/g : /[\\"$`]/g, (character) => `\\${character}`);
    return syntax === 'fish' ? `set -gx ${key} "${escaped}"` : `export ${key}="${escaped}"`;
  });
  return [RC_BLOCK_START, ...lines, RC_BLOCK_END].join('\n');
}

const blockOnlyRe = () => new RegExp(`${RC_BLOCK_START}[\\s\\S]*?${RC_BLOCK_END}`, 'm');

/** Reads back the KEY="value" (or fish `set -gx KEY "value"`) pairs from an already-matched block. */
function parseBlockVars(blockText: string, syntax: ShellRc['syntax']): EnvVarSet {
  const lineRe = syntax === 'fish' ? /^set -gx (\w+) "(.*)"$/ : /^export (\w+)="(.*)"$/;
  const result: EnvVarSet = {};
  for (const line of blockText.split('\n')) {
    const m = line.match(lineRe);
    if (m) result[m[1]!] = m[2]!.replace(syntax === 'fish' ? /\\([\\"$])/g : /\\([\\"$`])/g, '$1');
  }
  return result;
}

/**
 * Inserts or updates vars in the single shared marked block in the user's shell rc file,
 * merging with whatever other targets/providers already put there (e.g. Claude Code CLI and
 * OpenAI Codex CLI share one block with different keys) — leaving the rest of the file, and
 * any keys this call doesn't mention, untouched. Safe to call repeatedly (idempotent).
 */
export function upsertShellEnvVars(vars: EnvVarSet): { file: string; created: boolean } {
  const { file, syntax } = detectShellRc();
  const exists = fs.existsSync(file);
  const original = exists ? fs.readFileSync(file, 'utf8') : '';

  const blockRe = blockOnlyRe();
  const existingMatch = original.match(blockRe);
  const merged = { ...(existingMatch ? parseBlockVars(existingMatch[0], syntax) : {}), ...vars };

  if (isDryRun()) return { file, created: !exists };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (exists) backupFile(file);

  const block = renderBlock(merged, syntax);
  const next = blockRe.test(original)
    ? original.replace(blockRe, () => block)
    : `${original}${original.length > 0 ? (original.endsWith('\n') ? '\n' : '\n\n') : ''}${block}\n`;

  fs.writeFileSync(file, next, 'utf8');
  return { file, created: !exists };
}

/** Persists user-scoped env vars on native Windows via `setx`, picked up by newly opened terminals. */
export function setWindowsUserEnvVars(vars: EnvVarSet): void {
  if (isDryRun()) return;
  for (const [key, value] of Object.entries(vars)) {
    try {
      execFileSync(windowsSystemTool('setx'), [key, value], { stdio: 'ignore' });
    } catch {
      // setx missing or blocked — write the same HKCU\Environment value directly. Unlike setx this
      // doesn't broadcast the change, so it may only apply after re-login, but it still persists.
      execFileSync(windowsSystemTool('reg'), ['add', 'HKCU\\Environment', '/v', key, '/t', 'REG_SZ', '/d', value, '/f'], {
        stdio: 'ignore',
      });
    }
  }
}

/** True if the shared marker block currently defines this specific key — used to default-select targets for uninstall. */
export function hasShellEnvVar(key: string): boolean {
  return readShellEnvVar(key) !== undefined;
}

/** Read only our managed block; never evaluate shell expressions. */
export function readShellEnvVar(key: string): string | undefined {
  const { file, syntax } = detectShellRc();
  if (!fs.existsSync(file)) return undefined;
  const match = fs.readFileSync(file, 'utf8').match(blockOnlyRe());
  return match ? parseBlockVars(match[0], syntax)[key] : undefined;
}

/**
 * Strips only the given keys from the shared marker block, leaving any other provider's keys
 * (and the rest of the file) untouched. Removes the whole block only once it's left empty.
 * No-op if the block, or none of the given keys within it, are present.
 */
export function removeShellEnvVars(keys: string[]): { file: string; removed: boolean } {
  const { file, syntax } = detectShellRc();
  if (!fs.existsSync(file)) return { file, removed: false };

  const original = fs.readFileSync(file, 'utf8');
  const blockRe = blockOnlyRe();
  const match = original.match(blockRe);
  if (!match) return { file, removed: false };

  const existingVars = parseBlockVars(match[0], syntax);
  let removedAny = false;
  for (const key of keys) {
    if (key in existingVars) {
      delete existingVars[key];
      removedAny = true;
    }
  }
  if (!removedAny) return { file, removed: false };

  if (isDryRun()) return { file, removed: true };

  backupFile(file);

  const remainingKeys = Object.keys(existingVars);
  const next =
    remainingKeys.length > 0
      ? original.replace(blockRe, () => renderBlock(existingVars, syntax))
      : original.replace(new RegExp(`\\n?${RC_BLOCK_START}[\\s\\S]*?${RC_BLOCK_END}\\n?`, 'm'), '\n').replace(/\n{3,}/g, '\n\n');

  fs.writeFileSync(file, next, 'utf8');
  return { file, removed: true };
}

/** Checks whether a user-scoped env var is currently set on Windows (via the registry, not just the current process). */
export function hasWindowsUserEnvVar(key: string): boolean {
  return readWindowsUserEnvVar(key) !== undefined;
}

/** Parse reg query output without exposing credentials in command output or diagnostics. */
export function parseWindowsUserEnvVar(output: string, key: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\S+)\s+REG_(?:SZ|EXPAND_SZ)(?:[ \t]+(.*))?$/);
    if (match?.[1]?.toLowerCase() === key.toLowerCase()) return match[2] ?? '';
  }
  return undefined;
}

export function readWindowsUserEnvVar(key: string): string | undefined {
  try {
    const output = execFileSync(windowsSystemTool('reg'), ['query', 'HKCU\\Environment', '/v', key], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseWindowsUserEnvVar(output, key);
  } catch {
    return undefined;
  }
}

/** Deletes user-scoped env vars set via `setx` on Windows (setx itself has no "unset"). No-op if absent. */
export function removeWindowsUserEnvVars(keys: string[]): void {
  if (isDryRun()) return;
  for (const key of keys) {
    try {
      execFileSync(windowsSystemTool('reg'), ['delete', 'HKCU\\Environment', '/v', key, '/f'], { stdio: 'ignore' });
    } catch {
      // Already absent — nothing to clean up.
    }
  }
}
