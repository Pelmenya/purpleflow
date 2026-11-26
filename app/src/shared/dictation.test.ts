import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transcriptText } from './dictation';

test('transcriptText: сегменты в одну строку, без пометок тишины и музыки', () => {
  assert.equal(transcriptText(' Добавь кнопку диктовки,\n а потом запусти тесты.\n'), 'Добавь кнопку диктовки, а потом запусти тесты.');
  assert.equal(transcriptText('[BLANK_AUDIO]\n'), '');
  assert.equal(transcriptText(' (музыка) Привет [MUSIC PLAYING]\n'), 'Привет');
  // Галлюцинации на тишине — пусто, а не «титры».
  assert.equal(transcriptText(' Редактор субтитров Н.Закомолдина Корректор В.Сухиашвили\n'), '');
  assert.equal(transcriptText(' Продолжение следует...\n'), '');
});
