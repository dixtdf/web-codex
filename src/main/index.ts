import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app, BrowserWindow, dialog, ipcMain, Menu, Tray } from 'electron/main'
import { nativeImage, shell } from 'electron/common'
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron'
import { Runtime } from '../core/runtime'
import { ElectronSecretProtector } from './electron-secret-protector'
import type { AppConfig, AuditLogFilter, LogCategory } from '../shared/types'
import { TUNNEL_API_KEY_CONFIGURED, type McpServerInput, type NavigationPage, type ProjectInput, type ShellRunInput } from '../shared/api'
const execFileAsync = promisify(execFile)
let mainWindow: Electron.BrowserWindow | null = null
let tray: Tray | null = null
let runtime: Runtime | undefined
let quitting = false

async function detectPrivileges(): Promise<boolean> {
  if (process.platform !== 'win32') return typeof process.getuid === 'function' && process.getuid() === 0
  try {
    const { stdout } = await execFileAsync('whoami.exe', ['/groups'], { windowsHide: true })
    return stdout.includes('S-1-16-12288')
  } catch {
    return false
  }
}

function broadcast(channel: string, value: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, value)
  }
}

function publicConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    tunnel: {
      ...config.tunnel,
      apiKey: config.tunnel.apiKey ? TUNNEL_API_KEY_CONFIGURED : ''
    }
  }
}

async function showMainWindow(page?: NavigationPage): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) await createWindow()
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  if (page) mainWindow.webContents.send('app:navigate', page)
}

function toggleMainWindow(): void {
  runtime?.logs.info({ category: 'app', action: 'tray.toggle_window', message: 'System tray toggle requested', origin: 'local' })
  if (mainWindow && mainWindow.isVisible()) mainWindow.hide()
  else void showMainWindow()
}

async function toggleTunnelFromTray(current: Runtime): Promise<void> {
  try {
    if (current.tunnel.getState().running) await current.tunnel.stop()
    else {
      if (!current.gateway.getState().running) await current.gateway.start()
      await current.tunnel.start()
    }
    broadcast('runtime:change', current.snapshot())
  } catch (error) {
    current.logs.error({ category: 'tunnel', action: 'tray.tunnel_failed', message: 'Tunnel action failed from system tray', data: { error: error instanceof Error ? error.message : String(error) } })
  } finally {
    refreshTrayMenu(current)
  }
}

function refreshTrayMenu(current: Runtime): void {
  if (!tray) return
  const snapshot = current.snapshot()
  const template: MenuItemConstructorOptions[] = [
    { label: snapshot.gateway.running ? 'Web Codex · 服务已就绪' : 'Web Codex · 服务已停止', enabled: false },
    { type: 'separator' },
    { label: '打开面板', click: () => void showMainWindow() },
    { label: '项目', click: () => void showMainWindow('projects') },
    { label: 'Tunnel 设置', click: () => void showMainWindow('tunnel') },
    { label: snapshot.tunnel.running ? '停止 Tunnel' : '启动 Tunnel', click: () => void toggleTunnelFromTray(current) },
    { label: '任务与日志', click: () => void showMainWindow('activity') },
    { type: 'separator' },
    { label: '紧急停止', click: () => { void current.emergencyStop().catch((error: unknown) => { current.logs.error({ category: 'security', action: 'tray.emergency_failed', message: 'Emergency stop failed from system tray', data: { error: error instanceof Error ? error.message : String(error) } }) }) } },
    { label: '退出 Web Codex', click: () => app.quit() }
  ]
  tray.setContextMenu(Menu.buildFromTemplate(template))
  tray.setToolTip(snapshot.tunnel.running ? 'Web Codex · Tunnel 运行中' : 'Web Codex')
}

function createTray(current: Runtime): void {
  if (tray) return
  const image = nativeImage.createFromPath(join(import.meta.dirname, '../../assets/icon-32.png'))
  tray = new Tray(image.resize({ width: 16, height: 16 }))
  tray.on('click', toggleMainWindow)
  tray.on('double-click', () => void showMainWindow())
  current.on('change', () => refreshTrayMenu(current))
  refreshTrayMenu(current)
  current.logs.info({ category: 'app', action: 'tray.created', message: 'System tray integration created', origin: 'system', data: { platform: process.platform } })
}

function registerIpc(current: Runtime): void {
  const categories: Record<string, LogCategory> = { config: 'config', dialog: 'app', project: 'project', gateway: 'gateway', tunnel: 'tunnel', mcp: 'mcp', shell: 'shell', connection: 'security', 'emergency-stop': 'security', app: 'app', runtime: 'app', logs: 'app' }
  const silent = new Set(['config:get', 'runtime:get', 'logs:list', 'logs:state'])
  const handle = <Args extends unknown[], Result>(channel: string, handler: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      const startedAt = Date.now()
      const category = categories[channel.split(':')[0]] ?? 'app'
      const method = channel.endsWith(':get') ? 'debug' : 'info'
      if (!silent.has(channel)) current.logs[method]({ category, action: `ipc.${channel}`, message: `Local IPC ${channel} started`, status: 'started', data: { channel, args } })
      try {
        const response = await handler(event, ...args as Args)
        if (!silent.has(channel)) current.logs[method]({ category, action: `ipc.${channel}.success`, message: `Local IPC ${channel} completed`, status: 'success', durationMs: Date.now() - startedAt, data: { channel } })
        return response
      } catch (error) {
        current.logs.error({ category, action: `ipc.${channel}.error`, message: `Local IPC ${channel} failed`, durationMs: Date.now() - startedAt, data: { channel, error: error instanceof Error ? error.message : String(error) } })
        throw error
      }
    })
  }
  handle('config:get', () => publicConfig(current.store.get()))
  handle('runtime:get', () => current.snapshot())
  handle('config:update', (_event, patch: Partial<AppConfig>) => publicConfig(current.updateConfig(patch)))
  handle('dialog:select-directory', async () => {
    if (!mainWindow) return null
    const selected = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] })
    return selected.canceled ? null : selected.filePaths[0] ?? null
  })
  handle('project:create', (_event, input: ProjectInput) => current.projects.create(input))
  handle('project:update', (_event, id: string, patch: Partial<ProjectInput>) => current.projects.update(id, patch))
  handle('project:remove', (_event, id: string) => current.projects.remove(id))
  handle('project:context', (_event, id: string) => current.projects.context(id))
  handle('project:save-instructions', (_event, id: string, content: string) => current.projects.saveInstructions(id, content))
  handle('project:open', async (_event, id: string) => {
    await shell.openPath(current.projects.get(id).path)
  })
  handle('gateway:start', async () => {
    await current.gateway.start()
    broadcast('runtime:change', current.snapshot())
  })
  handle('gateway:stop', () => current.gateway.stop())
  handle('tunnel:start', async () => {
    await current.tunnel.start()
    broadcast('runtime:change', current.snapshot())
  })
  handle('tunnel:stop', () => current.tunnel.stop())
  handle('mcp:save', (_event, input: McpServerInput) => current.hub.save(input))
  handle('mcp:remove', (_event, id: string) => current.hub.remove(id))
  handle('mcp:connect', async (_event, id: string) => {
    await current.hub.connect(id)
  })
  handle('mcp:disconnect', (_event, id: string) => current.hub.disconnect(id))
  handle('shell:run', (_event, input: ShellRunInput) => current.shell.run(input))
  handle('shell:stop', (_event, id: string) => current.shell.stop(id))
  handle('connection:get', () => ({
    localAddress: current.gateway.getState().address ?? '',
    publicUrl: current.tunnel.getState().publicUrl ?? current.store.get().tunnel.publicUrl,
    token: current.store.get().gateway.authToken,
    tunnelId: current.store.get().tunnel.tunnelId
  }))
  handle('emergency-stop', () => current.emergencyStop())
  handle('logs:list', (_event, filter?: AuditLogFilter) => current.logs.list(filter))
  handle('logs:state', () => current.logs.getState())
  handle('logs:export', async () => {
    if (!mainWindow) return null
    const selected = await dialog.showSaveDialog(mainWindow, {
      title: '导出审计日志',
      defaultPath: join(app.getPath('documents'), `web-codex-audit-${new Date().toISOString().slice(0, 10)}.jsonl`),
      filters: [{ name: 'JSONL 审计日志', extensions: ['jsonl'] }]
    })
    if (selected.canceled || !selected.filePath) return null
    const exported = await current.logs.exportTo(selected.filePath)
    current.logs.info({ category: 'app', action: 'logs.exported', message: 'Audit logs exported', status: 'success', data: { files: exported.files, destination: exported.destination } })
    return exported
  })
  handle('logs:open-directory', async () => {
    await shell.openPath(current.logs.directory)
  })
  handle('app:open-external', async (_event, url: string) => {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') throw new Error('Only HTTPS links can be opened')
    await shell.openExternal(parsed.toString())
  })
  current.on('change', (snapshot) => broadcast('runtime:change', snapshot))
  current.on('log', (event) => broadcast('logs:event', event))
  current.on('log-state', (state) => broadcast('logs:state', state))
  current.store.on('change', (config) => broadcast('config:change', publicConfig(config)))
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1060,
    minHeight: 700,
    show: false,
    backgroundColor: '#f4f6fa',
    title: 'Web Codex',
    icon: join(import.meta.dirname, '../../assets/icon-256.png'),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  mainWindow.once('ready-to-show', () => {
    if (!runtime?.store.get().ui.startMinimized) mainWindow?.show()
  })
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

if (!app.isPackaged) {
  app.setPath('userData', join(app.getPath('userData'), 'development'))
}

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    void showMainWindow()
  })
  app.whenReady().then(async () => {
    runtime = new Runtime(join(app.getPath('userData'), 'config.json'), new ElectronSecretProtector())
    await runtime.initialize()
    runtime.privileged = await detectPrivileges()
    runtime.logs.info({ category: 'security', action: 'runtime.privileges', message: runtime.privileged ? 'Administrator privileges detected' : 'Standard user privileges detected', origin: 'system', data: { privileged: runtime.privileged } })
    registerIpc(runtime)
    createTray(runtime)
    await createWindow()
    try {
      await runtime.start()
    } catch (error) {
      console.error('Runtime startup failed', error)
    }
    app.on('activate', () => void showMainWindow())
  }).catch((error: unknown) => {
    console.error('Application startup failed', error)
    dialog.showErrorBox('Web Codex', error instanceof Error ? error.message : String(error))
    app.quit()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('will-quit', () => {
    tray?.destroy()
    tray = null
  })
  app.on('before-quit', (event) => {
    if (quitting || !runtime) return
    event.preventDefault()
    quitting = true
    const forcedExit = setTimeout(() => app.exit(0), 10_000)
    forcedExit.unref()
    void runtime.stop().finally(() => {
      clearTimeout(forcedExit)
      app.quit()
    })
  })
}