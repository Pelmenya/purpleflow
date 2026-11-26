import fs from 'node:fs';
import path from 'node:path';
import { ensureAssistantCli, resolveExecutable, runCommand } from './applications.js';
import { homeDir, platform, vsCodeFamilySettingsPath } from './os.js';

export interface Editor {
  id: string;
  title: string;
  folder: string;
  linuxFolder: string;
  command: string;
  macApp: string;
  windowsFolder: string;
}

export interface EditorProduct {
  applicationName?: string;
  nameShort?: string;
  nameLong?: string;
  portable?: string;
  target?: string;
}

export interface EditorInstallation {
  id: string;
  kind: 'native' | 'snap' | 'flatpak';
  command: string;
  args: string[];
  settingsPath: string;
  product?: EditorProduct;
  productDiagnostics?: string[];
  /** A detected installation whose environment/metadata could not be inspected. */
  inspectionError?: string;
}

export const editors: Editor[] = [
  {
    id: 'vscode',
    title: 'VS Code',
    folder: 'Code',
    linuxFolder: 'Code',
    command: 'code',
    macApp: 'Visual Studio Code',
    windowsFolder: 'Microsoft VS Code',
  },
  { id: 'cursor', title: 'Cursor', folder: 'Cursor', linuxFolder: 'Cursor', command: 'cursor', macApp: 'Cursor', windowsFolder: 'cursor' },
  {
    id: 'windsurf',
    title: 'Windsurf',
    folder: 'Windsurf',
    linuxFolder: 'windsurf',
    command: 'windsurf',
    macApp: 'Windsurf',
    windowsFolder: 'Windsurf',
  },
];

function readProduct(files: string[], diagnostics: string[] = []): EditorProduct | undefined {
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      diagnostics.push(
        `${file}: ${code === 'ENOENT' || code === 'ENOTDIR' ? 'файл не найден' : `не удалось прочитать (${code ?? 'ошибка доступа'})`}`,
      );
      continue;
    }
    let product: unknown;
    try {
      product = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
      diagnostics.push(`${file}: некорректный JSON`);
      continue;
    }
    if (
      !product ||
      typeof product !== 'object' ||
      Array.isArray(product) ||
      typeof (product as EditorProduct).applicationName !== 'string' ||
      !(product as EditorProduct).applicationName
    ) {
      diagnostics.push(`${file}: отсутствует строковое поле applicationName`);
      continue;
    }
    return product as EditorProduct;
  }
  return undefined;
}

/** Discovery reads metadata only; the selected installation is resolved again with its --version output. */
export function readEditorProduct(command: string, versionOutput?: string, diagnostics: string[] = []): EditorProduct | undefined {
  const real = fs.realpathSync(command);
  const directory = path.dirname(real);
  const windowsLauncher = /\.(?:cmd|bat|exe)$/i.test(real);
  if (windowsLauncher && versionOutput !== undefined) {
    const commit = versionOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^[0-9a-f]{40}$/i.test(line));
    if (commit) {
      const root = path.basename(directory).toLowerCase() === 'bin' ? path.dirname(directory) : directory;
      const activeDirectory = path.join(root, commit.slice(0, 10).toLowerCase());
      const activeFile = path.join(activeDirectory, 'resources', 'app', 'product.json');
      // Existing active resources must never be replaced with stale metadata after an update.
      if (fs.existsSync(activeDirectory)) return readProduct([activeFile], diagnostics);
      diagnostics.push(`${activeFile}: файл не найден (проверяется также прежняя структура установки)`);
    } else {
      diagnostics.push(
        'Ответ --version не содержит хеш сборки из 40 шестнадцатеричных символов; каталог активной сборки определить нельзя.',
      );
    }
  }
  return readProduct(
    [
      ...new Set([
        path.resolve(directory, '../resources/app/product.json'),
        path.resolve(directory, '../product.json'),
        path.join(directory, 'resources/app/product.json'),
        ...(!windowsLauncher && platform() === 'linux' ? [path.join('/usr/share', path.basename(real), 'resources/app/product.json')] : []),
      ]),
    ],
    diagnostics,
  );
}

export function assertEditorProduct(
  editor: Editor,
  product: EditorProduct | undefined,
  context?: { command: string; diagnostics: string[] },
): void {
  if (!product?.applicationName) {
    const detail = context ? `\nКоманда редактора: ${context.command}\nПроверка метаданных:\n${context.diagnostics.join('\n')}` : '';
    throw new Error(
      `Не удалось определить продукт по метаданным ${editor.title}. Проверь установку редактора; настройки не изменены.${detail}`,
    );
  }
  if (product.applicationName !== editor.command) {
    throw new Error(
      `Вместо ${editor.title} найден ${product.nameLong ?? product.nameShort ?? product.applicationName}. Выбери правильную установку редактора; настройки не изменены.`,
    );
  }
}

/** Resolve portable storage from a known launcher layout, following VS Code's bootstrap rules. */
export function nativeEditorSettingsPath(editor: Editor, command: string, product?: EditorProduct): string {
  const directory = path.dirname(fs.realpathSync(command));
  const macLauncher = directory.endsWith(path.join('Contents', 'Resources', 'app', 'bin'));
  const root = macLauncher
    ? path.resolve(directory, '../../../..')
    : path.basename(directory).toLowerCase() === 'bin'
      ? path.dirname(directory)
      : directory;
  const override = process.env.VSCODE_PORTABLE;
  if (override && !path.isAbsolute(override)) throw new Error('VSCODE_PORTABLE должен содержать абсолютный путь. Настройки не изменены.');
  const portable =
    override ||
    (macLauncher ? path.join(path.dirname(root), product?.portable || `${editor.command}-portable-data`) : path.join(root, 'data'));
  const standard = vsCodeFamilySettingsPath(editor.folder, editor.linuxFolder);
  // Windows User/System installers explicitly disable portable mode in product metadata.
  if (product && Object.hasOwn(product, 'target')) return standard;
  if (!fs.existsSync(portable)) {
    if (override) throw new Error(`Каталог VSCODE_PORTABLE не найден: ${portable}. Проверь профиль редактора; настройки не изменены.`);
    return standard;
  }
  if (editor.id !== 'vscode')
    throw new Error(
      `Обнаружен portable-профиль ${editor.title}: ${portable}. Его расположение требует ручной проверки; настройки не изменены.`,
    );
  if (!fs.statSync(portable).isDirectory()) throw new Error(`Portable-путь не является каталогом: ${portable}. Настройки не изменены.`);
  if (!macLauncher && path.basename(directory).toLowerCase() !== 'bin' && !/\.(?:exe|cmd|bat)$/i.test(command)) {
    throw new Error(`Не удалось подтвердить расположение portable-установки ${editor.title}. Настройки не изменены.`);
  }
  return path.join(portable, 'user-data', 'User', 'settings.json');
}

function nativeCandidates(editor: Editor): string[] {
  const fromPath = resolveExecutable(editor.command);
  // PATH selects the native installation. Inspect other standard paths only if it is absent/a sandbox launcher.
  if (fromPath && !isSnapLauncher(fromPath) && readEditorProduct(fromPath)?.applicationName === editor.command) return [fromPath];
  const candidates: string[] = fromPath && !isSnapLauncher(fromPath) ? [fromPath] : [];
  if (platform() === 'darwin') {
    for (const base of ['/Applications', path.join(homeDir(), 'Applications')]) {
      candidates.push(path.join(base, `${editor.macApp}.app`, 'Contents', 'Resources', 'app', 'bin', editor.command));
    }
  } else if (platform() === 'win32') {
    for (const base of [
      path.join(process.env.LOCALAPPDATA ?? path.join(homeDir(), 'AppData', 'Local'), 'Programs'),
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
    ]) {
      if (base) candidates.push(path.join(base, editor.windowsFolder, 'bin', `${editor.command}.cmd`));
    }
  } else {
    candidates.push(`/usr/share/${editor.command}/bin/${editor.command}`, `/opt/${editor.command}/bin/${editor.command}`);
  }
  return candidates.filter((file) => fs.existsSync(file) && !isSnapLauncher(file));
}

function isSnapLauncher(file: string): boolean {
  const real = fs.realpathSync(file);
  return file.startsWith('/snap/') || real.startsWith('/snap/') || path.basename(real) === 'snap';
}

const ENV_PROBE =
  'printf "PURPLESCHOOL_HOME=%s\\nPURPLESCHOOL_CONFIG=%s\\nPURPLESCHOOL_SNAP=%s\\n" "$HOME" "${XDG_CONFIG_HOME:-$HOME/.config}" "$SNAP"';

function sandboxEnvironment(command: string, args: string[], input?: string): { home: string; config: string; snap: string } {
  const output = runCommand(command, args, 15000, input);
  const values = Object.fromEntries(
    output
      .split(/\r?\n/)
      .filter((line) => line.startsWith('PURPLESCHOOL_'))
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  const home = values.PURPLESCHOOL_HOME;
  const config = values.PURPLESCHOOL_CONFIG;
  if (!home || !config || !path.isAbsolute(home) || !path.isAbsolute(config))
    throw new Error('Не удалось прочитать пути из окружения редактора.');
  // Shared Claude/Codex state must be in the same home used by the wizard.
  if (path.resolve(home) !== path.resolve(homeDir()))
    throw new Error('Домашний каталог sandbox отличается от каталога мастера. Требуется настройка внутри этого окружения.');
  return { home, config, snap: values.PURPLESCHOOL_SNAP ?? '' };
}

function snapInstallation(editor: Editor): EditorInstallation | undefined {
  if (editor.id !== 'vscode') return undefined;
  const manager = resolveExecutable('snap');
  if (!manager) return undefined;
  try {
    runCommand(manager, ['list', 'code']);
  } catch {
    return undefined;
  }
  const installation: EditorInstallation = {
    id: 'snap',
    kind: 'snap',
    command: manager,
    args: ['run', 'code'],
    settingsPath: '',
    productDiagnostics: [],
  };
  try {
    const env = sandboxEnvironment(manager, ['run', '--shell', 'code'], `${ENV_PROBE}\n`);
    if (!path.isAbsolute(env.snap)) throw new Error('Не удалось определить каталог установленного Snap.');
    installation.settingsPath = path.join(env.config, editor.linuxFolder, 'User', 'settings.json');
    installation.product = readProduct(
      [path.join(env.snap, 'usr/share/code/resources/app/product.json'), path.join(env.snap, 'resources/app/product.json')],
      installation.productDiagnostics,
    );
  } catch (error) {
    installation.inspectionError = error instanceof Error ? error.message : String(error);
  }
  return installation;
}

function flatpakInstallations(editor: Editor): EditorInstallation[] {
  if (editor.id !== 'vscode') return [];
  const manager = resolveExecutable('flatpak');
  if (!manager) return [];
  const installations: EditorInstallation[] = [];
  // User and system installations may coexist; query them explicitly rather than relying on manager precedence.
  for (const scope of ['--user', '--system']) {
    let location: string;
    try {
      location = runCommand(manager, ['info', scope, '--show-location', 'com.visualstudio.code']);
    } catch {
      continue;
    }
    const installation: EditorInstallation = {
      id: `flatpak${scope}`,
      kind: 'flatpak',
      command: manager,
      args: ['run', scope, 'com.visualstudio.code'],
      settingsPath: '',
      productDiagnostics: [],
    };
    try {
      const env = sandboxEnvironment(manager, ['run', scope, '--command=sh', 'com.visualstudio.code', '-c', ENV_PROBE]);
      installation.settingsPath = path.join(env.config, editor.linuxFolder, 'User', 'settings.json');
      installation.product = readProduct(
        [
          path.join(location, 'files/extra/vscode/resources/app/product.json'),
          path.join(location, 'files/share/code/resources/app/product.json'),
        ],
        installation.productDiagnostics,
      );
    } catch (error) {
      installation.inspectionError = error instanceof Error ? error.message : String(error);
    }
    installations.push(installation);
  }
  return installations;
}

export function findEditorInstallations(editor: Editor): EditorInstallation[] {
  const seen = new Set<string>();
  const installations: EditorInstallation[] = [];
  for (const command of nativeCandidates(editor)) {
    const real = fs.realpathSync(command);
    if (seen.has(real)) continue;
    seen.add(real);
    const installation: EditorInstallation = {
      id: `native:${real}`,
      kind: 'native',
      command,
      args: [],
      settingsPath: '',
      product: readEditorProduct(command),
    };
    try {
      installation.settingsPath = nativeEditorSettingsPath(editor, command, installation.product);
    } catch (error) {
      installation.inspectionError = error instanceof Error ? error.message : String(error);
    }
    installations.push(installation);
  }
  if (platform() === 'linux') {
    const snap = snapInstallation(editor);
    if (snap) installations.push(snap);
    installations.push(...flatpakInstallations(editor));
  }
  return installations;
}

export function findEditorCommand(editor: Editor): string | undefined {
  return findEditorInstallations(editor)[0]?.command;
}

export function extensionInstalled(output: string, extensionId: string): boolean {
  return output.split(/\r?\n/).some((line) => line.trim().split('@')[0]?.toLowerCase() === extensionId.toLowerCase());
}

export async function ensureEditor(editor: Editor, family: 'anthropic' | 'openai', dryRun: boolean): Promise<EditorInstallation> {
  const installations = findEditorInstallations(editor);
  if (installations.length === 0)
    throw new Error(`${editor.title} не найден. Установи редактор, затем запусти мастер снова. Редакторы мастер не устанавливает.`);
  // Несколько установок (обычная, Snap, Flatpak) — настраиваем первую, которую удалось прочитать.
  const selected = installations.find((item) => !item.inspectionError) ?? installations[0]!;
  if (selected.kind !== 'native' && selected.inspectionError) throw new Error(selected.inspectionError);
  let version: string;
  try {
    version = runCommand(selected.command, [...selected.args, '--version']);
    if (!version) throw new Error('Команда вернула пустой ответ.');
  } catch (error) {
    throw new Error(
      `Не удалось проверить версию ${editor.title}. Команда: ${selected.command} --version. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (selected.kind === 'native') {
    selected.productDiagnostics = [];
    selected.product = readEditorProduct(selected.command, version, selected.productDiagnostics);
  }
  if (selected.kind === 'native' && !selected.product?.applicationName) {
    // product.json мог переехать в новой сборке редактора (14.11.2026, VS Code 1.146: `26cf77ad` —
    // «ошибка по всем пунктам», хотя редактор установлен). Чужой продукт мы по-прежнему отсекаем,
    // если метаданные прочитаны; если не прочитаны — решает пользователь, а установку расширения
    // ниже всё равно проверяет сам редактор (--list-extensions).
    // Решать некому: расширение ниже всё равно проверяет сам редактор (--list-extensions).
  } else {
    assertEditorProduct(editor, selected.product, { command: selected.command, diagnostics: selected.productDiagnostics ?? [] });
  }
  if (selected.kind === 'native') selected.settingsPath = nativeEditorSettingsPath(editor, selected.command, selected.product);
  try {
    const extensions = runCommand(selected.command, [...selected.args, '--list-extensions', '--show-versions']);
    const extensionId = family === 'openai' ? 'openai.chatgpt' : 'anthropic.claude-code';
    if (!extensionInstalled(extensions, extensionId))
      throw new Error(
        `Установи расширение ${family === 'openai' ? 'Codex' : 'Claude Code'} вручную в выбранной установке: https://marketplace.visualstudio.com/items?itemName=${extensionId} . Затем запусти мастер снова. Подготовка настроек до установки расширения пока не проверена.`,
      );
  } catch (error) {
    throw new Error(`Проверка расширений ${editor.title} (${selected.kind}): ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  if (family === 'openai') await ensureAssistantCli('codex', dryRun);
  return selected;
}

/** Saved configurations are evidence for removal only, never proof of an installed editor. */
export function editorSettingsFiles(editor: Editor): string[] {
  return [
    ...new Set([
      vsCodeFamilySettingsPath(editor.folder, editor.linuxFolder),
      ...findEditorInstallations(editor)
        .map((installation) => installation.settingsPath)
        .filter(Boolean),
      ...(platform() === 'linux' && editor.id === 'vscode'
        ? [
            path.join(homeDir(), '.var/app/com.visualstudio.code/config/Code/User/settings.json'),
            path.join(homeDir(), 'snap/code/current/.config/Code/User/settings.json'),
          ]
        : []),
    ]),
  ];
}

/** Из какой конфигурации убрать подключение: из всех, где оно есть, — вызывающий проходит их по очереди. */
export function editorSettingsForRemoval(editor: Editor): string[] {
  const files = editorSettingsFiles(editor).filter((file) => fs.existsSync(file));
  return files.length > 0 ? files : [editorSettingsFiles(editor)[0]!];
}
