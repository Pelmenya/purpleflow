// Диктовка: кнопка микрофона у поля ввода и окно выбора модели whisper.cpp (скачивание по требованию).
import { Check, Languages, LoaderCircle, Mic, Square, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DictationStatus } from '../../../shared/ipc';
import { bridge, cleanErr } from '../lib/api';
import { dictationPref, useDictation } from '../lib/useDictation';
import { Select, type DropOption } from './Dropdown';
import { Button } from './ui';
import { useDialogClose } from '../lib/useDialogClose';

const LANG_OPTIONS: DropOption<string>[] = [
  { value: 'ru', label: 'Русский' },
  { value: 'en', label: 'English' },
  { value: 'auto', label: 'Определять сам', hint: 'По первым секундам речи; короткие фразы иногда путает' },
];

const mb = (n: number) => `${Math.round(n / 1_000_000)} МБ`;

let cached: DictationStatus | null = null;
async function loadStatus(): Promise<DictationStatus | null> {
  cached = await bridge.dictation.status().catch(() => null);
  return cached;
}

/** Выбранная модель: из настройки, если скачана, иначе первая скачанная (каталог идёт от лучшей). */
function activeModel(s: DictationStatus | null): string | null {
  const ready = s?.models.filter((m) => m.ready) ?? [];
  return ready.find((m) => m.id === dictationPref.model())?.id ?? ready[0]?.id ?? null;
}

/**
 * Кнопка микрофона: нажал — запись, нажал ещё раз — распознавание и вставка текста через onText.
 * Модели нет — открывает окно выбора. В сборке без whisper-cli кнопки нет.
 */
export function DictationButton({ onText, className = '' }: { onText: (text: string) => void; className?: string }) {
  const [status, setStatus] = useState<DictationStatus | null>(cached);
  const [setup, setSetup] = useState(false);
  const d = useDictation(onText);
  useEffect(() => {
    void loadStatus().then(setStatus);
  }, []);
  if (!status?.engine) return null;
  const model = activeModel(status);

  const click = () => {
    if (d.state === 'recording') return void d.stop();
    if (d.state === 'busy') return;
    if (!model) return setSetup(true);
    void d.start(model);
  };
  const title =
    d.state === 'recording'
      ? 'Остановить и вставить текст'
      : d.state === 'busy'
        ? 'Распознаю…'
        : model
          ? 'Диктовка: нажмите, говорите, нажмите ещё раз. Распознаётся на этом компьютере'
          : 'Диктовка: выбрать модель распознавания';
  return (
    <>
      <button
        type="button"
        className={`dictation-btn is-${d.state} ${className}`}
        aria-label={d.state === 'recording' ? 'Остановить диктовку' : 'Диктовка'}
        title={title}
        onClick={click}
        onContextMenu={(e) => {
          e.preventDefault();
          setSetup(true);
        }}
      >
        {d.state === 'recording' ? (
          <Square size={13} />
        ) : d.state === 'busy' ? (
          <LoaderCircle size={16} className="spin" />
        ) : (
          <Mic size={16} />
        )}
      </button>
      {d.error && (
        <span className="dictation-error" role="alert">
          {d.error}
          <button type="button" aria-label="Скрыть" onClick={d.clearError}>
            <X size={12} />
          </button>
        </span>
      )}
      {setup && (
        <DictationSetup
          onClose={(next) => {
            setSetup(false);
            if (next) setStatus(next);
          }}
        />
      )}
    </>
  );
}

/** Окно моделей: скачать, выбрать, удалить; язык распознавания. */
export function DictationSetup({ onClose: closeNow }: { onClose: (status?: DictationStatus) => void }) {
  const { closing, close: onClose } = useDialogClose(closeNow);
  const [status, setStatus] = useState<DictationStatus | null>(cached);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState(() => activeModel(cached));
  const [lang, setLang] = useState(dictationPref.lang);

  useEffect(() => {
    void loadStatus().then((s) => {
      setStatus(s);
      setChosen((c) => c ?? activeModel(s));
    });
    const off = bridge.dictation.onProgress((id, share) => setProgress((p) => ({ ...p, [id]: share })));
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose(cached ?? undefined);
    window.addEventListener('keydown', onKey);
    return () => {
      off();
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const download = async (id: string) => {
    setError(null);
    setProgress((p) => ({ ...p, [id]: 0 }));
    try {
      const s = await bridge.dictation.download(id);
      cached = s;
      setStatus(s);
      pick(id);
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setProgress(({ [id]: _, ...rest }) => rest);
    }
  };
  const remove = async (id: string) => {
    const s = await bridge.dictation.remove(id).catch((e) => (setError(cleanErr(e)), null));
    if (!s) return;
    cached = s;
    setStatus(s);
    if (chosen === id) setChosen(activeModel(s));
  };
  const pick = (id: string) => {
    setChosen(id);
    dictationPref.set('model', id);
  };
  const close = () => onClose(cached ?? undefined);

  return createPortal(
    <div className={`qs-scrim ${closing ? 'is-closing' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="qs dictation-setup" role="dialog" aria-modal aria-labelledby="dictation-title">
        <header className="qs-head">
          <div>
            <h2 id="dictation-title">Диктовка</h2>
            <p>Речь распознаётся на этом компьютере моделью Whisper — звук никуда не отправляется. Модель скачивается один раз.</p>
            {error && <p className="inline-error">{error}</p>}
          </div>
          <button className="qs-close" aria-label="Закрыть" onClick={close}>
            <X size={16} />
          </button>
        </header>
        <div className="dictation-models" role="radiogroup" aria-label="Модель распознавания">
          {status?.models.map((m) => {
            const share = progress[m.id];
            const loading = share !== undefined;
            return (
              <div key={m.id} className={`dictation-model ${chosen === m.id && m.ready ? 'is-on' : ''}`}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={chosen === m.id && m.ready}
                  className="dictation-model-pick"
                  disabled={!m.ready}
                  onClick={() => pick(m.id)}
                >
                  <span className="dictation-model-dot">{chosen === m.id && m.ready && <Check size={12} />}</span>
                  <span>
                    <strong>{m.label}</strong> <span className="dictation-model-size">{mb(m.size)}</span>
                    <small>{m.hint}</small>
                  </span>
                </button>
                {m.ready ? (
                  <button
                    type="button"
                    className="dictation-model-del"
                    aria-label={`Удалить модель ${m.label}`}
                    onClick={() => void remove(m.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                ) : loading ? (
                  <span className="dictation-model-progress">
                    <span>{Math.round(share * 100)}%</span>
                    <button type="button" aria-label="Отменить скачивание" onClick={() => void bridge.dictation.cancel(m.id)}>
                      <X size={12} />
                    </button>
                  </span>
                ) : (
                  <Button tone="ghost" onClick={() => void download(m.id)}>
                    Скачать
                  </Button>
                )}
              </div>
            );
          })}
        </div>
        <footer className="qs-foot">
          <span className="dictation-lang">
            <span id="dictation-lang">Язык речи</span>
            <Select<string>
              ariaLabel="Язык речи"
              icon={<Languages size={14} />}
              value={lang}
              minWidth={240}
              onChange={(v) => {
                setLang(v);
                dictationPref.set('lang', v);
              }}
              options={LANG_OPTIONS}
            />
          </span>
          <Button tone="primary" onClick={close} disabled={!status?.models.some((m) => m.ready)}>
            Готово
          </Button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
