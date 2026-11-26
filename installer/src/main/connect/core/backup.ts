import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { homeDir } from './os.js';
import { BACKUP_DIR_NAME } from '../constants.js';
import { isDryRun } from './runtime.js';

function backupDir(): string {
  const dir = path.join(homeDir(), BACKUP_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Copies filePath into ~/.purpleschool-ai-backups before it gets modified. No-op if the file doesn't exist yet. */
export function backupFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  if (isDryRun()) return null;
  const dir = backupDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `${path.basename(filePath)}.${stamp}.${randomUUID()}.bak`);
  fs.copyFileSync(filePath, dest);
  return dest;
}
