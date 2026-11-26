import fs from 'node:fs';
import path from 'node:path';
import { parse, modify, applyEdits, type ParseError } from 'jsonc-parser';
import { backupFile } from './backup.js';
import { isDryRun } from './runtime.js';

/** Parses a JSONC configuration object. Missing files return undefined; invalid files stop setup. */
export function readJsonc<T = unknown>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  const text = fs.readFileSync(filePath, 'utf8');
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`Не удалось прочитать ${filePath}: некорректный JSON. Исправь файл перед настройкой.`);
  return value as T;
}

/**
 * Sets a single top-level-or-nested key in a JSONC file, preserving comments/formatting
 * of everything else via jsonc-parser's edit engine. Backs up the file first if it exists.
 */
export function writeJsoncField(filePath: string, jsonPath: (string | number)[], value: unknown): void {
  const dir = path.dirname(filePath);
  const exists = fs.existsSync(filePath);
  const original = exists ? fs.readFileSync(filePath, 'utf8') : '{}';
  if (exists) readJsonc(filePath);

  if (isDryRun()) return;

  fs.mkdirSync(dir, { recursive: true });
  if (exists) backupFile(filePath);

  const edits = modify(original, jsonPath, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
  });
  const next = applyEdits(original, edits);
  fs.writeFileSync(filePath, next, 'utf8');
}

/** Deletes a single key from a JSONC file, leaving everything else untouched. No-op if the file/key is absent. */
export function removeJsoncField(filePath: string, jsonPath: (string | number)[]): void {
  if (!fs.existsSync(filePath)) return;
  const original = fs.readFileSync(filePath, 'utf8');
  readJsonc(filePath);

  if (isDryRun()) return;

  backupFile(filePath);
  const edits = modify(original, jsonPath, undefined, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
  });
  const next = applyEdits(original, edits);
  fs.writeFileSync(filePath, next, 'utf8');
}
