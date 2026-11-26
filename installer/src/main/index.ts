import path from 'node:path';
import { BrowserWindow, app, clipboard, ipcMain, shell } from 'electron';
import { loadLoginShellEnv } from '@core/env';
import { RELEASES_PAGE } from '../shared/manifest';
import type { ApplyRequest, ApplyResult, StepId, StepState } from '../shared/types';
import type { WorkerResponse } from '../shared/connect';
import * as account from './account';
import { runWorker } from './connect';
import { applyInstallerUpdate, checkInstallerUpdate, updatePage } from './selfupdate';
import { checkGit, checkNode, ensureGit, ensureNode } from './environment';
import { checkPurpleFlow, ensurePurpleFlow, launchPurpleFlow } from './purpleflow';

// Окружение login-шелла: из Finder приложение получает урезанный PATH и не увидело бы уже стоящие node и claude.
// Кладём его прямо в process.env: установки дописывают туда новые каталоги, а процесс настройки наследует
// то же окружение — тот же PATH, SHELL, CLAUDE_CONFIG_DIR и CODEX_HOME, что у нового терминала.
const env = Object.assign(process.env, loadLoginShellEnv());
const steps = new Map<StepId, StepState>();
let win: BrowserWindow | null = null;
let applying: Promise<ApplyResult> | null = null;

function emit(s: StepState) {
  steps.set(s.id, s);
  win?.webContents.send('installer:step', s);
}

async function check(): Promise<StepState[]> {
  const list = await Promise.all([checkPurpleFlow(), checkNode(env), checkGit(env)]);
  list.forEach(emit);
  return list;
}

const ids = (a: unknown) => (Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : []);

/**
 * Всё сразу и параллельно: PurpleFlow качается (самый долгий шаг), git на macOS ждёт системного окна,
 * а подключения ждут только Node.js — им нужен npm, чтобы поставить claude и codex.
 */
async function apply(req: ApplyRequest): Promise<ApplyResult> {
  const enable = ids(req?.enable);
  const disable = ids(req?.disable);
  let connect: WorkerResponse | undefined;
  await Promise.all([
    req?.purpleflow ? ensurePurpleFlow(emit) : Promise.resolve(true),
    ensureGit(env, emit),
    (async () => {
      await ensureNode(env, emit);
      if (enable.length || disable.length) {
        connect = await runWorker({ type: 'apply', apiKey: account.accountKey(), enable, disable }, (p) =>
          win?.webContents.send('connect:progress', p),
        );
        // Прокси не принял сохранённый ключ (отозван или удалён в кабинете) — забываем вход, окно попросит войти снова.
        if (connect.type === 'apply' && connect.results.some((r) => r.needLogin)) account.logout();
      }
    })(),
  ]);
  return { steps: [...steps.values()], connect };
}

function report(): string {
  const lines = [
    `Установщик PurpleFlow ${app.getVersion()}`,
    `${process.platform} ${process.arch}, ${process.getSystemVersion()}`,
    '',
    ...[...steps.values()].map((s) => `${s.id}: ${s.status}${s.detail ? ` — ${s.detail}` : ''}`),
  ];
  return lines.join('\n');
}

function createWindow() {
  win = new BrowserWindow({
    width: 940,
    height: 680,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'Установщик PurpleFlow',
    backgroundColor: '#0a0b0d',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => (win = null));
  // Ссылки (документы для согласия при регистрации) — во внешний браузер, окно никуда не уходит.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/(?:[\w-]+\.)*purpleschool\.ru\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

ipcMain.handle('installer:check', () => check());
ipcMain.handle('installer:apply', (_e, req: ApplyRequest) => {
  applying ??= apply(req).finally(() => (applying = null));
  return applying;
});
ipcMain.handle('installer:launch', async () => {
  const r = await launchPurpleFlow();
  if (r.ok) setTimeout(() => app.quit(), 1500);
  return r;
});
ipcMain.handle('installer:report', () => clipboard.writeText(report()));
ipcMain.handle('selfupdate:check', () => checkInstallerUpdate());
ipcMain.handle('selfupdate:apply', () => applyInstallerUpdate((p) => win?.webContents.send('selfupdate:progress', p)));
ipcMain.handle('selfupdate:page', () => shell.openExternal(updatePage()));
ipcMain.handle('installer:downloads', () => shell.openExternal(RELEASES_PAGE));
ipcMain.on('installer:quit', () => app.quit());

ipcMain.handle('connect:scan', () => runWorker({ type: 'scan' }));
ipcMain.handle('account:state', () => account.accountState());
ipcMain.handle('account:login', (_e, email: string, password: string) => account.login(String(email), String(password)));
ipcMain.handle('account:register', (_e, p: { name: string; email: string; password: string; mailing: boolean }) =>
  account.register({
    name: String(p?.name ?? ''),
    email: String(p?.email ?? ''),
    password: String(p?.password ?? ''),
    mailing: Boolean(p?.mailing),
  }),
);
ipcMain.handle('account:restore', (_e, email: string) => account.restore(String(email)));
ipcMain.handle('account:logout', () => account.logout());
ipcMain.handle('connect:cabinet', () => shell.openExternal('https://app.purpleschool.ru/'));

// Только для разработки: свой каталог данных — второй экземпляр для проверок рядом с открытым окном.
if (!app.isPackaged && process.env.PURPLEFLOW_INSTALLER_USER_DATA) app.setPath('userData', process.env.PURPLEFLOW_INSTALLER_USER_DATA);
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => win?.focus());
app.whenReady().then(() => {
  // В разработке Dock показывает значок Electron: подставляем свой. В сборке значок берётся из пакета.
  if (!app.isPackaged && process.platform === 'darwin') app.dock?.setIcon(path.join(__dirname, '../../build/icon-mac.png'));
  createWindow();
});
app.on('window-all-closed', () => app.quit());
