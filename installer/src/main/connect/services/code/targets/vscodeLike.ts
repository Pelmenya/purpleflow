import fs from 'node:fs';
import { editors, ensureEditor, findEditorCommand, editorSettingsFiles, editorSettingsForRemoval } from '../../../core/editors.js';
import { commandExists, resolveVsCodeFamilySettingsPath } from '../../../core/os.js';
import { prepareClaudeCore, applyClaudeCore, removeClaudeCore } from '../../../core/claudeCore.js';
import { readJsonc, writeJsoncField, removeJsoncField } from '../../../core/jsonc.js';
import { ANTHROPIC_BASE_URL } from '../../../constants.js';
import type { Target } from '../../../core/types.js';

interface EnvVarEntry {
  name: string;
  value: string;
}

// Keys we own — apply() writes exactly these, remove() strips exactly these and nothing else.
const OWNED_ENV_VAR_NAMES = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY', 'ANTHROPIC_MODEL'];

function readEnvVars(settingsPath: string): EnvVarEntry[] {
  const existing = readJsonc<Record<string, unknown>>(settingsPath) ?? {};
  return Array.isArray(existing['claudeCode.environmentVariables']) ? (existing['claudeCode.environmentVariables'] as EnvVarEntry[]) : [];
}

/**
 * VS Code, Cursor and Windsurf all use the same "Claude Code" extension and the same
 * claudeCode.environmentVariables settings key — only the app folder / command name differ.
 *
 * Расширение внутри запускает тот же Claude Code, что и CLI, поэтому одних настроек редактора
 * мало: без одобренного ключа в ~/.claude.json оно пишет «Not logged in · Please run /login».
 * Общую часть (applyClaudeCore) делаем и здесь — она выполняется один раз за запуск, даже
 * если выбраны и редактор, и CLI.
 */

// Все редакторы семейства — чтобы при удалении одного понять, пользуются ли общими файлами другие.
const family: Target[] = [];

// Остался ли кто-то ещё, кому нужны общие файлы Claude Code: сам CLI (по переменной в shell
// судить нельзя — ANTHROPIC_API_KEY туда пишут и OpenCode, и Pi, поэтому смотрим на команду
// `claude`) или другой редактор семейства, который мы настраивали.
function otherClaudeConsumers(): boolean {
  if (commandExists('claude')) return true;
  return family.some((t) => t.isConfigured?.() === true);
}
function buildVsCodeFamilyTarget(id: string, title: string, appFolderName: string, linuxFolderName: string = appFolderName): Target {
  const editor = editors.find((item) => item.id === id)!;
  let selectedSettingsPath: string | undefined;
  const resolvePath = () => selectedSettingsPath ?? resolveVsCodeFamilySettingsPath(appFolderName, linuxFolderName);
  const conflictingNames = [
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CONFIG_DIR',
  ];

  const target: Target = {
    id,
    title,
    hint: `settings.json (${appFolderName})`,
    detect: () => Boolean(findEditorCommand(editor)),
    async ensureAvailable(dryRun) {
      selectedSettingsPath = (await ensureEditor(editor, 'anthropic', dryRun)).settingsPath;
    },
    async preflight(ctx) {
      await prepareClaudeCore(ctx);
    },
    async apply(ctx) {
      const settingsPath = resolvePath();
      const currentVars = readEnvVars(settingsPath);

      const desired: Record<string, string> = {
        ANTHROPIC_BASE_URL: ctx.baseUrl,
        ANTHROPIC_API_KEY: ctx.apiKey,
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
        ...(ctx.model ? { ANTHROPIC_MODEL: ctx.model } : {}),
      };

      // Конфликтующие параметры расширения (токен, Bedrock/Vertex/Foundry, CLAUDE_CONFIG_DIR) перекрыли бы подключение — убираем.
      const removed = currentVars.filter((entry) => entry && conflictingNames.includes(entry.name)).map((entry) => entry.name);
      const merged = currentVars.filter((entry) => entry && !Object.hasOwn(desired, entry.name) && !conflictingNames.includes(entry.name));
      for (const [name, value] of Object.entries(desired)) merged.push({ name, value });

      writeJsoncField(settingsPath, ['claudeCode.environmentVariables'], merged);
      writeJsoncField(settingsPath, ['claudeCode.disableLoginPrompt'], true);

      return {
        notes: [
          `Обновлён ${settingsPath}.`,
          ...(removed.length ? [`Убраны конфликтующие параметры расширения: ${removed.join(', ')}.`] : []),
          ...applyClaudeCore(ctx),
          `Выбрана модель ${ctx.model}. Общие параметры также действуют на Claude Code CLI.`,
          `Полностью закрой все окна ${title} и открой заново, чтобы изменения применились.`,
        ],
      };
    },
    isConfigured: () => {
      return editorSettingsFiles(editor).some((file) =>
        readEnvVars(file).some((entry) => entry?.name === 'ANTHROPIC_BASE_URL' && entry.value === ANTHROPIC_BASE_URL),
      );
    },
    async remove() {
      const notes: string[] = [];
      for (const settingsPath of editorSettingsForRemoval(editor)) {
        if (!fs.existsSync(settingsPath)) continue;
        const currentVars = readEnvVars(settingsPath);
        const remaining = currentVars.filter((entry) => !OWNED_ENV_VAR_NAMES.includes(entry?.name));
        if (remaining.length !== currentVars.length) {
          if (remaining.length > 0) writeJsoncField(settingsPath, ['claudeCode.environmentVariables'], remaining);
          else removeJsoncField(settingsPath, ['claudeCode.environmentVariables']);
        }
        removeJsoncField(settingsPath, ['claudeCode.disableLoginPrompt']);
        notes.push(
          `Наши переменные убраны из ${settingsPath}${remaining.length > 0 ? ' (остальные записи в claudeCode.environmentVariables не тронуты)' : ''}.`,
        );
      }

      const coreNotes = otherClaudeConsumers()
        ? [
            'Общие настройки Claude Code (~/.claude/settings.json, ~/.claude.json) оставлены — ими пользуется Claude Code в терминале или другой редактор.',
          ]
        : removeClaudeCore();

      return { notes: [...notes, ...coreNotes, `Расширение "Claude Code" в ${title} не удалялось — только настройки прокси.`] };
    },
  };
  family.push(target);
  return target;
}

export const vscode = buildVsCodeFamilyTarget('vscode', 'VS Code', 'Code');
export const cursor = buildVsCodeFamilyTarget('cursor', 'Cursor', 'Cursor');
// Windsurf's Linux config folder is lowercase ("~/.config/windsurf"), unlike macOS/Windows ("Windsurf").
export const windsurf = buildVsCodeFamilyTarget('windsurf', 'Windsurf', 'Windsurf', 'windsurf');
