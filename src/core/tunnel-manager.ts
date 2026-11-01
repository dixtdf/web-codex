import { EventEmitter } from 'node:events'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { dirname, join, resolve } from 'node:path'
import type { TunnelClientState, TunnelState } from '../shared/types'
import { ConfigStore } from './config-store'
import { ProxyManager } from './proxy-manager'
import type { ActivityLogger } from './activity-logger'
import { AppError, errorMessage } from './errors'
import { terminateProcessTree } from './process-tree'

const execFileAsync = promisify(execFile)
const readinessTimeoutMs = 30_000
const profileName = 'web-codex'

export interface TunnelCommand {
  command: string
  args: string[]
  env: Record<string, string>
}

export function resolveTunnelClientPath(): string {
  const executable = process.platform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client'
  if (process.resourcesPath) {
    const packaged = join(process.resourcesPath, 'tunnel-client', executable)
    if (existsSync(packaged)) return packaged
  }
  const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : undefined
  const architecture = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : undefined
  if (!platform || !architecture) throw new Error(`Unsupported Tunnel client target: ${process.platform}/${process.arch}`)
  return resolve('resources', 'tunnel-client', `${platform}-${architecture}`, executable)
}

function profileDirectory(store: ConfigStore): string {
  return join(dirname(store.filePath), 'tunnel-client')
}

function localGatewayUrl(store: ConfigStore): string {
  const gateway = store.get().gateway
  return `http://${gateway.host}:${gateway.port}/mcp`
}

function proxyEnvironment(proxy: ProxyManager): Record<string, string> {
  const state = proxy.getState()
  if (!state.proxy) return {}
  const noProxy = [...new Set([...state.noProxy.split(','), 'localhost', '127.0.0.1', '::1'].map((item) => item.trim()).filter(Boolean))].join(',')
  return { HTTPS_PROXY: state.proxy, HTTP_PROXY: state.proxy, NO_PROXY: noProxy }
}

function tunnelEnvironment(store: ConfigStore, proxy: ProxyManager): Record<string, string> {
  const config = store.get()
  const localUrl = localGatewayUrl(store)
  return {
    CONTROL_PLANE_TUNNEL_ID: config.tunnel.tunnelId,
    CONTROL_PLANE_API_KEY: config.tunnel.apiKey,
    MCP_SERVER_URL: localUrl,
    MCP_AUTHORIZATION: `Bearer ${config.gateway.authToken}`,
    MCP_EXTRA_HEADERS: 'Authorization: env:MCP_AUTHORIZATION',
    MCP_DISCOVERY_EXTRA_HEADERS: 'Authorization: env:MCP_AUTHORIZATION',
    WEB_CODEX_HOST: config.gateway.host,
    WEB_CODEX_PORT: String(config.gateway.port),
    WEB_CODEX_LOCAL_URL: localUrl,
    WEB_CODEX_TOKEN: config.gateway.authToken,
    ...proxyEnvironment(proxy)
  }
}

function outputSummary(stdout: string, stderr: string): string {
  const line = `${stdout}\n${stderr}`.split(/\r?\n/).map((item) => item.trim()).find(Boolean)
  return line?.slice(0, 300) ?? ''
}

export function buildTunnelCommand(store: ConfigStore, proxy: ProxyManager, clientPath = resolveTunnelClientPath(), profileDir = profileDirectory(store)): TunnelCommand {
  return {
    command: clientPath,
    args: ['run', '--profile', profileName, '--profile-dir', profileDir, '--health.listen-addr', '127.0.0.1:0', '--health.url-file', join(profileDir, 'health.url')],
    env: tunnelEnvironment(store, proxy)
  }
}

export class TunnelManager extends EventEmitter {
  private child?: ChildProcess
  private startPromise?: Promise<TunnelState>
  private stopping = false
  private state: TunnelState = { running: false, phase: 'disconnected', detail: 'Not connected' }

  constructor(
    private readonly store: ConfigStore,
    private readonly proxy: ProxyManager,
    private readonly logger?: ActivityLogger,
    private readonly clientPath = resolveTunnelClientPath(),
    private readonly readinessTimeout = readinessTimeoutMs
  ) {
    super()
  }

  getState(): TunnelState {
    const publicUrl = this.store.get().tunnel.publicUrl
    return { ...this.state, publicUrl: this.state.publicUrl || publicUrl || undefined }
  }

  async checkClient(): Promise<TunnelClientState> {
    await this.proxy.detect()
    try {
      const { stdout, stderr } = await execFileAsync(this.clientPath, ['run', '--help'], {
        env: { ...process.env, ...proxyEnvironment(this.proxy) },
        timeout: 5000,
        windowsHide: true,
        maxBuffer: 131_072
      })
      const output = `${stdout}\n${stderr}`
      if (!output.includes('--mcp.server-url') || !output.includes('--control-plane.tunnel-id') || !output.includes('--health.url-file')) {
        throw new AppError('内置 Tunnel 客户端缺少 run、MCP 或健康检查参数支持', 'TUNNEL_CLIENT_UNSUPPORTED')
      }
      const client: TunnelClientState = { available: true, detail: outputSummary(stdout, stderr) || 'tunnel-client available' }
      this.logger?.info({ category: 'tunnel', action: 'tunnel.client_ready', message: 'Bundled Tunnel client is available', origin: 'system', data: { client: outputSummary(stdout, stderr) } })
      this.update({ client })
      return client
    } catch (error) {
      const client: TunnelClientState = {
        available: false,
        error: error instanceof AppError ? error.message : `内置 Tunnel 客户端不可用：${errorMessage(error)}`
      }
      this.logger?.warn({ category: 'tunnel', action: 'tunnel.client_unavailable', message: client.error ?? 'Tunnel client unavailable', origin: 'system' })
      this.update({ client })
      return client
    }
  }

  async start(): Promise<TunnelState> {
    if (this.child) return this.getState()
    if (this.startPromise) return this.startPromise
    const starting = this.startInternal()
    this.startPromise = starting
    try {
      return await starting
    } finally {
      if (this.startPromise === starting) this.startPromise = undefined
    }
  }

  private async startInternal(): Promise<TunnelState> {
    if (this.child) return this.getState()
    const credentials = this.store.get().tunnel
    if (!credentials.tunnelId.trim() || !credentials.apiKey.trim()) {
      const error = new AppError('请填写 Tunnel ID 和 API Key', 'TUNNEL_CREDENTIALS_REQUIRED')
      this.logger?.error({ category: 'tunnel', action: 'tunnel.credentials_missing', message: error.message, data: { hasTunnelId: Boolean(credentials.tunnelId.trim()), hasApiKey: Boolean(credentials.apiKey.trim()) } })
      this.update({ running: false, phase: 'error', detail: 'Tunnel credentials required', error: error.message })
      throw error
    }
    if (!/^tunnel_(?:[a-z0-9]{4}_)?[a-z0-9]{32}$/.test(credentials.tunnelId.trim())) {
      const error = new AppError('Tunnel ID 格式不正确，应为 tunnel_ 加 32 位小写字母或数字', 'TUNNEL_ID_INVALID')
      this.update({ running: false, phase: 'error', detail: 'Tunnel ID invalid', error: error.message })
      throw error
    }

    this.update({ running: false, phase: 'checking', detail: 'Checking Tunnel client', error: undefined })
    const client = await this.checkClient()
    if (!client.available) {
      const error = new AppError(client.error ?? '内置 Tunnel 客户端不可用', 'TUNNEL_CLIENT_UNAVAILABLE')
      this.update({ running: false, phase: 'error', detail: 'Tunnel client unavailable', error: error.message, client })
      throw error
    }

    const profileDir = profileDirectory(this.store)
    const healthFile = join(profileDir, 'health.url')
    try {
      await this.prepareProfile(profileDir)
      await this.runDoctor(profileDir)
      await rm(healthFile, { force: true })
    } catch (error) {
      const message = errorMessage(error)
      this.logger?.error({ category: 'tunnel', action: 'tunnel.preflight_failed', message: 'Tunnel preflight failed', origin: 'system', data: { error: message } })
      this.update({ running: false, phase: 'error', detail: 'Tunnel preflight failed', error: message, client })
      throw error
    }

    const invocation = buildTunnelCommand(this.store, this.proxy, this.clientPath, profileDir)
    this.stopping = false
    this.logger?.info({ category: 'tunnel', action: 'tunnel.start', message: 'Starting bundled OpenAI Tunnel client', origin: 'system', status: 'started', data: { command: invocation.command, args: invocation.args.map((arg) => arg === this.store.get().tunnel.tunnelId ? '[TUNNEL_ID]' : arg) } })
    this.update({ running: true, phase: 'starting', detail: 'Starting OpenAI Tunnel', publicUrl: this.store.get().tunnel.publicUrl || undefined, client, error: undefined })
    try {
      const child = spawn(invocation.command, invocation.args, {
        env: { ...process.env, ...invocation.env },
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32'
      })
      this.child = child
      const buffers = { stdout: '', stderr: '' }
      const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
      const inspectOutput = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
        const text = decoders[stream].write(chunk)
        buffers[stream] += text
        const lines = buffers[stream].split(/\r?\n/)
        buffers[stream] = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          const input = { category: 'tunnel' as const, action: `tunnel.${stream}`, message: line, origin: 'system' as const, data: { stream } }
          if (stream === 'stderr') this.logger?.warn(input)
          else this.logger?.info(input)
          if (/error|failed|unauthorized|forbidden|invalid|401|403/i.test(line)) {
            this.update({ running: true, phase: 'error', detail: 'Tunnel reported an error', error: line.trim().slice(0, 500) })
          }
        }
      }
      child.stdout?.on('data', (chunk: Buffer) => inspectOutput('stdout', chunk))
      child.stderr?.on('data', (chunk: Buffer) => inspectOutput('stderr', chunk))
      const started = new Promise<void>((resolveStart, rejectStart) => {
        child.once('spawn', () => {
          this.logger?.info({ category: 'tunnel', action: 'tunnel.spawned', message: 'Tunnel process started', origin: 'system', status: 'success', data: { pid: child.pid } })
          this.update({ running: true, phase: 'starting', detail: 'Connecting to OpenAI Tunnel', error: undefined })
          void this.monitorReadiness(child, healthFile)
          resolveStart()
        })
        child.once('error', rejectStart)
      })
      child.once('error', (error) => {
        this.child = undefined
        this.logger?.error({ category: 'tunnel', action: 'tunnel.process_error', message: 'Tunnel process failed', origin: 'system', data: { error: errorMessage(error) } })
        this.update({ running: false, phase: 'error', detail: 'Tunnel failed to start', error: error.message })
      })
      child.once('close', (code, signal) => {
        this.child = undefined
        for (const stream of ['stdout', 'stderr'] as const) {
          const line = `${buffers[stream]}${decoders[stream].end()}`.trim()
          if (line) this.logger?.info({ category: 'tunnel', action: `tunnel.${stream}`, message: line, origin: 'system', data: { stream, final: true } })
        }
        this.logger?.[code === 0 || this.stopping ? 'info' : 'error']({ category: 'tunnel', action: 'tunnel.closed', message: `Tunnel process closed with code ${code ?? 'unknown'}`, origin: 'system', status: this.stopping ? 'stopped' : code === 0 ? 'success' : 'error', data: { code, signal } })
        if (!this.stopping && this.state.detail !== 'Tunnel failed to start') {
          this.update({ running: false, phase: code === 0 ? 'disconnected' : 'error', detail: 'Tunnel disconnected', error: code === 0 ? undefined : `Tunnel exited with code ${code ?? 'unknown'}` })
        }
      })
      await started
    } catch (error) {
      this.child = undefined
      this.logger?.error({ category: 'tunnel', action: 'tunnel.start_failed', message: 'Tunnel failed to start', origin: 'system', data: { error: errorMessage(error) } })
      this.update({ running: false, phase: 'error', detail: 'Tunnel failed to start', error: errorMessage(error) })
    }
    return this.getState()
  }

  async stop(): Promise<void> {
    const starting = this.startPromise
    if (starting) await starting.catch(() => undefined)
    const child = this.child
    this.logger?.info({ category: 'tunnel', action: 'tunnel.stop', message: 'Stopping OpenAI Tunnel', origin: 'system', status: 'started', data: { pid: child?.pid } })
    if (!child) {
      this.update({ running: false, phase: 'disconnected', detail: 'Not connected', error: undefined })
      return
    }
    this.stopping = true
    if (!await terminateProcessTree(child, 5000)) {
      this.stopping = false
      const error = new AppError('Tunnel process did not exit after forced termination', 'TUNNEL_STOP_TIMEOUT')
      this.logger?.error({ category: 'tunnel', action: 'tunnel.stop_failed', message: error.message, origin: 'system' })
      this.update({ running: true, phase: 'error', detail: 'Tunnel failed to stop', error: error.message })
      throw error
    }
    this.child = undefined
    this.stopping = false
    this.logger?.info({ category: 'tunnel', action: 'tunnel.stopped', message: 'OpenAI Tunnel stopped', origin: 'system', status: 'stopped' })
    this.update({ running: false, phase: 'disconnected', detail: 'Not connected', error: undefined })
  }

  private async prepareProfile(profileDir: string): Promise<void> {
    const config = this.store.get()
    await execFileAsync(this.clientPath, [
      'init',
      '--sample', 'sample_mcp_remote_no_auth',
      '--profile', profileName,
      '--profile-dir', profileDir,
      '--tunnel-id', config.tunnel.tunnelId.trim(),
      '--mcp-server-url', localGatewayUrl(this.store),
      '--health-listen-addr', '127.0.0.1:0',
      '--control-plane-api-key-ref', 'env:CONTROL_PLANE_API_KEY',
      '--force'
    ], {
      env: { ...process.env, ...proxyEnvironment(this.proxy) },
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 65_536
    })
  }

  private async runDoctor(profileDir: string): Promise<void> {
    try {
      await execFileAsync(this.clientPath, ['doctor', '--profile', profileName, '--profile-dir', profileDir, '--explain'], {
        env: { ...process.env, ...tunnelEnvironment(this.store, this.proxy) },
        timeout: 35_000,
        windowsHide: true,
        maxBuffer: 262_144
      })
    } catch (error) {
      throw new AppError(`Tunnel 预检未通过：${errorMessage(error)}`, 'TUNNEL_DOCTOR_FAILED')
    }
  }

  private async monitorReadiness(child: ChildProcess, healthFile: string): Promise<void> {
    const deadline = Date.now() + this.readinessTimeout
    let readinessDetail = ''
    while (this.child === child && Date.now() < deadline) {
      try {
        const baseUrl = (await readFile(healthFile, 'utf8')).trim()
        if (baseUrl) {
          const response = await this.proxy.fetch(new URL('/readyz', baseUrl))
          readinessDetail = (await response.text()).slice(0, 500)
          if (response.ok) {
            this.logger?.info({ category: 'tunnel', action: 'tunnel.ready', message: 'Tunnel reports ready for ChatGPT', origin: 'system', status: 'success' })
            this.update({ running: true, phase: 'ready', detail: 'Waiting for ChatGPT', error: undefined })
            return
          }
        }
      } catch {
        // The health URL file and listener appear asynchronously.
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
    }
    if (this.child === child && this.state.phase === 'starting') {
      this.update({
        running: true,
        phase: 'error',
        detail: 'Tunnel readiness timed out',
        error: readinessDetail || `Tunnel 进程已启动，但 ${Math.max(1, Math.round(this.readinessTimeout / 1000))} 秒内 /readyz 未报告就绪。请运行 doctor 并检查 Tunnel 日志。`
      })
    }
  }

  private update(patch: Partial<TunnelState>): void {
    this.state = { ...this.state, ...patch }
    this.emit('change', this.getState())
  }
}