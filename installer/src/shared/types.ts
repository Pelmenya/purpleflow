// Общие типы окна и main-процесса установщика.

/** Node.js и Git ставятся всегда; PurpleFlow — если отмечен. */
export type StepId = 'purpleflow' | 'node' | 'git';

export type StepStatus =
  /** Ещё не проверяли. */
  | 'unknown'
  /** Уже стоит, ставить не нужно. */
  | 'ok'
  /** Нет — поставим. */
  | 'missing'
  | 'running'
  /** Поставили в этот запуск. */
  | 'done'
  /** Ждём действия пользователя в системном окне (git на macOS). */
  | 'waiting'
  | 'failed';

export interface StepState {
  id: StepId;
  status: StepStatus;
  /** Версия, путь или текст ошибки. */
  detail?: string;
  /** Доля скачанного, 0…1. */
  progress?: number;
}

export interface LaunchResult {
  ok: boolean;
  error?: string;
}

import type { AccountResult, AccountState, ConnectProgress, WorkerResponse } from './connect';

export interface ApplyRequest {
  purpleflow: boolean;
  enable: string[];
  disable: string[];
}

export interface ApplyResult {
  steps: StepState[];
  /** Итог подключений; нет — подключать и отключать было нечего. */
  connect?: WorkerResponse;
}

/** Новая версия самого установщика в последнем релизе. */
export interface InstallerUpdate {
  version: string;
  file: string;
  url: string;
  sha256: string;
  size: number;
  page: string;
}

export type UpdateResult = { ok: true; relaunched: boolean; path: string } | { ok: false; error: string };

export interface InstallerBridge {
  platform: string;
  check(): Promise<StepState[]>;
  /** Одно действие экрана: обязательное окружение, PurpleFlow (если отмечен), подключить и отключить приложения. */
  apply(req: ApplyRequest): Promise<ApplyResult>;
  launch(): Promise<LaunchResult>;
  copyReport(): Promise<void>;
  selfUpdate: {
    check(): Promise<InstallerUpdate | null>;
    apply(): Promise<UpdateResult>;
    openPage(): Promise<void>;
    onProgress(fn: (p: number) => void): () => void;
  };
  openDownloads(): Promise<void>;
  quit(): void;
  onStep(fn: (s: StepState) => void): () => void;
  connect: {
    scan(): Promise<WorkerResponse>;
    onProgress(fn: (p: ConnectProgress) => void): () => void;
    openCabinet(): Promise<void>;
  };
  account: {
    state(): Promise<AccountState>;
    login(email: string, password: string): Promise<AccountResult>;
    register(p: { name: string; email: string; password: string; mailing: boolean }): Promise<AccountResult>;
    restore(email: string): Promise<AccountResult & { message?: string }>;
    logout(): Promise<void>;
  };
}
