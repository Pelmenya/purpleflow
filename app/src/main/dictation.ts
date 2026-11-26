/**
 * Диктовка: локальное распознавание речи whisper.cpp. Звук записывает окно (WAV 16 кГц моно), распознаёт whisper-cli
 * отдельным процессом — его сбой не роняет приложение. Модели скачиваются по требованию в данные приложения
 * и проверяются по sha256; в сеть уходит только запрос модели, звук остаётся на компьютере.
 */
import { app, systemPreferences } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { transcriptText } from '../shared/dictation';
import type { DictationModel, DictationStatus } from '../shared/ipc';

/** Модели whisper.cpp (ggerganov/whisper.cpp на Hugging Face). Размер и sha256 — из LFS, файл проверяется после скачивания. */
export const DICTATION_MODELS: (DictationModel & { file: string; sha256: string })[] = [
  {
    id: 'large-v3-turbo-q5_0',
    label: 'Точная',
    hint: 'Лучшее качество и термины; на Mac быстрая, на слабом ноутбуке без видеокарты — медленнее',
    size: 574_041_195,
    file: 'ggml-large-v3-turbo-q5_0.bin',
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
  },
  {
    id: 'small-q5_1',
    label: 'Сбалансированная',
    hint: 'Хорошо понимает русский, быстрее точной на процессоре',
    size: 190_085_487,
    file: 'ggml-small-q5_1.bin',
    sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
  },
  {
    id: 'base',
    label: 'Лёгкая',
    hint: 'Самая быстрая, но чаще ошибается',
    size: 147_951_465,
    file: 'ggml-base.bin',
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
  },
];

const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
const EXE = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
const OS = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
const LANGS = new Set(['ru', 'en', 'auto']);

const modelsDir = () => path.join(app.getPath('userData'), 'whisper-models');
const modelPath = (m: { file: string }) => path.join(modelsDir(), m.file);

/** whisper-cli: в собранном приложении — в ресурсах, при разработке — из app/whisper-bin (scripts/build-whisper.mjs). */
export function whisperBin(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'whisper', EXE) : path.join(app.getAppPath(), 'whisper-bin', OS, EXE);
}

export function dictationStatus(): DictationStatus {
  return {
    engine: fs.existsSync(whisperBin()),
    models: DICTATION_MODELS.map(({ id, label, hint, size }) => ({
      id,
      label,
      hint,
      size,
      ready: fs.existsSync(modelPath({ file: fileOf(id) })),
    })),
  };
}

const fileOf = (id: string) => DICTATION_MODELS.find((m) => m.id === id)?.file ?? '';

function modelOf(id: string) {
  const m = DICTATION_MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`Неизвестная модель: ${id}`);
  return m;
}

const downloads = new Map<string, AbortController>();

/**
 * Скачать модель в .part, считая sha256 на лету; совпало — переименовать. Прогресс — в onProgress (0…1).
 * Повторный вызов той же модели во время скачивания — ошибка, отменить — cancelDownload.
 */
export async function downloadModel(id: string, onProgress: (share: number) => void): Promise<DictationStatus> {
  const m = modelOf(id);
  if (fs.existsSync(modelPath(m))) return dictationStatus();
  if (downloads.has(id)) throw new Error('Модель уже скачивается');
  const ctl = new AbortController();
  downloads.set(id, ctl);
  fs.mkdirSync(modelsDir(), { recursive: true });
  const part = `${modelPath(m)}.part`;
  try {
    const res = await fetch(MODEL_URL + m.file, { signal: ctl.signal });
    if (!res.ok || !res.body) throw new Error(`Модель не скачалась: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || m.size;
    const hash = createHash('sha256');
    const out = fs.createWriteStream(part);
    let got = 0;
    let shown = -1;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
      const share = Math.min(1, got / total);
      if (Math.floor(share * 100) !== shown) {
        shown = Math.floor(share * 100);
        onProgress(share);
      }
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
    if (hash.digest('hex') !== m.sha256) throw new Error('Модель скачалась с ошибкой (контрольная сумма не сошлась). Попробуйте ещё раз.');
    fs.renameSync(part, modelPath(m));
    return dictationStatus();
  } catch (e) {
    fs.rmSync(part, { force: true });
    if (ctl.signal.aborted) throw new Error('Скачивание отменено', { cause: e });
    throw e;
  } finally {
    downloads.delete(id);
  }
}

export function cancelDownload(id: string): void {
  downloads.get(id)?.abort();
}

export function removeModel(id: string): DictationStatus {
  fs.rmSync(modelPath(modelOf(id)), { force: true });
  return dictationStatus();
}

/**
 * e2e: PURPLEFLOW_FAKE_MIC=<wav> — микрофон Chromium читает этот файл, системный запрос доступа не показывается.
 * Вызывать до готовности приложения: переключатели Chromium читаются при старте.
 */
export function fakeMicFromEnv(): void {
  const file = process.env.PURPLEFLOW_FAKE_MIC;
  if (!file) return;
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', file);
}

/** Доступ к микрофону: на macOS система спрашивает человека один раз; на Windows и Linux решает сама ОС. */
export async function micAccess(): Promise<boolean> {
  if (process.platform !== 'darwin' || process.env.PURPLEFLOW_FAKE_MIC) return true;
  const s = systemPreferences.getMediaAccessStatus('microphone');
  if (s === 'granted') return true;
  if (s === 'denied' || s === 'restricted') return false;
  return systemPreferences.askForMediaAccess('microphone');
}

/** Распознать WAV (16 кГц моно) моделью id. Временный файл удаляется сразу после распознавания. */
export async function transcribe(wav: Uint8Array, id: string, lang: string): Promise<string> {
  const m = modelOf(id);
  if (!fs.existsSync(modelPath(m))) throw new Error('Модель для диктовки не скачана');
  const bin = whisperBin();
  if (!fs.existsSync(bin)) throw new Error('В этой сборке нет движка диктовки (whisper-cli)');
  if (wav.length < 44 || wav.length > 100 * 1024 * 1024) throw new Error('Запись пустая или слишком длинная');
  const file = path.join(os.tmpdir(), `purpleflow-dictation-${randomUUID()}.wav`);
  fs.writeFileSync(file, wav);
  const threads = String(Math.max(1, Math.min(8, os.availableParallelism() - 1)));
  try {
    const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const p = spawn(bin, ['-m', modelPath(m), '-f', file, '-l', LANGS.has(lang) ? lang : 'ru', '-nt', '-np', '-sns', '-t', threads], {
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      p.stdout.setEncoding('utf8').on('data', (t: string) => (stdout += t));
      p.stderr.setEncoding('utf8').on('data', (t: string) => (stderr = (stderr + t).slice(-4000)));
      const timer = setTimeout(() => p.kill(), 5 * 60_000);
      p.on('error', reject);
      p.on('close', (c) => {
        clearTimeout(timer);
        resolve({ code: c, stdout, stderr });
      });
    });
    if (code !== 0) throw new Error(`Распознавание не удалось: ${stderr.trim().split('\n').pop() ?? `код ${code}`}`);
    return transcriptText(stdout);
  } finally {
    fs.rmSync(file, { force: true });
  }
}
