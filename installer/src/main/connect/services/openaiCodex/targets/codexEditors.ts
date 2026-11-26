import { note } from '../../../core/notes.js';
import { readJsonc, removeJsoncField } from '../../../core/jsonc.js';
import { resolveVsCodeFamilySettingsPath } from '../../../core/os.js';
import { editors, ensureEditor, findEditorCommand } from '../../../core/editors.js';
import type { Target } from '../../../core/types.js';
import { applyCodexCore, openaiCodexCli, prepareCodexCore } from './openaiCodexCli.js';

export const codexEditors: Target[] = editors.map((editor) => {
  let removeExecutableOverride = false;
  let selectedSettingsPath: string | undefined;
  const settingsPath = () => selectedSettingsPath ?? resolveVsCodeFamilySettingsPath(editor.folder, editor.linuxFolder);
  return {
    id: `codex-${editor.id}`,
    title: editor.title,
    hint: 'расширение Codex',
    detect: () => Boolean(findEditorCommand(editor)),
    async ensureAvailable(dryRun) {
      selectedSettingsPath = (await ensureEditor(editor, 'openai', dryRun)).settingsPath;
    },
    async preflight() {
      const settings = readJsonc<Record<string, unknown>>(settingsPath());
      if (settings?.['chatgpt.runCodexInWindowsSubsystemForLinux'] === true) {
        throw new Error(
          'Codex настроен на запуск в WSL. Запусти настройку Codex CLI внутри того же WSL; Windows-конфигурация не будет применена к Linux-процессу расширения.',
        );
      }
      if (settings?.['chatgpt.cliExecutable']) {
        note(`В ${editor.title} был задан нестандартный исполняемый файл Codex — переопределение убрано, расширение запустит штатный.`);
        removeExecutableOverride = true;
      }
      await prepareCodexCore();
    },
    async apply(ctx) {
      if (removeExecutableOverride) removeJsoncField(settingsPath(), ['chatgpt.cliExecutable']);
      return { notes: [...applyCodexCore(ctx), `Открой панель Codex в ${editor.title}. Само расширение мастер не устанавливает.`] };
    },
    // Shared config is offered once under Codex CLI during removal, not once per editor.
    isConfigured: () => false,
    remove: openaiCodexCli.remove,
  };
});
