import { gateMessage } from '../gates.js';
import type { DiffFile, ReviewItem, RunFile } from '../types.js';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function decisionForm(run: RunFile, waitId: string, action: string, label: string, fields = ''): string {
  return `<form method="post" action="/runs/${encodeURIComponent(run.id)}/decision"><input type="hidden" name="expectedWaitId" value="${escapeHtml(waitId)}">${fields}<button type="submit" name="action" value="${action}">${label}</button></form>`;
}

function reviewItems(title: string, items: ReviewItem[]): string {
  const list = items
    .map(
      (item) =>
        `<li><span>${escapeHtml(item.file ?? '—')}:${item.line ?? '—'}</span><pre>${escapeHtml(item.message)}</pre></li>`,
    )
    .join('');
  return `<h4>${title}</h4>${list ? `<ul>${list}</ul>` : '<p>Нет замечаний.</p>'}`;
}

export function renderAcceptance(run: RunFile, diff: DiffFile[], waitId: string): string {
  const reason = escapeHtml(gateMessage(run) ?? run.message ?? '');
  const files = diff
    .map((file) => {
      const content = file.binary
        ? '<p>двоичный файл</p>'
        : `<h5>Было</h5><pre>${escapeHtml(file.original)}</pre><h5>Стало</h5><pre>${escapeHtml(file.modified)}</pre>`;
      return `<article><h4>${escapeHtml(file.path)}</h4><p>Статус: ${escapeHtml(file.status)}</p>${content}</article>`;
    })
    .join('');

  const latestTest = run.tests.at(-1);
  const test = latestTest
    ? `<dl><dt>Команда</dt><dd><pre>${escapeHtml(latestTest.command)}</pre></dd><dt>Результат</dt><dd>${latestTest.passed ? 'Пройдена' : 'Не пройдена'}</dd><dt>Код выхода</dt><dd>${latestTest.exitCode ?? '—'}</dd></dl><h4>Вывод</h4><pre>${escapeHtml(latestTest.output)}</pre>`
    : '<p>Проверка не запускалась</p>';

  const latestReview = run.reviews.at(-1);
  const review = latestReview
    ? `${reviewItems('Блокирующие замечания', latestReview.blocking)}${reviewItems('Заметки', latestReview.notes)}`
    : '<p>Ревью не было</p>';

  const actions =
    run.mode === 'review'
      ? `${decisionForm(run, waitId, 'approve', 'Завершить разбор')}${decisionForm(run, waitId, 'cancel', 'Отменить')}`
      : `${decisionForm(run, waitId, 'approve', 'Принять')}${decisionForm(run, waitId, 'reject', 'Вернуть с комментарием', '<label>Комментарий <textarea name="comment" required></textarea></label>')}`;

  return `<section><h2>Приёмка</h2><p>${reason}</p><h3>Дифф</h3>${files || '<p>Изменений нет.</p>'}<h3>Проверка</h3>${test}<h3>Ревью</h3>${review}${actions}</section>`;
}
