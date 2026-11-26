import fs from 'node:fs';
import path from 'node:path';
import * as TOML from 'smol-toml';
import { backupFile } from './backup.js';
import { isDryRun } from './runtime.js';

type TomlObject = Record<string, unknown>;

/** Parses a TOML file. Returns undefined if missing; throws if present but unparsable (caller decides how to surface that). */
export function readToml<T = TomlObject>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return TOML.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function setDeep(obj: TomlObject, keyPath: string[], value: unknown): void {
  let cur = obj;
  for (const key of keyPath.slice(0, -1)) {
    const next = cur[key];
    cur[key] = typeof next === 'object' && next !== null && !Array.isArray(next) ? next : {};
    cur = cur[key] as TomlObject;
  }
  cur[keyPath[keyPath.length - 1]!] = value;
}

function deleteDeep(obj: TomlObject, keyPath: string[]): boolean {
  let cur = obj;
  for (const key of keyPath.slice(0, -1)) {
    const next = cur[key];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) return false;
    cur = next as TomlObject;
  }
  const lastKey = keyPath[keyPath.length - 1]!;
  if (!(lastKey in cur)) return false;
  delete cur[lastKey];
  return true;
}

function parseOrThrow(filePath: string): TomlObject {
  try {
    return TOML.parse(fs.readFileSync(filePath, 'utf8')) as TomlObject;
  } catch (err) {
    throw new Error(
      `Не получилось разобрать ${filePath} как TOML — файл повреждён или содержит синтаксис, который наш парсер не поддерживает. Поправь вручную и повтори. (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
}

/**
 * Sets a nested key in a TOML file, parsing the whole document, editing the object, and
 * re-serializing it. Unlike writeJsoncField (jsonc-parser has a comment-preserving edit API),
 * smol-toml has no CST editor — so this rewrite drops any comments/formatting in the file.
 * Acceptable trade-off here: config.toml is short, mostly tool-generated, and we always back
 * up the original first via backupFile().
 */
export function writeTomlField(filePath: string, keyPath: string[], value: unknown): void {
  const dir = path.dirname(filePath);
  const exists = fs.existsSync(filePath);
  const data = exists ? parseOrThrow(filePath) : {};

  setDeep(data, keyPath, value);

  if (isDryRun()) return;

  fs.mkdirSync(dir, { recursive: true });
  if (exists) backupFile(filePath);
  fs.writeFileSync(filePath, TOML.stringify(data), 'utf8');
}

/** Deletes a single nested key from a TOML file, leaving everything else untouched. No-op if the file/key is absent. */
export function removeTomlField(filePath: string, keyPath: string[]): void {
  if (!fs.existsSync(filePath)) return;
  const data = parseOrThrow(filePath);

  if (!deleteDeep(data, keyPath)) return;

  if (isDryRun()) return;

  backupFile(filePath);
  fs.writeFileSync(filePath, TOML.stringify(data), 'utf8');
}
