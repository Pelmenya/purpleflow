// Один экран: обязательные Node.js и Git, переключатели «что установить и подключить» и одна кнопка.
// Отмеченное ставится и подключается к моделям PurpleSchool, выключенный переключатель убирает подключение.
import './style.css';
import logo from './icons/purpleflow.svg';
import claudeIcon from './icons/claude.svg';
import codexIcon from './icons/codex.svg';
import opencodeIcon from './icons/opencode.svg';
import piIcon from './icons/pi.svg';
import qwenIcon from './icons/qwen.svg';
import vscodeIcon from './icons/vscode.svg';
import cursorIcon from './icons/cursor.svg';
import windsurfIcon from './icons/windsurf.svg';
import neovimIcon from './icons/neovim.svg';
import nodeIcon from './icons/node.svg';
import gitIcon from './icons/git.svg';
import crushIcon from './icons/crush.svg';
import jetbrainsIcon from './icons/jetbrains.svg';
import type { InstallerUpdate, StepId, StepState } from '../../shared/types';
import type { ClientInfo, ClientResult, ConnectProgress } from '../../shared/connect';

type Phase = 'loading' | 'ready' | 'busy';
type AuthMode = 'login' | 'register' | 'restore';

const api = window.installer;
const root = document.getElementById('root')!;

type Family = 'claude' | 'codex';
interface Tool {
  name: string;
  sub: string;
  icon: string;
  group: 'term' | 'editor';
  /** Цели мастера по семействам моделей: одна строка — один инструмент, переключатели — модели. */
  ids: Partial<Record<Family, string>>;
  /** Показывать ли строку; по умолчанию — если цель есть в списке найденного. */
  when?: () => boolean;
}

/** Иконки — из дизайна PurpleSchool (сетка «Или настройте вручную» на странице «AI для кода»). */
const TOOLS: Tool[] = [
  { name: 'Claude Code', sub: 'агент Anthropic', icon: claudeIcon, group: 'term', ids: { claude: 'claude-code-cli' } },
  { name: 'Codex', sub: 'агент OpenAI, и в редакторах', icon: codexIcon, group: 'term', ids: { codex: 'openai-codex-cli' } },
  { name: 'OpenCode', sub: 'открытый агент', icon: opencodeIcon, group: 'term', ids: { claude: 'opencode', codex: 'openai-opencode' } },
  { name: 'Pi', sub: 'агент в терминале', icon: piIcon, group: 'term', ids: { claude: 'pi-cli', codex: 'openai-pi-cli' } },
  { name: 'Crush', sub: 'агент Charm', icon: crushIcon, group: 'term', ids: { claude: 'crush', codex: 'openai-crush' } },
  {
    name: 'Qwen Code',
    sub: 'агент в терминале',
    icon: qwenIcon,
    group: 'term',
    ids: { claude: 'anthropic-qwen-code', codex: 'openai-qwen-code' },
  },
  { name: 'VS Code', sub: 'расширение Claude Code', icon: vscodeIcon, group: 'editor', ids: { claude: 'vscode' } },
  { name: 'Cursor', sub: 'расширение Claude Code', icon: cursorIcon, group: 'editor', ids: { claude: 'cursor' } },
  { name: 'Windsurf', sub: 'расширение Claude Code', icon: windsurfIcon, group: 'editor', ids: { claude: 'windsurf' } },
  {
    name: 'JetBrains',
    sub: 'плагин Claude Code — общее подключение с Claude Code',
    icon: jetbrainsIcon,
    group: 'editor',
    // Плагин запускает тот же claude: переключатель — это подключение Claude Code, и они двигаются вместе.
    ids: { claude: 'claude-code-cli' },
    when: () => s.jetbrains,
  },
  {
    name: 'Neovim',
    sub: 'плагин avante.nvim',
    icon: neovimIcon,
    group: 'editor',
    ids: { claude: 'neovim-avante', codex: 'openai-neovim-avante' },
  },
];
const FAMILY_LABEL: Record<Family, string> = { claude: 'Claude', codex: 'GPT' };

const s = {
  phase: 'loading' as Phase,
  steps: new Map<StepId, StepState>(),
  pfWanted: true,
  clients: [] as ClientInfo[],
  wanted: {} as Record<string, boolean>,
  running: new Set<string>(),
  results: {} as Record<string, ClientResult>,
  error: '',
  copied: false,
  email: null as string | null,
  name: '',
  photo: '',
  hasKey: false,
  jetbrains: false,
  needLogin: false,
  authMode: 'login' as AuthMode,
  authError: '',
  authInfo: '',
  authBusy: false,
  /** Новая версия самого установщика: плашка «Обновить» над списком. */
  update: null as InstallerUpdate | null,
  updateState: 'idle' as 'idle' | 'downloading' | 'opened' | 'relaunching' | 'error',
  updateProgress: 0,
  updateText: '',
  /** Окно хода настройки: что делаем в этом запуске; null — окна нет. */
  job: null as null | { env: StepId[]; pf: boolean; enable: string[]; disable: string[]; done: boolean },
  stage: {} as Record<string, NonNullable<ConnectProgress['stage']>>,
  finished: {} as Record<string, 'done' | 'failed'>,
};

/** Документы для согласия при регистрации — те же, что в PurpleFlow и на app.purpleschool.ru. */
const LEGAL = {
  agreement: 'https://purpleschool.ru/user_agreement.pdf',
  oferta: 'https://purpleschool.ru/oferta.pdf',
  data: 'https://purpleschool.ru/data_consent.pdf',
};
const MIN_PASSWORD = 8;

/** Чем модели через PurpleSchool лучше своих подписок — как на экране входа PurpleFlow. */
const BENEFITS = [
  { title: 'Без VPN', text: 'Claude и GPT работают из России напрямую.' },
  { title: 'Оплата в рублях', text: 'Российские карты и СБП — зарубежная карта не нужна.' },
  { title: 'Один ключ на всё', text: 'Общий баланс токенов для всех агентов и редакторов.' },
];

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const step = (id: StepId): StepState => s.steps.get(id) ?? { id, status: 'unknown' };
const isOk = (x: StepState) => x.status === 'ok' || x.status === 'done';
const version = (x: StepState) => (x.detail && /^\d/.test(x.detail) ? x.detail : '');

const pfInstalled = () => isOk(step('purpleflow'));
const signedIn = () => Boolean(s.email) || (s.hasKey && !s.needLogin);
const changes = () => ({
  enable: s.clients.filter((c) => s.wanted[c.id] && !c.configured).map((c) => c.id),
  disable: s.clients.filter((c) => !s.wanted[c.id] && c.configured).map((c) => c.id),
});
const envPending = () => (['node', 'git'] as StepId[]).some((id) => !isOk(step(id)));
const pfPending = () => s.pfWanted && !pfInstalled();

function mark(st: 'ok' | 'err' | 'spin' | 'todo'): string {
  if (st === 'ok') return '<span class="mark ok">✓</span>';
  if (st === 'err') return '<span class="mark err">!</span>';
  if (st === 'spin') return '<span class="mark spin"></span>';
  return '<span class="mark todo"></span>';
}

function envRow(id: StepId, title: string): string {
  const x = step(id);
  const v = version(x);
  const text =
    x.status === 'unknown'
      ? 'проверяем…'
      : isOk(x)
        ? v || 'есть'
        : x.status === 'missing'
          ? 'поставим'
          : (x.detail ?? (x.status === 'running' ? 'ставим…' : 'не получилось'));
  const m = isOk(x) ? 'ok' : x.status === 'failed' ? 'err' : x.status === 'missing' ? 'todo' : 'spin';
  return `<div class="req ${x.status}">${mark(m)}<span class="req-name">${title}</span><span class="req-status" title="${esc(x.detail ?? '')}">${esc(text)}</span></div>`;
}

/**
 * Переключатель справа в строке — тот же, что в настройках PurpleFlow (.switch). Он и есть состояние:
 * включён — подключено, выключен — нет. Обводка — изменение ещё не применено, пульс — идёт настройка.
 */
function toggle(target: string, label: string, on: boolean, o: { disabled?: boolean; pending?: boolean; busy?: boolean } = {}): string {
  const cls = ['switch', on && 'is-on', o.pending && 'is-pending', o.busy && 'is-busy'].filter(Boolean).join(' ');
  return `<button type="button" role="switch" aria-checked="${on}" class="${cls}" data-act="toggle" data-target="${target}" ${o.disabled ? 'disabled' : ''}><i></i><span>${label}</span></button>`;
}

function pfRow(): string {
  const x = step('purpleflow');
  const installed = pfInstalled();
  const running = x.status === 'running';
  const pct = running && x.progress != null ? Math.round(x.progress * 100) : null;
  const sub = installed && version(x) ? `штаб для ИИ-агентов · ${version(x)}` : 'штаб для ИИ-агентов';
  return `
    <div class="tool ${!installed && !s.pfWanted ? 'dim' : ''}">
      <img class="ticon" src="${logo}" alt="" />
      <div class="cbody">
        <div class="cname">PurpleFlow<span class="chint">${sub}</span></div>
        ${running ? `<span class="cstatus">${esc(x.detail ?? 'Устанавливаем…')}</span>` : ''}
        ${pct != null ? `<div class="bar"><div style="width:${pct}%"></div></div>` : ''}
        ${x.status === 'failed' ? `<span class="cstatus err">${esc(x.detail ?? 'Не получилось установить')}</span>` : ''}
      </div>
      <div class="pills">${toggle('pf', installed ? 'Установлен' : 'Установить', installed || s.pfWanted, {
        disabled: s.phase !== 'ready' || installed,
        pending: !installed && s.pfWanted,
        busy: running,
      })}</div>
    </div>`;
}

function toolRow(t: Tool, present: [Family, ClientInfo][]): string {
  const two = present.length > 1;
  // Под названием — только то, что требует внимания: ошибка настройки.
  const errors = present
    .map(([f, c]) => [f, s.results[c.id]] as const)
    .filter(([, r]) => r && !r.ok)
    .map(([f, r]) => `<span class="cstatus err">${two ? `${FAMILY_LABEL[f]}: ` : ''}${esc(r!.error ?? 'не получилось')}</span>`);
  const off = present.every(([, c]) => !s.wanted[c.id] && !c.configured);
  const missing = present.every(([, c]) => !c.installed);
  const willInstall = missing && present.some(([, c]) => s.wanted[c.id]);
  return `
    <div class="tool ${off ? 'dim' : ''}">
      <img class="ticon" src="${t.icon}" alt="" />
      <div class="cbody">
        <div class="cname">${t.name}<span class="chint">${t.sub}${missing ? ' · не установлен' : ''}</span></div>
        ${willInstall && !errors.length ? '<span class="cstatus pending">Поставим и подключим</span>' : ''}
        ${errors.join('')}
      </div>
      <div class="pills">${present
        .map(([f, c]) =>
          toggle(c.id, FAMILY_LABEL[f], Boolean(s.wanted[c.id]), {
            disabled: s.phase !== 'ready',
            pending: s.phase === 'ready' && Boolean(s.wanted[c.id]) !== c.configured,
            busy: s.running.has(c.id),
          }),
        )
        .join('')}</div>
    </div>`;
}

function toolGroup(group: Tool['group']): string {
  return TOOLS.filter((t) => t.group === group && (t.when?.() ?? true))
    .map((t) => {
      const present = (Object.entries(t.ids) as [Family, string][])
        .map(([f, id]) => [f, s.clients.find((c) => c.id === id)] as const)
        .filter((x): x is [Family, ClientInfo] => Boolean(x[1]));
      return present.length ? toolRow(t, present) : '';
    })
    .join('');
}

const benefits = () => `<ul class="benefits">${BENEFITS.map((b) => `<li><b>${b.title}</b>${b.text}</li>`).join('')}</ul>`;

/** Правая панель: аккаунт PurpleSchool. Вход нужен только для подключения моделей — установка работает и без него. */
function side(): string {
  if (s.email || (s.hasKey && !s.needLogin)) {
    return `
      <div class="acc">
        <h2>Аккаунт PurpleSchool</h2>
        ${
          s.email
            ? `<div class="acc-profile">
                 <span class="acc-avatar" aria-hidden="true">${s.photo ? `<img src="${esc(s.photo)}" alt="" />` : esc((s.name || s.email).trim().charAt(0).toUpperCase())}</span>
                 <div class="acc-profile-text"><strong>${esc(s.name || s.email)}</strong><span>${s.name ? esc(s.email) : 'Аккаунт PurpleSchool'}</span></div>
                 <button class="btn btn-quiet" data-act="logout">Выйти</button>
               </div>`
            : `<div class="acc-profile">
                 <div class="acc-profile-text"><strong>Ключ уже на компьютере</strong><span>Подключения используют его</span></div>
                 <button class="btn btn-quiet" data-act="logout">Другой аккаунт</button>
               </div>`
        }
        <p class="auth-sub">Включённые слева приложения подключатся к моделям PurpleSchool с ключом этого аккаунта.</p>
      </div>
      ${benefits()}`;
  }
  const m = s.authMode;
  const title = m === 'login' ? 'Вход в PurpleSchool' : m === 'register' ? 'Регистрация в PurpleSchool' : 'Восстановление пароля';
  const field = (label: string, input: string, aside = '', hint = '') =>
    `<label class="field"><span class="field-head"><span class="field-label">${label}</span>${aside}</span>${input}${hint ? `<span class="field-hint">${hint}</span>` : ''}</label>`;
  const legal = (href: string, text: string) => `<a class="link" href="${href}" target="_blank" rel="noreferrer">${text}</a>`;
  return `
    <form class="auth" data-form="auth" novalidate>
      <h2>${title}</h2>
      ${
        m === 'restore'
          ? '<p class="auth-sub">Пришлём ссылку для смены пароля. Пароль меняется на сайте PurpleSchool, затем возвращайтесь и входите здесь.</p>'
          : '<p class="auth-sub">Нужен, чтобы подключить модели PurpleSchool. Ключ подставится сам.</p>'
      }
      ${m === 'register' ? field('Имя', '<input class="input" name="name" autocomplete="name" spellcheck="false" />') : ''}
      ${field('Email', '<input class="input" name="email" type="email" autocomplete="email" placeholder="name@mail.ru" spellcheck="false" />')}
      ${
        m === 'restore'
          ? ''
          : field(
              'Пароль',
              `<input class="input" name="password" type="password" autocomplete="${m === 'login' ? 'current-password' : 'new-password'}" />`,
              m === 'login' ? '<button type="button" class="link auth-aside" data-act="mode-restore">Забыли пароль?</button>' : '',
              m === 'register' ? `Не короче ${MIN_PASSWORD} символов` : '',
            )
      }
      ${
        m === 'register'
          ? `<div class="auth-checks">
               <label class="auth-check"><input type="checkbox" name="agreed" /><span>Согласен с ${legal(LEGAL.agreement, 'Пользовательским соглашением')} и ознакомлен с ${legal(LEGAL.oferta, 'Правилом оказания услуг')} и ${legal(LEGAL.data, 'Обработкой данных')}</span></label>
               <label class="auth-check"><input type="checkbox" name="mailing" /><span>Согласен на получение рекламных рассылок</span></label>
             </div>`
          : ''
      }
      ${s.authError ? `<p class="auth-error" role="alert">${esc(s.authError)}</p>` : ''}
      ${s.authInfo ? `<p class="auth-notice" role="status">${esc(s.authInfo)}</p>` : ''}
      <button class="btn btn-primary btn-wide" type="submit" ${s.authBusy ? 'disabled' : ''}>${s.authBusy ? '<span class="spinner"></span>' : ''}<span>${m === 'login' ? 'Войти' : m === 'register' ? 'Зарегистрироваться' : 'Отправить ссылку'}</span></button>
      <p class="auth-switch">${
        m === 'login'
          ? 'Нет аккаунта? <button type="button" class="link" data-act="mode-register">Зарегистрироваться</button>'
          : `${m === 'register' ? 'Уже есть аккаунт?' : 'Вспомнили пароль?'} <button type="button" class="link" data-act="mode-login">Войти</button>`
      }</p>
    </form>
    ${benefits()}`;
}

function footer(): string {
  const { enable, disable } = changes();
  const pending = envPending() || pfPending() || enable.length > 0 || disable.length > 0;
  const failed = [...s.steps.values()].some((x) => x.status === 'failed') || Object.values(s.results).some((r) => !r.ok);
  const links = failed
    ? `<div class="links">
         <button class="link" data-act="report">${s.copied ? 'Отчёт скопирован' : 'Скопировать отчёт'}</button>
         ${step('purpleflow').status === 'failed' ? '<button class="link" data-act="downloads">Скачать PurpleFlow вручную</button>' : ''}
       </div>`
    : '';
  const btn = (label: string, act = '', disabled = false, busy = false) =>
    `<button class="btn btn-primary btn-wide" ${act ? `data-act="${act}"` : ''} ${disabled ? 'disabled' : ''}>${busy ? '<span class="spinner"></span>' : ''}<span>${label}</span></button>`;
  const error = s.error ? `<p class="note err">${esc(s.error)}</p>` : '';
  if (s.phase === 'loading') return btn('Проверяем компьютер…', '', true, true);
  if (s.phase === 'busy') return btn('Настраиваем…', '', true, true);
  if (pending) {
    const onlyRemoval = !envPending() && !pfPending() && enable.length === 0;
    const needAuth = enable.length > 0 && !signedIn();
    return `
      ${error}
      ${needAuth ? '<p class="note">Войдите в аккаунт PurpleSchool справа, чтобы подключить модели.</p>' : ''}
      ${btn(onlyRemoval ? 'Применить' : 'Настроить', 'apply', needAuth)}${links}`;
  }
  if (pfInstalled()) return `${error}${btn('Открыть PurpleFlow', 'launch')}${links}`;
  return `${error}${btn('Всё настроено', '', true)}${links}`;
}

/** «Claude Code», «OpenCode · GPT» — как строка и переключатель на экране. */
function clientLabel(id: string): string {
  for (const t of TOOLS) {
    const entry = (Object.entries(t.ids) as [Family, string][]).find(([, x]) => x === id);
    if (entry) return Object.keys(t.ids).length > 1 ? `${t.name} · ${FAMILY_LABEL[entry[0]]}` : t.name;
  }
  return s.clients.find((c) => c.id === id)?.title ?? id;
}

const STAGE_TEXT: Record<NonNullable<ConnectProgress['stage']>, string> = {
  queued: 'в очереди',
  check: 'проверяем и устанавливаем',
  model: 'проверяем ключ и подбираем модель',
  write: 'записываем настройки',
  remove: 'убираем подключение',
};

type TaskState = 'wait' | 'run' | 'ok' | 'err';
interface Task {
  key: string;
  icon: string;
  title: string;
  state: TaskState;
  text: string;
  progress?: number;
}

function stepTask(id: StepId, icon: string, title: string): Task {
  return { key: id, ...stepTaskState(id, icon, title) };
}

function stepTaskState(id: StepId, icon: string, title: string): Omit<Task, 'key'> {
  const x = step(id);
  if (isOk(x)) return { icon, title, state: 'ok', text: x.status === 'done' ? 'установлен' : 'уже есть' };
  if (x.status === 'failed') return { icon, title, state: 'err', text: x.detail ?? 'не получилось' };
  if (x.status === 'running' || x.status === 'waiting')
    return { icon, title, state: 'run', text: x.detail ?? 'устанавливаем', progress: x.progress };
  return { icon, title, state: 'wait', text: 'в очереди' };
}

function clientTask(id: string, removing: boolean): Task {
  return { key: id, ...clientTaskState(id, removing) };
}

function clientTaskState(id: string, removing: boolean): Omit<Task, 'key'> {
  const t = TOOLS.find((x) => Object.values(x.ids).includes(id));
  const icon = t?.icon ?? logo;
  const title = clientLabel(id);
  const r = s.results[id];
  const fin = s.finished[id];
  if (r && !r.ok) return { icon, title, state: 'err', text: r.error ?? 'не получилось' };
  if (r?.ok || fin === 'done')
    return { icon, title, state: 'ok', text: removing ? 'отключено' : `подключено${r?.model ? ` · ${r.model}` : ''}` };
  if (fin === 'failed') return { icon, title, state: 'err', text: 'не получилось' };
  if (s.job?.done) return { icon, title, state: 'err', text: s.error || 'не выполнено' };
  const st = s.stage[id];
  return { icon, title, state: st && st !== 'queued' ? 'run' : 'wait', text: st ? STAGE_TEXT[st] : removing ? 'отключим' : 'подключим' };
}

function jobTasks(): Task[] {
  const j = s.job!;
  return [
    ...j.env.map((id) => (id === 'node' ? stepTask(id, nodeIcon, 'Node.js') : stepTask(id, gitIcon, 'Git'))),
    ...(j.pf ? [stepTask('purpleflow', logo, 'PurpleFlow')] : []),
    ...j.enable.map((id) => clientTask(id, false)),
    ...j.disable.map((id) => clientTask(id, true)),
  ];
}

let overlay: HTMLElement | null = null;
const shown = { badge: '', actions: '' };

const MARK: Record<TaskState, string> = {
  ok: '<span class="mark ok">✓</span>',
  err: '<span class="mark err">!</span>',
  run: '<span class="spinner"></span>',
  wait: '<span class="mark todo"></span>',
};

function setText(el: Element, text: string) {
  if (el.textContent !== text) el.textContent = text;
}

/**
 * Окно хода настройки — поверх экрана. Создаётся один раз и дальше только обновляется по месту: при полной
 * перерисовке на каждое событие окно заново въезжало, а значки начинали крутиться сначала — всё мерцало.
 */
function renderModal() {
  if (!s.job) {
    overlay?.remove();
    overlay = null;
    shown.badge = shown.actions = '';
    return;
  }
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-live="polite">
        <div class="modal-head"><span class="modal-badge"></span><div><h2></h2><p></p></div></div>
        <ul class="tasks"></ul>
        <div class="modal-actions"></div>
      </div>`;
    document.body.append(overlay);
  }
  const tasks = jobTasks();
  const failed = tasks.filter((t) => t.state === 'err').length;
  const { done, enable, disable } = s.job;
  const onlyRemoval = !s.job.env.length && !s.job.pf && !enable.length;
  const title = !done ? 'Настраиваем…' : failed ? 'Почти готово' : onlyRemoval ? 'Подключения убраны' : 'Готово';
  const sub = !done
    ? 'Окно можно не трогать: всё произойдёт само.'
    : failed
      ? `Не получилось: ${failed} из ${tasks.length}. Причина — у пункта ниже.`
      : enable.length && disable.length
        ? 'Новые подключения работают, лишние сняты.'
        : enable.length
          ? 'Всё настроено и подключено к моделям PurpleSchool.'
          : disable.length
            ? 'Подключения к PurpleSchool сняты, приложения остались на месте.'
            : 'Всё установлено.';
  setText(overlay.querySelector('h2')!, title);
  setText(overlay.querySelector('.modal-head p')!, sub);

  const badge = !done ? 'run' : failed ? 'err' : 'ok';
  if (shown.badge !== badge) {
    shown.badge = badge;
    const el = overlay.querySelector('.modal-badge')!;
    el.className = `modal-badge ${badge}`;
    el.innerHTML = badge === 'run' ? '<span class="spinner"></span>' : badge === 'ok' ? '✓' : '!';
  }

  const list = overlay.querySelector('.tasks')!;
  for (const t of tasks) {
    let li = list.querySelector<HTMLElement>(`li[data-key="${t.key}"]`);
    if (!li) {
      li = document.createElement('li');
      li.dataset.key = t.key;
      li.innerHTML = `<img class="task-icon" alt="" /><div class="task-body"><span class="task-title"></span><span class="task-text"></span><div class="bar" hidden><div></div></div></div><span class="task-mark"></span>`;
      li.querySelector('img')!.src = t.icon;
      list.append(li);
    }
    // Значок меняем только при смене состояния: так спиннер крутится непрерывно, а галочка «выскакивает» один раз.
    if (li.dataset.state !== t.state) {
      li.dataset.state = t.state;
      li.className = `task ${t.state}`;
      li.querySelector('.task-mark')!.innerHTML = MARK[t.state];
    }
    setText(li.querySelector('.task-title')!, t.title);
    setText(li.querySelector('.task-text')!, t.text);
    const bar = li.querySelector<HTMLElement>('.bar')!;
    const pct = t.state === 'run' && t.progress != null ? Math.round(t.progress * 100) : null;
    bar.hidden = pct == null;
    if (pct != null) (bar.firstElementChild as HTMLElement).style.width = `${pct}%`;
  }

  const actions = done
    ? `${s.job.pf && pfInstalled() && !failed ? '<button class="btn btn-ghost" data-act="launch">Открыть PurpleFlow</button>' : ''}<button class="btn btn-primary" data-act="close-job">ОК</button>`
    : '';
  if (shown.actions !== actions) {
    shown.actions = actions;
    overlay.querySelector('.modal-actions')!.innerHTML = actions;
  }
}

/** Пока идёт настройка, экран под окном закрыт — перерисовываем только окно. */
function update() {
  if (s.job && !s.job.done) renderModal();
  else render();
}

function updateBanner(): string {
  const u = s.update;
  if (!u) return '';
  const st = s.updateState;
  const text =
    st === 'downloading'
      ? `Скачиваем${s.updateProgress ? ` · ${Math.round(s.updateProgress * 100)}%` : '…'}`
      : st === 'relaunching'
        ? 'Запускаем новую версию…'
        : st === 'opened'
          ? 'Открыли её из «Загрузок» — установите и запустите новую версию.'
          : st === 'error'
            ? s.updateText
            : 'В ней свежие настройки подключений. Обновление займёт минуту.';
  const action =
    st === 'idle'
      ? '<button class="btn btn-primary" data-act="self-update">Обновить</button>'
      : st === 'error'
        ? '<button class="btn btn-ghost" data-act="self-update">Ещё раз</button><button class="link small" data-act="update-page">Скачать вручную</button>'
        : st === 'downloading'
          ? '<span class="spinner"></span>'
          : '';
  return `
    <div class="upd ${st}">
      <div class="upd-body">
        <b>Новая версия установщика · ${esc(u.version)}</b>
        <span class="${st === 'error' ? 'err' : ''}">${esc(text)}</span>
        ${st === 'downloading' ? `<div class="bar"><div style="width:${Math.round(s.updateProgress * 100)}%"></div></div>` : ''}
      </div>
      <div class="upd-actions">${action}</div>
    </div>`;
}

function render() {
  const form = root.querySelector<HTMLFormElement>('form[data-form="auth"]');
  const saved = form ? Object.fromEntries(new FormData(form)) : {};
  const scroll = root.querySelector('.scroll')?.scrollTop ?? 0;
  const term = toolGroup('term');
  const editors = toolGroup('editor');
  root.innerHTML = `
    <section class="setup">
      <header class="drag">
        <h1>Установщик PurpleFlow</h1>
        <p class="lead">Включите, что поставить и подключить к моделям PurpleSchool, и нажмите «Настроить». Выключите — подключение уберётся. Терминал не понадобится.</p>
      </header>
      ${updateBanner()}
      <div class="scroll">
        <div class="reqs"><span class="reqs-title">Обязательно</span>${envRow('node', 'Node.js')}${envRow('git', 'Git')}</div>
        <div class="section">Приложение</div>
        <div class="rows">${pfRow()}</div>
        ${term ? `<div class="section">В терминале</div><div class="rows">${term}</div>` : ''}
        ${editors ? `<div class="section">Редакторы</div><div class="rows">${editors}</div>` : ''}
        ${s.phase === 'loading' ? '<p class="note"><span class="spinner"></span> Ищем приложения…</p>' : ''}
      </div>
      <footer>${footer()}</footer>
    </section>
    <aside class="side">${side()}</aside>`;
  root.querySelector('.scroll')!.scrollTop = scroll;
  const next = root.querySelector<HTMLFormElement>('form[data-form="auth"]');
  if (next) {
    for (const [k, v] of Object.entries(saved)) {
      const el = next.elements.namedItem(k) as HTMLInputElement | null;
      if (el?.type === 'checkbox') el.checked = v === 'on';
      else if (el && typeof v === 'string') el.value = v;
    }
  }
  renderModal();
}

async function load() {
  render();
  const [, scan, acc] = await Promise.all([api.check(), api.connect.scan(), api.account.state()]);
  s.email = acc.email;
  s.name = acc.name;
  s.photo = acc.photo;
  if (scan.type === 'scan') {
    s.clients = scan.clients;
    s.hasKey = scan.hasKey;
    s.jetbrains = scan.jetbrains;
    s.wanted = Object.fromEntries(scan.clients.map((c) => [c.id, c.configured]));
  } else if (scan.type === 'error') s.error = scan.error;
  s.pfWanted = !pfInstalled();
  s.phase = 'ready';
  render();
}

async function apply() {
  const { enable, disable } = changes();
  s.phase = 'busy';
  s.error = '';
  s.copied = false;
  s.results = {};
  s.running = new Set([...enable, ...disable]);
  s.stage = {};
  s.finished = {};
  s.job = { env: (['node', 'git'] as StepId[]).filter((id) => !isOk(step(id))), pf: pfPending(), enable, disable, done: false };
  render();
  const r = await api.apply({ purpleflow: pfPending(), enable, disable });
  s.running.clear();
  if (r.connect?.type === 'apply') {
    for (const res of r.connect.results) {
      s.results[res.id] = res;
      const c = s.clients.find((x) => x.id === res.id);
      if (c && res.ok) c.configured = enable.includes(res.id);
      if (res.needLogin) s.needLogin = true;
    }
  } else if (r.connect?.type === 'error') s.error = `Настройка прервалась: ${r.connect.error}`;
  // Галочки — по тому, что на самом деле записано на диске, а не по ожиданию.
  if (enable.length || disable.length) {
    const scan = await api.connect.scan();
    if (scan.type === 'scan') {
      s.clients = scan.clients;
      s.hasKey = scan.hasKey;
    }
  }
  // Что не получилось, остаётся в прежнем положении — переключатель не врёт о состоянии.
  s.wanted = Object.fromEntries(s.clients.map((c) => [c.id, c.configured]));
  // Не встал PurpleFlow — переключатель остаётся включённым: «Настроить» попробует снова.
  s.pfWanted = s.pfWanted && !pfInstalled();
  s.phase = 'ready';
  if (s.job) s.job.done = true;
  render();
}

async function auth(form: HTMLFormElement) {
  const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
  const mail = (f.email ?? '').trim().toLowerCase();
  const fail = (text: string) => {
    s.authError = text;
    s.authInfo = '';
    render();
  };
  // Те же проверки, что в форме PurpleFlow: понятная ошибка до запроса.
  if (!/^\S+@\S+\.\S+$/.test(mail)) return fail('Введите email полностью, например name@mail.ru');
  if (s.authMode === 'register') {
    if (!(f.name ?? '').trim()) return fail('Как к вам обращаться? Введите имя');
    if ((f.password ?? '').length < MIN_PASSWORD) return fail(`Пароль — не короче ${MIN_PASSWORD} символов`);
    if (f.agreed !== 'on') return fail('Отметьте согласие с пользовательским соглашением');
  }
  if (s.authMode === 'login' && !f.password) return fail('Введите пароль');
  s.authBusy = true;
  s.authError = s.authInfo = '';
  render();
  if (s.authMode === 'restore') {
    const r = await api.account.restore(mail);
    s.authBusy = false;
    if (r.ok) s.authInfo = r.message ?? 'Письмо отправлено.';
    else s.authError = r.error;
    render();
    return;
  }
  const r =
    s.authMode === 'register'
      ? await api.account.register({ name: f.name ?? '', email: mail, password: f.password ?? '', mailing: f.mailing === 'on' })
      : await api.account.login(mail, f.password ?? '');
  s.authBusy = false;
  if (r.ok) {
    const acc = await api.account.state();
    s.email = acc.email;
    s.name = acc.name;
    s.photo = acc.photo;
    s.needLogin = false;
  } else {
    s.authError = r.error;
    if (r.code === 'exists') s.authMode = 'login';
  }
  render();
}

// Окно хода настройки живёт вне #root — клики слушаем на всём документе.
document.addEventListener('click', async (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  const act = t?.dataset.act;
  if (!act) return;
  if (act === 'self-update') {
    s.updateState = 'downloading';
    s.updateProgress = 0;
    render();
    const r = await api.selfUpdate.apply();
    if (r.ok) s.updateState = r.relaunched ? 'relaunching' : 'opened';
    else {
      s.updateState = 'error';
      s.updateText = r.error;
    }
    render();
  } else if (act === 'update-page') {
    await api.selfUpdate.openPage();
  } else if (act === 'close-job') {
    s.job = null;
    render();
  } else if (act === 'toggle') {
    const id = t.dataset.target!;
    if (id === 'pf') s.pfWanted = !s.pfWanted;
    else {
      s.wanted[id] = !s.wanted[id];
      delete s.results[id];
    }
    render();
  } else if (act === 'apply') await apply();
  else if (act === 'launch') {
    const r = await api.launch();
    if (!r.ok) {
      s.error = `Не удалось открыть PurpleFlow: ${r.error ?? ''}`;
      render();
    }
  } else if (act === 'report') {
    await api.copyReport();
    s.copied = true;
    render();
  } else if (act === 'downloads') await api.openDownloads();
  else if (act === 'logout') {
    await api.account.logout();
    s.email = null;
    s.name = s.photo = '';
    s.needLogin = true;
    s.authMode = 'login';
    render();
  } else if (act.startsWith('mode-')) {
    s.authMode = act.slice(5) as AuthMode;
    s.authError = s.authInfo = '';
    render();
  }
});

root.addEventListener('submit', (e) => {
  e.preventDefault();
  void auth(e.target as HTMLFormElement);
});

api.onStep((x) => {
  s.steps.set(x.id, x);
  update();
});
api.connect.onProgress((p) => {
  if (p.status === 'running') {
    s.running.add(p.id);
    if (p.stage) s.stage[p.id] = p.stage;
  } else {
    s.running.delete(p.id);
    s.finished[p.id] = p.status;
  }
  update();
});

api.selfUpdate.onProgress((p) => {
  s.updateProgress = p;
  update();
});
// Проверка обновления не задерживает экран: плашка появится, когда ответит GitHub.
void api.selfUpdate.check().then((u) => {
  s.update = u;
  update();
});

void load();
