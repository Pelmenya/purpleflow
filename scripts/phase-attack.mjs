// Свидетельства одной вехи: card-N.md (проверенное тело), attack-N.txt,
// attack-comp.txt и triage.md с разбором каждой #N. N — реальный номер issue.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const repo = 'Pelmenya/purpleflow';
const read = (name) => readFileSync(name, 'utf8').replace(/\r\n/g, '\n').trimEnd();
const hash = (value) => createHash('sha256').update(value).digest('hex');
function api(endpoint) {
  const output = execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${repo}/${endpoint}`], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(output).flat();
}
function requireValue(value, message) {
  if (!value) throw new Error(message);
}
function phaseDir(title) {
  const match = /^Ralph · Ф(\d+[a-z0-9]*): /.exec(title);
  requireValue(match, `Неверное название вехи: ${title}`);
  return path.join(root, '.claude/local/attacks', 'f' + match[1]);
}
function evidence(dir, number, title, known = []) {
  const issues = api(`issues?state=all&milestone=${number}&per_page=100`).filter(
    (issue) => !issue.pull_request && (issue.state === 'open' || known.includes(issue.number)),
  );
  requireValue(issues.length && issues.every((issue) => issue.milestone?.title === title), 'Веха пуста или переименована');
  const triage = read(path.join(dir, 'triage.md'));
  const composition = read(path.join(dir, 'attack-comp.txt'));
  requireValue(composition.trim(), 'Пустая атака композиции');
  const cards = issues
    .sort((a, b) => a.number - b.number)
    .map((issue) => {
      const id = issue.number;
      const body = read(path.join(dir, `card-${id}.md`));
      const report = read(path.join(dir, `attack-${id}.txt`));
      requireValue(
        body && report.trim() && body === (issue.body ?? '').replace(/\r\n/g, '\n').trimEnd(),
        `#${id}: проверь финальное тело и атаку`,
      );
      requireValue(new RegExp(`#${id}\\b`).test(triage), `#${id}: нет разбора в triage.md`);
      return { id, body: hash(body), attack: hash(report) };
    });
  return { number, title, cards, composition: hash(composition), triage: hash(triage) };
}
function stamp(number) {
  requireValue(/^\d+$/.test(number), 'Укажи номер вехи GitHub');
  const [{ title }] = api(`milestones/${number}`);
  const dir = phaseDir(title);
  const result = evidence(dir, Number(number), title);
  // Предыдущая фаза должна быть в базе, прежде чем её зависимость попадает в очередь.
  const subjects = execFileSync('git', ['log', 'origin/main', '--format=%s'], { cwd: root, encoding: 'utf8' });
  for (const { id } of result.cards) {
    const section = read(path.join(dir, `card-${id}.md`))
      .split(/^## Предпосылки\s*$/m)[1]
      ?.split(/^## /m)[0];
    requireValue(section?.trim(), `#${id}: пропущены предпосылки`);
    for (const [, phase] of section.matchAll(/Ф(\d+[a-z]*)/g))
      requireValue(subjects.includes(`Ralph · Ф${phase}:`), `#${id}: нужна Ф${phase} в origin/main`);
  }
  const target = path.join(dir, 'stamp.json');
  const tmp = target + '.' + process.pid;
  writeFileSync(tmp, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  renameSync(tmp, target);
  console.log(`Подтверждено: ${title} (${result.cards.length})`);
}
function check(args) {
  const raw = JSON.parse(read(path.join(root, '.claude/ralph/ralph.config.json')));
  const i = args.indexOf('--profile');
  const inline = args.find((arg) => arg.startsWith('--profile='));
  const profile = i < 0 ? (inline?.slice('--profile='.length) ?? raw.defaultProfile) : args[i + 1];
  const cfg = { ...raw.common, ...raw.profiles?.[profile] };
  for (const { milestone } of cfg.phases ?? []) {
    const dir = phaseDir(milestone);
    const previous = JSON.parse(read(path.join(dir, 'stamp.json')));
    requireValue(Number.isSafeInteger(previous.number) && previous.number > 0 && previous.title === milestone, 'Штамп от другой вехи');
    const next = evidence(
      dir,
      previous.number,
      milestone,
      previous.cards.map((card) => card.id),
    );
    requireValue(JSON.stringify(previous) === JSON.stringify(next), `Изменились карточки или свидетельства: ${milestone}`);
  }
}
try {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'stamp') stamp(args[0]);
  else if (action === 'check') check(args);
  else throw new Error('Ожидается stamp <номер вехи> или check [--profile имя]');
} catch (error) {
  console.error(`Проверка атаки фазы: ${error.message}`);
  process.exitCode = 1;
}
