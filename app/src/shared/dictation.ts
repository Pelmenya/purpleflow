// Разбор ответа whisper-cli для диктовки — отдельно от main, чтобы проверять тестами без Electron.

/** Служебные пометки whisper вместо речи: тишина, музыка, шум. */
const NOISE = /\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE|Музыка|музыка)[^\]]*\]|\((музыка|тишина|шум)[^)]*\)/gi;

/**
 * Галлюцинации Whisper на тишине и шуме: модель училась на роликах с титрами и «дописывает» их.
 * Ответ целиком из такой фразы — значит, речи не было.
 */
const HALLUCINATION =
  /^(редактор субтитров|корректор|субтитры (сделал|создавал|подготовил)|продолжение следует|спасибо за (просмотр|внимание)|подписывайтесь)[^]*$/i;

/** Текст из вывода whisper-cli -nt: строки сегментов, без пометок тишины. */
export function transcriptText(stdout: string): string {
  const text = stdout
    .replace(NOISE, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return HALLUCINATION.test(text) ? '' : text;
}
