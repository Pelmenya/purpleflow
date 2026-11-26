import type { Platform } from './os.js';
import type { ModelCatalog } from './models.js';

export interface SetupContext {
  apiKey: string;
  baseUrl: string;
  platform: Platform;
  /** true when running with --dry-run: targets must not touch the filesystem */
  dryRun: boolean;
  /**
   * Модели, которые прокси вернул на /v1/models при проверке ключа. undefined — если проверить
   * не удалось или выполняется удаление без ключа. Установка требует доступный каталог.
   */
  proxyModels?: ModelCatalog;
  /** Exact model selected by the user; absent only during removal. */
  model?: string;
  /** Successful earlier removals; dry-run uses these to simulate shared configuration cleanup. */
  removedTargetIds?: string[];
}

export interface ApplyResult {
  /** Extra lines printed to the user after a target finishes (paths touched, manual steps left, etc.) */
  notes?: string[];
}

export interface Target {
  id: string;
  title: string;
  /** Short hint shown next to the option, e.g. the config file that will be touched */
  hint?: string;
  detect: () => Promise<boolean> | boolean;
  /** Checks run for all chosen targets before anything is written (conflicts, WSL, overrides). */
  preflight?: (ctx: SetupContext) => Promise<void>;
  /** Check/install prerequisites before asking for credentials. Never installs editors/extensions. */
  ensureAvailable?: (dryRun: boolean) => Promise<void>;
  apply: (ctx: SetupContext) => Promise<ApplyResult | void>;
  /**
   * True if this target's config looks like WE set it up before (our marker block present,
   * our specific file exists, etc.) — used to pre-select it in the uninstall list. Falls back
   * to `detect` (tool present at all) when omitted.
   */
  isConfigured?: () => Promise<boolean> | boolean;
  /** Surgically reverts exactly what apply() added, leaving everything else untouched. No-op if never applied. */
  remove?: (ctx: SetupContext) => Promise<ApplyResult | void>;
}

export interface Service {
  id: string;
  title: string;
  /** Proxy base URL passed to every target's SetupContext (targets append their own suffix, e.g. /v1). */
  baseUrl: string;
  /** Auth header style used to validate the API key against this service's proxy before touching any config. Defaults to "anthropic". */
  authScheme?: 'anthropic' | 'openai';
  targets: Target[];
}
