// Запись с микрофона для диктовки: звук 16 кГц моно копится в окне и уходит в whisper-cli одним WAV после остановки.
import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge, cleanErr } from './api';
import { encodeWav } from './wav';

const RATE = 16000;
/** Короче — это случайное нажатие, распознавать нечего. */
const MIN_SECONDS = 0.4;
/** Дольше — остановить самим: whisper лучше распознаёт куски до нескольких минут, а файл не раздувается. */
const MAX_SECONDS = 5 * 60;

const pref = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
export const dictationPref = {
  model: () => pref('pf-dictation-model', ''),
  lang: () => pref('pf-dictation-lang', 'ru'),
  set(key: 'model' | 'lang', value: string) {
    try {
      localStorage.setItem(`pf-dictation-${key}`, value);
    } catch {
      /* без хранилища — выбор только на этот запуск */
    }
  },
};

/** Порог тишины по пиковой амплитуде (из 1.0). */
const SILENCE = 0.01;
const peak = (chunks: Float32Array[]) => chunks.reduce((m, c) => c.reduce((x, v) => Math.max(x, Math.abs(v)), m), 0);

export type DictationState = 'idle' | 'recording' | 'busy';

/**
 * start — спросить микрофон и писать; stop — распознать и отдать текст в onText. model — id скачанной модели.
 * Ошибки — в error (нет доступа к микрофону, сбой распознавания).
 */
export function useDictation(onText: (text: string) => void) {
  const [state, setState] = useState<DictationState>('idle');
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<{ ctx: AudioContext; stream: MediaStream; chunks: Float32Array[]; model: string; timer: number } | null>(null);
  const textRef = useRef(onText);
  textRef.current = onText;

  const release = () => {
    const r = rec.current;
    rec.current = null;
    if (!r) return null;
    window.clearTimeout(r.timer);
    r.stream.getTracks().forEach((t) => t.stop());
    void r.ctx.close().catch(() => {});
    return r;
  };

  const stop = useCallback(async () => {
    const r = release();
    if (!r) return;
    const samples = r.chunks.reduce((n, c) => n + c.length, 0);
    if (samples < RATE * MIN_SECONDS) return setState('idle');
    // Тишина: без этого Whisper «распознаёт» титры из обучающих роликов.
    if (peak(r.chunks) < SILENCE) {
      setState('idle');
      return setError('Микрофон ничего не услышал — проверьте, что выбран нужный микрофон и он не выключен');
    }
    setState('busy');
    try {
      const text = await bridge.dictation.transcribe(encodeWav(r.chunks, RATE), r.model, dictationPref.lang());
      if (text) textRef.current(text);
      else setError('Речь не распознана — попробуйте говорить ближе к микрофону');
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setState('idle');
    }
  }, []);

  const start = useCallback(
    async (model: string) => {
      if (rec.current) return;
      setError(null);
      try {
        if (!(await bridge.dictation.mic()))
          throw new Error('Нет доступа к микрофону. Разрешите его PurpleFlow в системных настройках (Конфиденциальность → Микрофон).');
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        // Chromium сам передискретизирует вход в 16 кГц — так ждёт whisper.
        const ctx = new AudioContext({ sampleRate: RATE });
        const src = ctx.createMediaStreamSource(stream);
        const node = ctx.createScriptProcessor(4096, 1, 1);
        const chunks: Float32Array[] = [];
        node.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
        src.connect(node);
        node.connect(ctx.destination);
        const timer = window.setTimeout(() => void stop(), MAX_SECONDS * 1000);
        rec.current = { ctx, stream, chunks, model, timer };
        setState('recording');
      } catch (e) {
        release();
        setState('idle');
        setError(cleanErr(e));
      }
    },
    [stop],
  );

  // Ушли со страницы во время записи — микрофон отпускаем.
  useEffect(() => () => void release(), []);
  return { state, error, start, stop, clearError: () => setError(null) };
}
