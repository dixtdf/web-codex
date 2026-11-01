import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici'
import type { NetworkSettings, ProxyState } from '../shared/types'
import { errorMessage } from './errors'
import { ConfigStore } from './config-store'
import type { ActivityLogger } from './activity-logger'

const execFileAsync = promisify(execFile)

function withScheme(value: string): string {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`
}

function environmentProxy(env: NodeJS.ProcessEnv): { proxy: string | null; noProxy: string } {
  return {
    proxy: env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy ?? env.ALL_PROXY ?? env.all_proxy ?? null,
    noProxy: env.NO_PROXY ?? env.no_proxy ?? ''
  }
}

function parseWindowsProxy(output: string): string | null {
  const enabled = output.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i)
  if (!enabled || Number.parseInt(enabled[1], 16) === 0) return null
  const server = output.match(/ProxyServer\s+REG_SZ\s+(.+)/i)?.[1]?.trim()
  if (!server) return null
  if (!server.includes('=')) return withScheme(server)
  const entries = Object.fromEntries(server.split(';').map((part) => {
    const index = part.indexOf('=')
    return index < 0 ? [part, ''] : [part.slice(0, index).trim().toLowerCase(), part.slice(index + 1).trim()]
  }))
  const selected = entries.https || entries.http || Object.values(entries).find(Boolean)
  return selected ? withScheme(selected) : null
}

function parseMacProxy(output: string): string | null {
  const value = (key: string): string | undefined => output.match(new RegExp(`${key}\\s*:\\s*([^\\n]+)`))?.[1]?.trim()
  const secure = value('HTTPSEnable') === '1' && value('HTTPSProxy')
  const host = secure ? value('HTTPSProxy') : value('HTTPEnable') === '1' ? value('HTTPProxy') : undefined
  const port = secure ? value('HTTPSPort') : value('HTTPPort')
  return host ? `http://${host}:${port ?? (secure ? '443' : '80')}` : null
}

async function detectSystemProxy(): Promise<string | null> {
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { windowsHide: true })
    return parseWindowsProxy(stdout)
  }
  if (process.platform === 'darwin') {
    const { stdout } = await execFileAsync('scutil', ['--proxy'], { windowsHide: true })
    return parseMacProxy(stdout)
  }
  if (process.platform === 'linux') {
    try {
      const { stdout: modeOutput } = await execFileAsync('gsettings', ['get', 'org.gnome.system.proxy', 'mode'], { windowsHide: true })
      if (!modeOutput.includes('manual')) return null
      const [{ stdout: hostOutput }, { stdout: portOutput }] = await Promise.all([
        execFileAsync('gsettings', ['get', 'org.gnome.system.proxy.http', 'host'], { windowsHide: true }),
        execFileAsync('gsettings', ['get', 'org.gnome.system.proxy.http', 'port'], { windowsHide: true })
      ])
      const host = hostOutput.trim().replaceAll("'", '')
      const port = Number.parseInt(portOutput.trim(), 10)
      return host ? `http://${host}:${Number.isFinite(port) ? port : 8080}` : null
    } catch {
      return null
    }
  }
  return null
}

export function shouldBypassProxy(rawUrl: string, noProxy: string): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (hostname === 'localhost' || hostname.startsWith('127.') || hostname === '::1') return true
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  return noProxy.split(',').map((item) => item.trim().toLowerCase()).some((rule) => {
    if (!rule) return false
    if (rule === '*') return true
    const bracketed = rule.match(/^\[([^\]]+)](?::(\d+))?$/)
    const hostWithPort = bracketed ? undefined : rule.match(/^([^:]+):(\d+)$/)
    const ruleHost = (bracketed?.[1] ?? hostWithPort?.[1] ?? rule).replace(/^\./, '')
    const rulePort = bracketed?.[2] ?? hostWithPort?.[2]
    if (rulePort && rulePort !== port) return false
    return hostname === ruleHost || hostname.endsWith(`.${ruleHost}`)
  })
}

export class ProxyManager extends EventEmitter {
  private state: ProxyState
  private timer?: NodeJS.Timeout
  private detectionVersion = 0
  private readonly agents = new Map<string, ProxyAgent>()

  constructor(private readonly store: ConfigStore, private readonly logger?: ActivityLogger) {
    super()
    this.state = {
      mode: store.get().network.mode,
      source: 'direct',
      proxy: null,
      noProxy: store.get().network.noProxy,
      checkedAt: new Date().toISOString()
    }
  }

  getState(): ProxyState {
    return { ...this.state }
  }

  async detect(): Promise<ProxyState> {
    const version = ++this.detectionVersion
    const settings = this.store.get().network
    const previous = JSON.stringify({ ...this.state, checkedAt: '' })
    let next: ProxyState
    try {
      if (settings.mode === 'direct') {
        next = { mode: settings.mode, source: 'direct', proxy: null, noProxy: settings.noProxy, checkedAt: new Date().toISOString() }
      } else if (settings.mode === 'manual') {
        next = {
          mode: settings.mode,
          source: settings.manualProxy ? 'manual' : 'direct',
          proxy: settings.manualProxy ? withScheme(settings.manualProxy) : null,
          noProxy: settings.noProxy,
          checkedAt: new Date().toISOString()
        }
      } else {
        const environment = environmentProxy(process.env)
        const system = environment.proxy ? null : await detectSystemProxy()
        next = {
          mode: settings.mode,
          source: environment.proxy ? 'environment' : system ? 'system' : 'direct',
          proxy: environment.proxy ?? system,
          noProxy: [environment.noProxy, settings.noProxy].filter(Boolean).join(','),
          checkedAt: new Date().toISOString()
        }
      }
    } catch (error) {
      next = { ...this.state, checkedAt: new Date().toISOString(), error: errorMessage(error) }
    }
    if (version !== this.detectionVersion) return this.getState()
    this.state = next
    if (JSON.stringify({ ...this.state, checkedAt: '' }) !== previous) {
      const input = { category: 'network' as const, action: this.state.error ? 'network.proxy_error' : 'network.proxy_changed', message: this.state.error ? 'Proxy detection failed' : `Proxy configuration changed: ${this.state.source}`, origin: 'system' as const, data: { mode: this.state.mode, source: this.state.source, proxy: this.state.proxy, noProxy: this.state.noProxy, error: this.state.error } }
      if (this.state.error) this.logger?.warn(input)
      else this.logger?.info(input)
      this.emit('change', this.getState())
    }
    return this.getState()
  }

  async start(): Promise<void> {
    await this.detect()
    const refresh = Math.max(3000, this.store.get().network.refreshIntervalMs)
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => void this.detect(), refresh)
    this.timer.unref()
  }

  async stop(): Promise<void> {
    this.detectionVersion += 1
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await Promise.all([...this.agents.values()].map((agent) => agent.close()))
    this.agents.clear()
  }

  dispatcherFor(rawUrl: string): Dispatcher | undefined {
    if (!this.state.proxy || shouldBypassProxy(rawUrl, this.state.noProxy)) return undefined
    let agent = this.agents.get(this.state.proxy)
    if (!agent) {
      agent = new ProxyAgent(this.state.proxy)
      this.agents.set(this.state.proxy, agent)
    }
    return agent
  }

  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const dispatcher = this.dispatcherFor(rawUrl)
    return undiciFetch(input as Parameters<typeof undiciFetch>[0], { ...init, dispatcher } as Parameters<typeof undiciFetch>[1]) as unknown as Response
  }
}

export const proxyInternals = { parseWindowsProxy, parseMacProxy, environmentProxy }

export type { NetworkSettings }