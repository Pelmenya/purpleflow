import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export type Platform = 'darwin' | 'win32' | 'linux';

export function platform(): Platform {
  const p = process.platform;
  if (p === 'darwin' || p === 'win32' || p === 'linux') return p;
  // Best-effort fallback for other POSIX-likes (e.g. other BSDs).
  return 'linux';
}

export function homeDir(): string {
  return os.homedir();
}

export function appDataDir(): string {
  return process.env.APPDATA ?? path.join(homeDir(), 'AppData', 'Roaming');
}

/** Respects $XDG_CONFIG_HOME (set on some distros/hardened setups) instead of assuming ~/.config. */
export function linuxConfigHome(): string {
  return process.env.XDG_CONFIG_HOME || path.join(homeDir(), '.config');
}

/**
 * XDG config dir for tools that follow the spec on macOS too (unlike the Electron apps above,
 * which use ~/Library/Application Support there) — e.g. opencode keeps its config in
 * ~/.config/opencode on both macOS and Linux.
 */
export function xdgConfigHome(): string {
  return linuxConfigHome();
}

/** opencode.json: %APPDATA%\opencode on Windows, $XDG_CONFIG_HOME/opencode (по умолчанию ~/.config/opencode) на macOS/Linux. */
/**
 * Глобальный конфиг OpenCode. OpenCode ищет его по XDG на всех платформах, включая Windows:
 * `~/.config/opencode/` (или `$XDG_CONFIG_HOME/opencode/`), а не `%APPDATA%` — до 0.7.0 мастер
 * писал в `%APPDATA%\opencode\`, и на Windows OpenCode настройку просто не видел (сообщил
 * пользователь 24.09.2026). Имя файла — `opencode.jsonc` или `opencode.json`: берём тот, что уже
 * есть, иначе создаём `opencode.json`.
 */
export function openCodeConfigPath(): string {
  const dir = path.join(xdgConfigHome(), 'opencode');
  for (const name of ['opencode.jsonc', 'opencode.json']) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, 'opencode.json');
}

/** Где мастер до 0.7.0 ошибочно создавал конфиг OpenCode на Windows — чтобы подчистить за собой. */
export function legacyOpenCodeConfigPaths(): string[] {
  if (platform() !== 'win32') return [];
  const dir = path.join(appDataDir(), 'opencode');
  return [path.join(dir, 'opencode.json'), path.join(dir, 'opencode.jsonc')];
}

/** Pi хранит переопределения провайдеров/моделей в ~/.pi/agent/models.json на всех платформах. */
export function piModelsPath(): string {
  return path.join(homeDir(), '.pi', 'agent', 'models.json');
}

/**
 * VS Code, Cursor and Windsurf are all Electron apps that store user settings
 * under the same relative layout, keyed only by their app folder name. This is the
 * native (.deb/.rpm/tarball on Linux) path — see resolveVsCodeFamilySettingsPath()
 * for Flatpak/Snap-aware resolution.
 *
 * `linuxFolderName` exists because Linux filesystems are case-sensitive and not every
 * app uses the same casing there as on macOS/Windows: Windsurf ships as lowercase
 * `~/.config/windsurf` on Linux while its macOS/Windows folder is `Windsurf` — VS Code
 * and Cursor use the same casing everywhere, so they can omit this param.
 */
export function vsCodeFamilySettingsPath(appFolderName: string, linuxFolderName: string = appFolderName): string {
  const home = homeDir();
  switch (platform()) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', appFolderName, 'User', 'settings.json');
    case 'win32':
      return path.join(appDataDir(), appFolderName, 'User', 'settings.json');
    case 'linux':
      return path.join(linuxConfigHome(), linuxFolderName, 'User', 'settings.json');
  }
}

/** Resolve settings for the standard native editor profile. Sandboxed launchers are checked separately. */
export function resolveVsCodeFamilySettingsPath(appFolderName: string, linuxFolderName: string = appFolderName): string {
  return vsCodeFamilySettingsPath(appFolderName, linuxFolderName);
}

export function neovimConfigDir(): string {
  if (platform() === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(homeDir(), 'AppData', 'Local');
    return path.join(localAppData, 'nvim');
  }
  if (platform() === 'linux') {
    return path.join(linuxConfigHome(), 'nvim');
  }
  return path.join(homeDir(), '.config', 'nvim');
}

/**
 * True only when a real, non-root user got elevated via sudo (uid 0 + $SUDO_USER set) —
 * in that case $HOME points at /root, silently missing that user's actual config files.
 * Genuine root logins (no $SUDO_USER, e.g. root-only containers) are left alone since
 * /root legitimately *is* the home directory there.
 */
export function isSudoElevated(): boolean {
  if (typeof process.getuid !== 'function') return false; // Windows
  return process.getuid() === 0 && Boolean(process.env.SUDO_USER);
}

/**
 * Absolute path to a built-in Windows tool (setx, reg, where, clip) in System32. Resolving these
 * via PATH fails with ENOENT on machines whose PATH lost %SystemRoot%\\System32 — a common
 * result of an earlier `setx PATH` truncating it. Falls back to the bare name if not found there.
 */
export function windowsSystemTool(name: string): string {
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  const full = path.join(systemRoot, 'System32', `${name}.exe`);
  return fs.existsSync(full) ? full : name;
}

export function commandExists(command: string): boolean {
  if (platform() === 'win32') {
    try {
      execFileSync(windowsSystemTool('where'), [command], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  try {
    // `command -v` is a POSIX shell builtin, unlike `which` it needs no external binary —
    // matters on minimal/slim Linux images that don't ship a standalone `which`.
    execFileSync('sh', ['-c', 'command -v -- "$1"', 'sh', command], { stdio: 'ignore', cwd: homeDir() });
    return true;
  } catch {
    return false;
  }
}

/** Глобальный crushrc: ~/.config/crush/crushrc (с учётом XDG_CONFIG_HOME), на Windows — %USERPROFILE%\.config\crush\crushrc. */
export function crushrcPath(): string {
  return path.join(linuxConfigHome(), 'crush', 'crushrc');
}

const JETBRAINS_IDE =
  /^(IntelliJIdea|IdeaIC|PyCharm|WebStorm|GoLand|PhpStorm|Rider|CLion|RubyMine|DataGrip|RustRover|Aqua|DataSpell|AndroidStudio)/;

/**
 * Есть ли IDE JetBrains: по папке её настроек (так их видит и Toolbox). Плагин Claude Code в IDE запускает тот же
 * claude, поэтому отдельной настройки ему не нужно — достаточно знать, показывать ли строку.
 */
export function jetbrainsInstalled(): boolean {
  const support = path.join(homeDir(), 'Library', 'Application Support');
  const roots =
    platform() === 'darwin'
      ? [path.join(support, 'JetBrains'), path.join(support, 'Google')]
      : platform() === 'win32'
        ? [path.join(appDataDir(), 'JetBrains'), path.join(appDataDir(), 'Google')]
        : [path.join(linuxConfigHome(), 'JetBrains'), path.join(linuxConfigHome(), 'Google')];
  return roots.some((dir) => {
    try {
      return fs.readdirSync(dir).some((name) => JETBRAINS_IDE.test(name));
    } catch {
      return false;
    }
  });
}
