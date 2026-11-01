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
import { GitService } from './git-service'
import { HostService } from './host-service'
import packageJson from '../../package.json'

function sanitizeEndpoint(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return value.replace(/\/\/[^/@\s]+@/, '//[REDACTED]@').replace(/([?&](?:token|key|code|state|session|secret)=)[^&\s]+/gi, '$1[REDACTED]')
  }
}

async function runAll(operations: Array<() => Promise<unknown>>): Promise<void> {
  let firstError: unknown
  let failed = false
  for (const operation of operations) {
    try {
      await operation()
    } catch (error) {
      if (!failed) firstError = error
      failed = true
    }
  }
  if (failed) throw firstError
}

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
  readonly git: GitService
  readonly host: HostService
  privileged = false

  constructor(configPath: string, protector?: SecretProtector) {
    super()
    this.store = new ConfigStore(configPath, protector)
    this.logs = new ActivityLogger(join(dirname(configPath), 'logs'), { secrets: () => this.auditSecrets() })
    this.projects = new ProjectService(this.store)
    this.files = new FileService(this.projects, { trashDirectory: join(dirname(configPath), 'trash') })
    this.shell = new ShellService(this.projects, this.logs, { statePath: join(dirname(configPath), 'tasks.json'), maxConcurrentTasks: 20 })
    this.proxy = new ProxyManager(this.store, this.logs)
    this.git = new GitService(this.projects)
    this.host = new HostService(this.projects, this.proxy, () => this.privileged)
    this.hub = new McpHub(this.store, this.proxy, this.logs)
    this.uploads = new UploadService(join(dirname(configPath), 'uploads'), this.files, this.logs)
    this.gateway = new McpGateway({ store: this.store, projects: this.projects, files: this.files, shell: this.shell, hub: this.hub, uploads: this.uploads, git: this.git, host: this.host, logger: this.logs })
    this.tunnel = new TunnelManager(this.store, this.proxy, this.logs)
    const notify = (): void => {
      this.emit('change', this.snapshot())
    }
    this.store.on('change', () => {
      void this.proxy.detect().then(notify)
    })
    this.store.on('persistence-error', (error: unknown) => {
      this.logs.error({ category: 'config', action: 'config.persistence_failed', message: 'Could not persist application configuration', origin: 'system', data: { error: errorMessage(error) } })
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
    this.shell.setConcurrencyLimit(this.store.get().limits.maxConcurrentTasks)
    await this.uploads.initialize()
    await this.logs.initialize()
    await this.shell.initialize()
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
    try {
      await runAll([
        () => this.tunnel.stop(),
        () => this.hub.stop(),
        () => this.shell.stopAll(),
        () => this.gateway.stop(),
        () => this.proxy.stop(),
        () => this.store.flush()
      ])
      this.logs.info({ category: 'app', action: 'runtime.stopped', message: 'Local runtime stopped', origin: 'system', status: 'stopped' })
    } catch (error) {
      this.logs.error({ category: 'app', action: 'runtime.stop_failed', message: 'Local runtime stopped with errors', origin: 'system', data: { error: errorMessage(error) } })
      throw error
    } finally {
      await this.logs.flush()
    }
  }

  async emergencyStop(): Promise<void> {
    this.logs.warn({ category: 'security', action: 'emergency.started', message: 'Emergency stop requested', status: 'started' })
    try {
      await runAll([
        () => this.tunnel.stop(),
        () => this.gateway.stop(),
        () => this.shell.stopAll()
      ])
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
    if (patch.limits) this.shell.setConcurrencyLimit(patch.limits.maxConcurrentTasks)
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

  async diagnostics(projectId?: string): Promise<Record<string, unknown>> {
    const config = this.store.get()
    const snapshot = this.snapshot()
    const host = await this.host.capabilities(projectId)
    return {
      generatedAt: new Date().toISOString(),
      app: { name: 'web-codex', version: packageJson.version, platform: process.platform, arch: process.arch, electron: process.versions.electron, node: process.version },
      gateway: snapshot.gateway,
      tunnel: snapshot.tunnel,
      proxy: { ...snapshot.proxy, proxy: sanitizeEndpoint(snapshot.proxy.proxy) },
      secrets: snapshot.secrets,
      privileged: snapshot.privileged,
      projects: config.projects.map((project) => ({ id: project.id, name: project.name, path: project.path, enabled: project.enabled, remoteShell: project.remoteShell })),
      mcpServers: config.mcpServers.map((server) => server.transport === 'stdio'
        ? { id: server.id, name: server.name, alias: server.alias, enabled: server.enabled, transport: server.transport, command: server.command, args: server.args, envKeys: Object.keys(server.env) }
        : { id: server.id, name: server.name, alias: server.alias, enabled: server.enabled, transport: server.transport, url: sanitizeEndpoint(server.url), headerKeys: Object.keys(server.headers) }),
      tasks: snapshot.tasks.map(({ stdout, stderr, ...task }) => ({ ...task, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr) })),
      host: { ...host, proxy: { ...host.proxy, proxy: sanitizeEndpoint(host.proxy.proxy) } },
      recentLogs: this.logs.list({ limit: 300 })
    }
  }

  snapshot(): RuntimeSnapshot {
    return {
      appVersion: packageJson.version,
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