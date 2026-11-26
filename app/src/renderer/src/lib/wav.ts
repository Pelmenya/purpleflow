/** WAV PCM 16 бит моно — формат, который whisper-cli читает без ffmpeg. */
export function encodeWav(chunks: Float32Array[], sampleRate: number): Uint8Array {
  const samples = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const str = (at: number, s: string) => [...s].forEach((ch, i) => v.setUint8(at + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true); // размер блока fmt
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // моно
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // байт в секунду
  v.setUint16(32, 2, true); // байт на отсчёт
  v.setUint16(34, 16, true); // бит на отсчёт
  str(36, 'data');
  v.setUint32(40, samples * 2, true);
  let at = 44;
  for (const c of chunks)
    for (let i = 0; i < c.length; i++, at += 2) {
      const s = Math.max(-1, Math.min(1, c[i]));
      v.setInt16(at, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  return new Uint8Array(buf);
}

/** Вставить текст диктовки в позицию курсора: с пробелом, если слева слово. */
export function insertDictation(value: string, text: string, caret = value.length): { value: string; caret: number } {
  const at = Math.max(0, Math.min(caret, value.length));
  const before = value.slice(0, at);
  const after = value.slice(at);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = after && !/^\s/.test(after) ? ' ' : '';
  const next = before + lead + text + trail + after;
  return { value: next, caret: (before + lead + text).length };
}
