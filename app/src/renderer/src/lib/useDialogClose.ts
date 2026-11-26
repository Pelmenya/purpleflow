import { useCallback, useRef, useState } from 'react';

/** Длительность анимации закрытия диалога (dialogOut/fadeOut в motion.css). */
export const DIALOG_CLOSE_MS = 180;

/**
 * Закрытие с анимацией: close() включает closing (класс is-closing у подложки), окно уходит,
 * а fn вызывается после анимации. Повторные вызовы во время закрытия игнорируются.
 */
export function useDialogClose<A extends unknown[]>(fn: (...args: A) => void) {
  const [closing, setClosing] = useState(false);
  const busy = useRef(false);
  const latest = useRef(fn);
  latest.current = fn;
  const close = useCallback((...args: A) => {
    if (busy.current) return;
    busy.current = true;
    setClosing(true);
    window.setTimeout(() => {
      busy.current = false;
      setClosing(false);
      latest.current(...args);
    }, DIALOG_CLOSE_MS);
  }, []);
  return { closing, close };
}
