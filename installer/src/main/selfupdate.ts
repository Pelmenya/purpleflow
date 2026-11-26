// Обновление самого установщика: при запуске смотрим последний релиз на GitHub, и если там версия новее —
// окно предлагает «Обновить». Файл качается в «Загрузки», сверяется по sha256 из GitHub и открывается: на Windows
// и в AppImage новая версия запускается сама, dmg, deb и rpm открываются в системной программе установки.
// electron-updater не подходит: он не обновляет portable-exe, а его latest*.yml спорили бы с файлами PurpleFlow.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app, net, shell } from 'electron';
import { REPO, installerAssetName, isNewerVersion, type LinuxPackage } from '../shared/manifest';
import type { InstallerUpdate, UpdateResult } from '../shared/types';
import { fetchOk } from './purpleflow';

const API_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

/** Только для разработки: притвориться старой версией, чтобы увидеть предложение обновиться. */
const currentVersion = () => (!app.isPackaged && process.env.PURPLEFLOW_INSTALLER_PRETEND_VERSION) || app.getVersion();

function linuxPackage(): LinuxPackage {
  if (process.env.APPIMAGE) return 'appimage';
  return fs.existsSync('/usr/bin/dpkg') ? 'deb' : 'rpm';
}

interface ReleaseView {
  tag_name?: string;
  html_url?: string;
  assets?: { name: string; size: number; digest?: string | null; browser_download_url: string }[];
}

let found: InstallerUpdate | null = null;

/** Есть ли версия новее. Сеть, лимит GitHub API, нет файла под эту систему — молча «нет»: это не повод мешать. */
export async function checkInstallerUpdate(): Promise<InstallerUpdate | null> {
  try {
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'PurpleFlow-Installer' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const release = (await res.json()) as ReleaseView;
    const version = release.tag_name?.replace(/^v/, '');
    if (!version || !isNewerVersion(version, currentVersion())) return null;
    const name = installerAssetName(process.platform, process.arch, process.platform === 'linux' ? linuxPackage() : undefined);
    const asset = release.assets?.find((a) => a.name === name);
    const sha256 = asset?.digest?.startsWith('sha256:') ? asset.digest.slice('sha256:'.length) : '';
    // Без контрольной суммы не предлагаем: скачанное нечем проверить.
    if (!asset || !sha256) return null;
    found = { version, file: asset.name, url: asset.browser_download_url, sha256, size: asset.size, page: release.html_url ?? '' };
    return found;
  } catch {
    return null;
  }
}

/** Скачать в «Загрузки», сверить sha256 и открыть. Адрес берём из найденного обновления, а не из окна. */
export async function applyInstallerUpdate(onProgress: (p: number) => void): Promise<UpdateResult> {
  const u = found;
  if (!u) return { ok: false, error: 'Обновление не найдено — перезапустите установщик.' };
  const dest = path.join(app.getPath('downloads'), u.file);
  const part = `${dest}.part`;
  try {
    const res = await fetchOk(u.url, DOWNLOAD_TIMEOUT_MS, 'новую версию установщика');
    const total = Number(res.headers.get('content-length')) || u.size;
    const hash = createHash('sha256');
    const out = fs.createWriteStream(part);
    const reader = res.body!.getReader();
    let got = 0;
    let last = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
        got += value.length;
        if (total && got - last > total / 200) {
          last = got;
          onProgress(Math.min(1, got / total));
        }
      }
    } finally {
      await new Promise<void>((r) => out.end(r));
    }
    if (hash.digest('hex') !== u.sha256) throw new Error('Контрольная сумма не совпала: файл повреждён или подменён. Попробуйте ещё раз.');
    fs.rmSync(dest, { force: true });
    fs.renameSync(part, dest);
  } catch (e) {
    fs.rmSync(part, { force: true });
    return { ok: false, error: (e as Error).message };
  }

  // Новая версия запускается сама там, где это просто файл программы; пакеты открывает система.
  if (process.platform === 'win32' || u.file.endsWith('.AppImage')) {
    try {
      if (u.file.endsWith('.AppImage')) fs.chmodSync(dest, 0o755);
      spawn(dest, [], { detached: true, stdio: 'ignore', cwd: path.dirname(dest) }).unref();
      setTimeout(() => app.quit(), 800);
      return { ok: true, relaunched: true, path: dest };
    } catch (e) {
      return { ok: false, error: `Скачано в ${dest}, но не запустилось: ${(e as Error).message}` };
    }
  }
  const err = await shell.openPath(dest);
  return err ? { ok: false, error: `Скачано в ${dest}, но не открылось: ${err}` } : { ok: true, relaunched: false, path: dest };
}

export const updatePage = () => found?.page ?? `https://github.com/${REPO}/releases/latest`;
