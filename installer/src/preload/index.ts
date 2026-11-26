import { contextBridge, ipcRenderer } from 'electron';
import type { InstallerBridge, StepState } from '../shared/types';
import type { ConnectProgress } from '../shared/connect';

const bridge: InstallerBridge = {
  platform: process.platform,
  check: () => ipcRenderer.invoke('installer:check'),
  apply: (req) => ipcRenderer.invoke('installer:apply', req),
  launch: () => ipcRenderer.invoke('installer:launch'),
  copyReport: () => ipcRenderer.invoke('installer:report'),
  selfUpdate: {
    check: () => ipcRenderer.invoke('selfupdate:check'),
    apply: () => ipcRenderer.invoke('selfupdate:apply'),
    openPage: () => ipcRenderer.invoke('selfupdate:page'),
    onProgress(fn) {
      const h = (_: unknown, p: number) => fn(p);
      ipcRenderer.on('selfupdate:progress', h);
      return () => ipcRenderer.removeListener('selfupdate:progress', h);
    },
  },
  openDownloads: () => ipcRenderer.invoke('installer:downloads'),
  quit: () => ipcRenderer.send('installer:quit'),
  onStep(fn) {
    const h = (_: unknown, s: StepState) => fn(s);
    ipcRenderer.on('installer:step', h);
    return () => ipcRenderer.removeListener('installer:step', h);
  },
  connect: {
    scan: () => ipcRenderer.invoke('connect:scan'),
    onProgress(fn) {
      const h = (_: unknown, p: ConnectProgress) => fn(p);
      ipcRenderer.on('connect:progress', h);
      return () => ipcRenderer.removeListener('connect:progress', h);
    },
    openCabinet: () => ipcRenderer.invoke('connect:cabinet'),
  },
  account: {
    state: () => ipcRenderer.invoke('account:state'),
    login: (email, password) => ipcRenderer.invoke('account:login', email, password),
    register: (p) => ipcRenderer.invoke('account:register', p),
    restore: (email) => ipcRenderer.invoke('account:restore', email),
    logout: () => ipcRenderer.invoke('account:logout'),
  },
};

contextBridge.exposeInMainWorld('installer', bridge);
