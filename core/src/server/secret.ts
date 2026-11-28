import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';

const N = 32_768;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const MAXMEM = 64 * 1024 * 1024;
const STORED_PATTERN = /^scrypt\$32768\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/;

export function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(secret, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifySecret(candidate: string, stored: string): boolean {
  const match = STORED_PATTERN.exec(stored);
  if (!match) return false;
  const salt = Buffer.from(match[1]!, 'base64url');
  const expected = Buffer.from(match[2]!, 'base64url');
  const actual = scryptSync(candidate, salt, expected.length, { N, r: R, p: P, maxmem: MAXMEM });
  return timingSafeEqual(actual, expected);
}

export function readLoginSecret(file: string): string {
  if ((fs.statSync(file).mode & 0o077) !== 0) {
    throw new Error(`Файл секрета ${file} доступен группе или остальным пользователям`);
  }
  const stored = fs.readFileSync(file, 'utf8').trim();
  if (!stored.startsWith('scrypt$')) {
    throw new Error(
      `Файл секрета содержит открытый текст. Переместите его (\`mv ${file} ${file}.old\`), создайте новый командой \`node core/dist/server/main.js hash-secret ${file}\`, удалите старый (\`rm -- ${file}.old\`) и перезапустите службу`,
    );
  }
  if (!STORED_PATTERN.test(stored)) throw new Error(`Файл секрета ${file} содержит некорректный хеш scrypt`);
  return stored;
}

export function createLoginSecret(file: string): string {
  const secret = randomBytes(32).toString('base64url');
  fs.writeFileSync(file, hashSecret(secret), { mode: 0o600, flag: 'wx' });
  return secret;
}
