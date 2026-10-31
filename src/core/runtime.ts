import { EventEmitter } from 'node:events'
import { dirname, join } from 'node:path'
import type { AppConfig, RuntimeSnapshot } from '../shared/types'
import { TUNNEL_API_KEY_CONFIGURED } from '../shared/api'
import { ConfigStore } from './config-store'
import { ProjectService } from './project-service'
import { FileService } from './file-service'
import { ShellService } from './shell-service'
import { ProxyManager } from './proxy-manager'
import { McpHub } from './mcp-hub'
import { McpGateway } from './mcp-gateway'
import { TunnelManager } from './tunnel-manager'
import { ActivityLogger } from './activity-logger'
import { errorMessage } from './errors'
import type { SecretProtector } from './secret-protector'
import { UploadService } from './upload-service'

export class Runtime extends EventEmitter {
  readonly store: ConfigStore
  readonly logs: ActivityLogger
  readonly projects: ProjectService
  readonly files: FileService
  readonly shell: ShellService
  readonly proxy: ProxyManager
  readonly hub: McpHub
  readonly gateway: McpGateway
  readonly tunnel: TunnelManager
  readonly uploads: UploadService
  privileged = false

  constructor(configPath: string, protector?: SecretProtector) {
    super()
    this.store = new ConfigStore(configPath, protector)
    this.logs = new ActivityLogger(join(dirname(configPath), 'logs'), { secrets: () => this.auditSecrets() })
    this.projects = new ProjectService(this.store)
    this.files = new FileService(this.projects)
    this.shell = new ShellService(this.projects, this.logs)
    this.proxy = new ProxyManager(this.store, this.logs)
    this.hub = new McpHub(this.store, this.proxy, this.logs)
    this.uploads = new UploadService(join(dirname(configPath), 'uploads'), this.files, this.logs)
    this.gateway = new McpGateway({ store: this.store, projects: this.projects, files: this.files, shell: this.shell, hub: this.hub, uploads: this.uploads, logger: this.logs })
    this.tunnel = new TunnelManager(this.store, this.proxy, this.logs)
    const notify = (): void => {
      this.emit('change', this.snapshot())
    }
    this.store.on('change', () => {
      void this.proxy.detect().then(notify)
    })
    this.shell.on('change', notify)
    this.hub.on('change', notify)
    this.proxy.on('change', notify)
    this.tunnel.on('change', notify)
    this.logs.on('change', (event) => this.emit('log', event))
    this.logs.on('state', (state) => this.emit('log-state', state))
  }

  async initialize(): Promise<void> {
    await this.store.load()
    await this.uploads.initialize()
    await this.logs.initialize()
    this.logs.info({ category: 'app', action: 'runtime.initialized', message: 'Runtime initialized', origin: 'system', data: { platform: process.platform, arch: process.arch, versions: { electron: process.versions.electron, node: process.version } } })
    this.logs.info({ category: 'security', action: 'security.secrets_storage', message: 'Secret storage initialized', origin: 'system', data: { mode: this.store.protectionState().mode, persistent: this.store.protectionState().persistent } })
    await this.proxy.detect()
    await this.tunnel.checkClient()
  }

  async start(): Promise<void> {
    this.logs.info({ category: 'app', action: 'runtime.start', message: 'Starting local runtime', origin: 'system', status: 'started' })
    try {
      await this.proxy.start()
      if (this.store.get().gateway.autoStart) await this.gateway.start()
      await this.hub.start()
      if (this.store.get().tunnel.autoStart) await this.tunnel.start()
      this.logs.info({ category: 'app', action: 'runtime.started', message: 'Local runtime started', origin: 'system', status: 'success' })
      this.emit('change', this.snapshot())
    } catch (error) {
      this.logs.error({ category: 'app', action: 'runtime.start_failed', message: 'Local runtime failed to start', origin: 'system', data: { error: errorMessage(error) } })
      throw error
    }
  }

  async stop(): Promise<void> {
    this.logs.info({ category: 'app', action: 'runtime.stop', message: 'Stopping local runtime', origin: 'system', status: 'started' })
    await this.tunnel.stop()
    await this.hub.stop()
    await this.shell.stopAll()
    await this.gateway.stop()
    await this.proxy.stop()
    await this.store.flush()
    this.logs.info({ category: 'app', action: 'runtime.stopped', message: 'Local runtime stopped', origin: 'system', status: 'stopped' })
    await this.logs.flush()
  }

  async emergencyStop(): Promise<void> {
    this.logs.warn({ category: 'security', action: 'emergency.started', message: 'Emergency stop requested', status: 'started' })
    try {
      await this.tunnel.stop()
      await this.gateway.stop()
      await this.shell.stopAll()
      this.logs.warn({ category: 'security', action: 'emergency.stopped', message: 'Remote access stopped and shell tasks terminated', status: 'stopped' })
      this.emit('change', this.snapshot())
    } catch (error) {
      this.logs.error({ category: 'security', action: 'emergency.failed', message: 'Emergency stop failed', data: { error: errorMessage(error) } })
      throw error
    }
  }

  updateConfig(patch: Partial<AppConfig>): AppConfig {
    const current = this.store.get()
    const normalized = patch.tunnel && (!patch.tunnel.apiKey.trim() || patch.tunnel.apiKey === TUNNEL_API_KEY_CONFIGURED)
      ? { ...patch, tunnel: { ...patch.tunnel, apiKey: current.tunnel.apiKey } }
      : patch
    this.logs.info({ category: 'config', action: 'config.update', message: 'Updating application configuration', data: { sections: Object.keys(patch) } })
    const updated = this.store.update(normalized)
    this.emit('change', this.snapshot())
    return updated
  }

  private auditSecrets(): string[] {
    const config = this.store.get()
    const values = [config.gateway.authToken, config.tunnel.apiKey]
    for (const server of config.mcpServers) {
      values.push(...Object.values(server.transport === 'stdio' ? server.env : server.headers))
    }
    return values
  }

  snapshot(): RuntimeSnapshot {
    return {
      gateway: this.gateway.getState(),
      tunnel: this.tunnel.getState(),
      proxy: this.proxy.getState(),
      tasks: this.shell.list(),
      mcpConnections: this.hub.states(),
      secrets: this.store.protectionState(),
      privileged: this.privileged
    }
  }
}