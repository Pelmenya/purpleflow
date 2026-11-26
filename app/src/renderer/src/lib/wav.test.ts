import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeWav, insertDictation } from './wav';

test('encodeWav: заголовок PCM 16 бит моно и отсчёты с ограничением', () => {
  const wav = encodeWav([new Float32Array([0, 1, -1]), new Float32Array([2, -2])], 16000);
  const v = new DataView(wav.buffer);
  const tag = (at: number) => String.fromCharCode(...wav.slice(at, at + 4));
  assert.equal(tag(0), 'RIFF');
  assert.equal(tag(8), 'WAVE');
  assert.equal(tag(36), 'data');
  assert.equal(v.getUint16(22, true), 1, 'моно');
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint32(40, true), 10, '5 отсчётов по 2 байта');
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((i) => v.getInt16(44 + i * 2, true)),
    [0, 32767, -32768, 32767, -32768],
  );
});

test('insertDictation: пробелы вокруг вставки и курсор после текста', () => {
  assert.deepEqual(insertDictation('', 'Привет'), { value: 'Привет', caret: 6 });
  assert.deepEqual(insertDictation('Сделай', 'кнопку'), { value: 'Сделай кнопку', caret: 13 });
  assert.deepEqual(insertDictation('ab', 'X', 1), { value: 'a X b', caret: 3 });
  assert.deepEqual(insertDictation('a ', 'X', 2), { value: 'a X', caret: 3 });
});
