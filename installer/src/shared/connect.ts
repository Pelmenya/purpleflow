// Подключение приложений к AI-прокси PurpleSchool: обмен окна, main-процесса и процесса настройки.

export type ClientFamily = 'claude' | 'codex';

export interface ClientInfo {
  /** id цели мастера ai-for-code, уникален для обоих семейств. */
  id: string;
  family: ClientFamily;
  title: string;
  /** Уже подключено к PurpleSchool. */
  configured: boolean;
  /** Приложение стоит на компьютере. Нет — агент из терминала поставим при включении. */
  installed: boolean;
}

export interface ClientResult {
  id: string;
  ok: boolean;
  /** Подпись выбранной модели. */
  model?: string;
  notes?: string[];
  error?: string;
  /** Ключ не подошёл: нужен вход в аккаунт. */
  needLogin?: boolean;
}

export interface ConnectProgress {
  id: string;
  status: 'running' | 'done' | 'failed';
  /**
   * Что сейчас делается: ждём очереди, проверяем приложение (и ставим claude/codex), проверяем ключ и подбираем
   * модель, записываем настройки, убираем подключение.
   */
  stage?: 'queued' | 'check' | 'model' | 'write' | 'remove';
}

export type WorkerRequest = { type: 'scan' } | { type: 'apply'; apiKey?: string; enable: string[]; disable: string[] };

export type WorkerResponse =
  | { type: 'scan'; clients: ClientInfo[]; hasKey: boolean; jetbrains: boolean }
  | { type: 'progress'; progress: ConnectProgress }
  | { type: 'apply'; results: ClientResult[] }
  | { type: 'error'; error: string };

export type AccountResult = { ok: true } | { ok: false; error: string; code?: string };

export interface AccountState {
  email: string | null;
  /** Имя и фото (data URL) из профиля PurpleSchool; пустые — не загрузились. */
  name: string;
  photo: string;
}
