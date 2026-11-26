import { note } from './notes.js';
import { readJsonc, writeJsoncField, removeJsoncField } from './jsonc.js';
import { claudeJsonPath, claudeSettingsPath, detectClaudeConflicts, fixConflict, type SettingsConflict } from './claudeSettingsDoctor.js';
import { claudeCatalog, defaultClaudeModel, proxyClaudeModels } from './models.js';
import { DEFAULT_ANTHROPIC_MODEL, LEGACY_DEFAULT_ANTHROPIC_MODELS } from '../constants.js';
import type { SetupContext } from './types.js';

/**
 * Общая часть настройки самого Claude Code — независимо от того, как его запускают.
 *
 * Расширение «Claude Code» в VS Code / Cursor / Windsurf внутри запускает тот же Claude Code,
 * что и CLI, и читает те же ~/.claude/settings.json и ~/.claude.json. До 0.7.0 эту часть делал
 * только target «Claude Code (CLI)», а он предвыбран, лишь если в PATH есть `claude`. Человек
 * с одним расширением отмечал только «VS Code», ключ оставался неодобренным, и расширение
 * бесконечно показывало «Not logged in · Please run /login» (неделя 21–27.09.2026 — 15
 * обращений в поддержку). Теперь эту часть вызывают все Claude-таргеты; внутри одного запуска
 * она выполняется один раз.
 */

interface ClaudeJson {
  customApiKeyResponses?: { approved?: string[] };
  model?: string;
}

// Claude Code remembers a one-time "use this custom API key?" approval by fingerprint — the
// key's last 20 characters — under customApiKeyResponses.approved in ~/.claude.json. Without
// this, the interactive TUI keeps showing "Not logged in" even though the key works fine
// non-interactively (confirmed: this is the exact fix that resolved it for our first real user).
function apiKeyFingerprint(apiKey: string): string {
  return apiKey.slice(-20);
}

// Single-run wizard process, so plain module state is fine to share between targets.
let prepared = false;
let applied = false;
let conflictsToFix: SettingsConflict[] = [];

/** Находит конфликты до записи. Исправимые уберёт applyClaudeCore, ручные останавливают настройку. Повторный вызов — no-op. */
export async function prepareClaudeCore(ctx: SetupContext): Promise<void> {
  if (prepared) return;
  prepared = true;

  // Leftovers from a previous hand-rolled setup are the single most common reason our config
  // "doesn't work": they sit in files we don't own and silently win over what we write.
  const conflicts = detectClaudeConflicts(proxyClaudeModels(ctx.proxyModels));
  const fixable = conflicts.filter((c) => c.fix.kind !== 'manual');
  const manual = conflicts.filter((c) => c.fix.kind === 'manual');

  if (manual.length > 0) {
    throw new Error(`Сначала уберите вручную:\n${manual.map((c) => `• ${c.description}`).join('\n')}`);
  }

  // Старые настройки перебили бы наши — убираем их сразу (оригиналы уходят в резервные копии).
  conflictsToFix = fixable;
  for (const c of fixable) note(`Убрано: ${c.description}`);
}

/** Пишет ключ, адрес прокси, одобрение ключа и пин модели. Повторный вызов в том же запуске — no-op. */
export function applyClaudeCore(ctx: SetupContext): string[] {
  if (applied) return [];
  applied = true;

  const notes: string[] = [];

  if (conflictsToFix.length > 0) {
    for (const conflict of conflictsToFix) {
      fixConflict(conflict);
    }
    notes.push(`Убрано старых конфликтующих настроек: ${conflictsToFix.length}.`);
  }

  // Per Anthropic's own gateway-connect troubleshooting guide, this is the documented fix for
  // "asks to log in even though the gateway works": put the credential in ~/.claude/settings.json's
  // env block. Unlike the shell rc export, this applies immediately — no new terminal needed.
  const settingsPath = claudeSettingsPath();
  writeJsoncField(settingsPath, ['env', 'ANTHROPIC_API_KEY'], ctx.apiKey);
  writeJsoncField(settingsPath, ['env', 'ANTHROPIC_BASE_URL'], ctx.baseUrl);
  writeJsoncField(settingsPath, ['env', 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'], '1');
  if (ctx.model) {
    writeJsoncField(settingsPath, ['model'], ctx.model);
    writeJsoncField(settingsPath, ['env', 'ANTHROPIC_MODEL'], ctx.model);
  }
  notes.push(`Ключ и base URL прописаны в ${settingsPath} — их читают и CLI, и расширение Claude Code в редакторе.`);

  // ~/.claude.json is undocumented (it's Anthropic's OAuth/MCP/project-state file, not a settings
  // file), but hasCompletedOnboarding is a real field there that many users have needed to bypass
  // the first-run login gate — keep setting it defensively alongside the documented fix above.
  const jsonPath = claudeJsonPath();
  writeJsoncField(jsonPath, ['hasCompletedOnboarding'], true);

  // The /model pin lives here and is sent on every request, so a pin left over from a previous
  // setup (a real user arrived with "sonnet[1m]", which the proxy doesn't serve) breaks
  // everything. Only overwrite a pin that's missing or outside the proxy's catalogue — a
  // deliberate choice among proxied models survives a re-run. Каталог — из ответа прокси;
  // если его нет, существующий пин не трогаем: судить о нём по зашитому списку нельзя.
  const catalog = claudeCatalog(ctx.proxyModels);
  const fromProxy = proxyClaudeModels(ctx.proxyModels) !== undefined;
  const pinnedModel = readJsonc<ClaudeJson>(jsonPath)?.model;
  const pinMissing = typeof pinnedModel !== 'string';
  const pinOutsideProxy = fromProxy && typeof pinnedModel === 'string' && !(pinnedModel in catalog);
  if (ctx.model || pinMissing || pinOutsideProxy) {
    const model = ctx.model ?? defaultClaudeModel(catalog);
    writeJsoncField(jsonPath, ['model'], model);
    notes.push(`Модель по умолчанию — ${catalog[model] ?? model} (из каталога прокси PurpleSchool).`);
  }

  // Pre-approve the key so the interactive TUI doesn't show "Not logged in · Please run /login"
  // until the user manually approves it once via /config → "Use custom API key".
  const fingerprint = apiKeyFingerprint(ctx.apiKey);
  const approvedKeys = readJsonc<ClaudeJson>(jsonPath)?.customApiKeyResponses?.approved ?? [];
  if (!approvedKeys.includes(fingerprint)) {
    writeJsoncField(jsonPath, ['customApiKeyResponses', 'approved'], [...approvedKeys, fingerprint]);
  }
  notes.push(`Онбординг отключён и ключ пред-одобрен в ${jsonPath} — без этого Claude Code пишет «Not logged in».`);

  return notes;
}

/** Откатывает то, что сделал applyClaudeCore. */
export function removeClaudeCore(): string[] {
  const notes: string[] = [];

  const settingsPath = claudeSettingsPath();
  // Read the key before removing it — needed below to find its fingerprint in customApiKeyResponses.
  const settings = readJsonc<{ model?: string; env?: { ANTHROPIC_API_KEY?: string; ANTHROPIC_MODEL?: string } }>(settingsPath);
  const previousApiKey = settings?.env?.ANTHROPIC_API_KEY;
  const previousModel = settings?.env?.ANTHROPIC_MODEL;

  removeJsoncField(settingsPath, ['env', 'ANTHROPIC_API_KEY']);
  removeJsoncField(settingsPath, ['env', 'ANTHROPIC_BASE_URL']);
  removeJsoncField(settingsPath, ['env', 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY']);
  removeJsoncField(settingsPath, ['env', 'ANTHROPIC_MODEL']);
  if (previousModel && settings?.model === previousModel) removeJsoncField(settingsPath, ['model']);
  notes.push(`Ключ, base URL и model discovery убраны из ${settingsPath} (остальные настройки там не тронуты).`);

  const jsonPath = claudeJsonPath();
  removeJsoncField(jsonPath, ['hasCompletedOnboarding']);

  // Only drop the model pin if it's still our default — the user may have picked another
  // proxied model deliberately.
  const pin = readJsonc<ClaudeJson>(jsonPath)?.model;
  if (
    pin === previousModel ||
    pin === DEFAULT_ANTHROPIC_MODEL ||
    (typeof pin === 'string' && LEGACY_DEFAULT_ANTHROPIC_MODELS.includes(pin))
  ) {
    removeJsoncField(jsonPath, ['model']);
  }

  if (previousApiKey) {
    const fingerprint = apiKeyFingerprint(previousApiKey);
    const approvedKeys = readJsonc<ClaudeJson>(jsonPath)?.customApiKeyResponses?.approved ?? [];
    const remaining = approvedKeys.filter((k) => k !== fingerprint);
    if (remaining.length !== approvedKeys.length) {
      if (remaining.length > 0) {
        writeJsoncField(jsonPath, ['customApiKeyResponses', 'approved'], remaining);
      } else {
        removeJsoncField(jsonPath, ['customApiKeyResponses', 'approved']);
      }
    }
  }

  notes.push(`Онбординг и одобрение ключа убраны из ${jsonPath}.`);
  return notes;
}
