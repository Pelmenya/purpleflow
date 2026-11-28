// eslint-disable-next-line @typescript-eslint/no-require-imports -- отдельная точка входа Electron без сборки обязана быть CommonJS.
const { app, BrowserWindow } = require('electron');

if (process.env.PURPLEFLOW_USER_DATA) app.setPath('userData', process.env.PURPLEFLOW_USER_DATA);

app.whenReady().then(() => {
  const window = new BrowserWindow({
    show: Boolean(process.env.PURPLEFLOW_E2E_SHOW),
    width: 1280,
    height: 900,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  void window.loadURL(process.env.PURPLEFLOW_WEB_URL);
});

app.on('window-all-closed', () => app.quit());
