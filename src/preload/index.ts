// preload：向渲染进程暴露受控 API
import { contextBridge, ipcRenderer } from 'electron';
import type { Api, LogLine, Project, Settings, Status, SystemMetrics } from '../shared/types';

const api: Api = {
  listProjects: () => ipcRenderer.invoke('projects:list'),
  addProject: () => ipcRenderer.invoke('projects:add'),
  removeProject: (id) => ipcRenderer.invoke('projects:remove', id),
  updateProject: (id, patch) => ipcRenderer.invoke('projects:update', id, patch),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  start: (projectId) => ipcRenderer.invoke('run:start', projectId),
  stop: (projectId: string) => ipcRenderer.invoke('run:stop', projectId),
  stopAll: () => ipcRenderer.invoke('run:stopAll'),
  getStatus: () => ipcRenderer.invoke('status:get'),
  getLogs: () => ipcRenderer.invoke('logs:get'),
  pickDir: () => ipcRenderer.invoke('settings:pickDir'),
  ensureFirewall: () => ipcRenderer.invoke('system:firewall'),
  clearCache: () => ipcRenderer.invoke('system:clear-cache'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('system:setAutoLaunch', enabled),
  openUrl: (url) => ipcRenderer.invoke('shell:open', url),
  onStatus: (cb: (s: Status) => void) => {
    ipcRenderer.on('status:changed', (_e, s: Status) => cb(s));
  },
  onLog: (cb: (l: LogLine) => void) => {
    ipcRenderer.on('log:new', (_e, l: LogLine) => cb(l));
  },
  onMetrics: (cb: (m: SystemMetrics) => void) => {
    ipcRenderer.on('metrics:changed', (_e, m: SystemMetrics) => cb(m));
  },
};

const onProjectsChanged = (cb: (list: Project[]) => void): void => {
  ipcRenderer.on('projects:changed', (_e, list: Project[]) => cb(list));
};

contextBridge.exposeInMainWorld('api', api);
contextBridge.exposeInMainWorld('onProjectsChanged', onProjectsChanged);

declare global {
  interface Window {
    api: Api;
    onProjectsChanged: (cb: (list: Project[]) => void) => void;
  }
}
