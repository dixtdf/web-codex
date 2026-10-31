import { contextBridge, ipcRenderer } from 'electron/renderer'
import type { IpcRendererEvent } from 'electron'
import type { NavigationPage, WebCodexApi } from '../shared/api'
import type { AppConfig, AuditLogEvent, LogServiceState, RuntimeSnapshot } from '../shared/types'

function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, value: T): void => callback(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: WebCodexApi = {
  getConfig: () => ipcRenderer.invoke('config:get'),
  getRuntime: () => ipcRenderer.invoke('runtime:get'),
  updateConfig: (patch) => ipcRenderer.invoke('config:update', patch),
  selectDirectory: () => ipcRenderer.invoke('dialog:select-directory'),
  createProject: (input) => ipcRenderer.invoke('project:create', input),
  updateProject: (id, patch) => ipcRenderer.invoke('project:update', id, patch),
  removeProject: (id) => ipcRenderer.invoke('project:remove', id),
  getProjectContext: (id) => ipcRenderer.invoke('project:context', id),
  saveProjectInstructions: (id, content) => ipcRenderer.invoke('project:save-instructions', id, content),
  openProject: (id) => ipcRenderer.invoke('project:open', id),
  startGateway: () => ipcRenderer.invoke('gateway:start'),
  stopGateway: () => ipcRenderer.invoke('gateway:stop'),
  startTunnel: () => ipcRenderer.invoke('tunnel:start'),
  stopTunnel: () => ipcRenderer.invoke('tunnel:stop'),
  saveMcpServer: (input) => ipcRenderer.invoke('mcp:save', input),
  removeMcpServer: (id) => ipcRenderer.invoke('mcp:remove', id),
  connectMcpServer: (id) => ipcRenderer.invoke('mcp:connect', id),
  disconnectMcpServer: (id) => ipcRenderer.invoke('mcp:disconnect', id),
  runShell: (input) => ipcRenderer.invoke('shell:run', input),
  stopShell: (id) => ipcRenderer.invoke('shell:stop', id),
  getConnectionInfo: () => ipcRenderer.invoke('connection:get'),
  emergencyStop: () => ipcRenderer.invoke('emergency-stop'),
  listLogs: (filter) => ipcRenderer.invoke('logs:list', filter),
  getLogState: () => ipcRenderer.invoke('logs:state'),
  exportLogs: () => ipcRenderer.invoke('logs:export'),
  openLogDirectory: () => ipcRenderer.invoke('logs:open-directory'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  onLogEvent: (callback) => subscribe<AuditLogEvent>('logs:event', callback),
  onLogState: (callback) => subscribe<LogServiceState>('logs:state', callback),
  onNavigate: (callback) => subscribe<NavigationPage>('app:navigate', callback),
  onRuntimeChange: (callback) => subscribe<RuntimeSnapshot>('runtime:change', callback),
  onConfigChange: (callback) => subscribe<AppConfig>('config:change', callback)
}

contextBridge.exposeInMainWorld('webCodex', api)