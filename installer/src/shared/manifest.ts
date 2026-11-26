// Какой файл выпуска PurpleFlow скачивать. Источник — latest*.yml, которые electron-builder кладёт в каждый релиз:
// в них имена файлов и sha512, так что проверка целостности не зависит от отдельного файла сумм.

export const REPO = 'PurpleSchool/purpleflow';
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

export interface ManifestFile {
  url: string;
  sha512: string;
  size: number;
}

export interface Manifest {
  version: string;
  files: ManifestFile[];
}

export type AssetKind = 'mac-zip' | 'win-nsis' | 'appimage';

export interface Asset extends ManifestFile {
  kind: AssetKind;
  version: string;
}

export function manifestName(platform: string): string | null {
  if (platform === 'darwin') return 'latest-mac.yml';
  if (platform === 'win32') return 'latest.yml';
  if (platform === 'linux') return 'latest-linux.yml';
  return null;
}

export const manifestUrl = (name: string) => `https://github.com/${REPO}/releases/latest/download/${name}`;
/** Ссылка на конкретную версию, а не на latest: файл не сменится, если выпуск опубликуют посреди скачивания. */
export const assetUrl = (a: Asset) => `https://github.com/${REPO}/releases/download/${a.version}/${encodeURIComponent(a.url)}`;

const unquote = (s: string) => s.trim().replace(/^['"]|['"]$/g, '');

/** Формат electron-builder узкий и стабильный: полноценный YAML-парсер ради него не нужен. */
export function parseManifest(text: string): Manifest {
  const version = /^version:\s*(.+)$/m.exec(text)?.[1];
  if (!version) throw new Error('В описании выпуска нет версии');
  const files: ManifestFile[] = [];
  let cur: ManifestFile | null = null;
  for (const line of text.split(/\r?\n/)) {
    const item = /^\s+-\s+url:\s*(.+)$/.exec(line);
    if (item) {
      cur = { url: unquote(item[1]), sha512: '', size: 0 };
      files.push(cur);
      continue;
    }
    if (!/^\s/.test(line)) cur = null;
    if (!cur) continue;
    const field = /^\s+(sha512|size):\s*(.+)$/.exec(line);
    if (field?.[1] === 'sha512') cur.sha512 = unquote(field[2]);
    if (field?.[1] === 'size') cur.size = Number(unquote(field[2])) || 0;
  }
  return { version: unquote(version), files: files.filter((f) => f.sha512) };
}

export function pickAsset(m: Manifest, platform: string, arch: string): Asset | null {
  const find = (kind: AssetKind, test: (url: string) => boolean): Asset | null => {
    const f = m.files.find((x) => test(x.url));
    return f ? { ...f, kind, version: m.version } : null;
  };
  if (platform === 'darwin') {
    return arch === 'arm64'
      ? find('mac-zip', (u) => u.endsWith('-arm64-mac.zip'))
      : find('mac-zip', (u) => u.endsWith('-mac.zip') && !u.includes('arm64'));
  }
  if (platform === 'win32') {
    if (arch !== 'x64' && arch !== 'arm64') return null;
    return find('win-nsis', (u) => u.endsWith(`-${arch}.exe`));
  }
  if (platform === 'linux') {
    const tag = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'arm64' : null;
    return tag ? find('appimage', (u) => u.endsWith(`${tag}.AppImage`)) : null;
  }
  return null;
}

/**
 * Ключ установки PurpleFlow в реестре Windows. Установщик NSIS от electron-builder пишет туда InstallLocation —
 * настоящую папку, которая может отличаться от стандартной (выбрали при установке, «для всех пользователей»,
 * перенесённая папка программ). GUID — UUID v5 от appId ru.purpleschool.purpleflow, как его считает electron-builder;
 * тест сверяет это при каждом прогоне.
 */
export const PURPLEFLOW_WIN_GUID = 'a211f1fe-28a4-5d3d-9110-7a8aa8fd497e';

/** Значение из вывода `reg query … /v <name>`: «    InstallLocation    REG_SZ    C:\…». */
export function parseRegValue(output: string, name: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/.exec(line);
    if (m && m[1]!.toLowerCase() === name.toLowerCase()) return m[2];
  }
  return undefined;
}

/** Как запущен установщик на Linux: от этого зависит, какой файл обновления ему подходит. */
export type LinuxPackage = 'appimage' | 'deb' | 'rpm';

/** Имя файла установщика в релизе — то же, что в ссылках README. null — для этой системы сборки нет. */
export function installerAssetName(platform: string, arch: string, linux: LinuxPackage = 'appimage'): string | null {
  if (platform === 'darwin') return 'PurpleFlow-Installer.dmg';
  if (platform === 'win32') return arch === 'x64' || arch === 'arm64' ? `PurpleFlow-Installer-${arch}.exe` : null;
  if (platform === 'linux' && arch === 'x64') {
    return linux === 'deb'
      ? 'PurpleFlow-Installer-amd64.deb'
      : linux === 'rpm'
        ? 'PurpleFlow-Installer-x86_64.rpm'
        : 'PurpleFlow-Installer-x86_64.AppImage';
  }
  return null;
}

/** a новее b: сравнение X.Y.Z по числам; суффикс вроде -beta.1 считается старше релиза той же версии. */
export function isNewerVersion(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [core = '', pre] = v.trim().replace(/^v/, '').split('-', 2);
    return { nums: core.split('.').map((n) => Number(n) || 0), pre: pre ?? '' };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d > 0;
  }
  if (!x.pre !== !y.pre) return !x.pre;
  return x.pre > y.pre;
}
