import { EventEmitter } from 'node:events'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AppConfig, SecretStorageState } from '../shared/types'
import type { SecretProtector } from './secret-protector'
import { AppError } from './errors'

const protectedPrefix = 'web-codex:protected:v1:'

export function createDefaultConfig(): AppConfig {
  return {
    version: 1,
    projects: [],
    mcpServers: [],
    network: {
      mode: 'auto',
      noProxy: 'localhost,127.0.0.1,::1',
      refreshIntervalMs: 10_000
    },
    gateway: {
      host: '127.0.0.1',
      port: 32180,
      autoStart: true,
      authToken: randomBytes(32).toString('base64url')
    },
    tunnel: {
      autoStart: false,
      tunnelId: '',
      apiKey: '',
      publicUrl: ''
    },
    ui: {
      theme: 'system',
      startMinimized: false
    }
  }
}

function mergeConfig(saved: Partial<AppConfig>): AppConfig {
  const defaults = createDefaultConfig()
  return {
    ...defaults,
    ...saved,
    version: 1,
    projects: Array.isArray(saved.projects) ? saved.projects : defaults.projects,
    mcpServers: Array.isArray(saved.mcpServers) ? saved.mcpServers : defaults.mcpServers,
    network: { ...defaults.network, ...saved.network },
    gateway: { ...defaults.gateway, ...saved.gateway },
    tunnel: { ...defaults.tunnel, ...saved.tunnel },
    ui: { ...defaults.ui, ...saved.ui }
  }
}

export class ConfigStore extends EventEmitter {
  private config: AppConfig = createDefaultConfig()
  private writeQueue: Promise<void> = Promise.resolve()
  private availability?: Promise<boolean>
  private protectionAvailable = false

  constructor(public readonly filePath: string, private readonly protector?: SecretProtector) {
    super()
  }

  async load(): Promise<AppConfig> {
    await mkdir(dirname(this.filePath), { recursive: true })
    await this.isProtectionAvailable()
    try {
      const saved = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<AppConfig>
      this.config = mergeConfig(await this.unprotectConfig(saved))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
    await this.persist()
    return this.get()
  }

  get(): AppConfig {
    return structuredClone(this.config)
  }

  protectionState(): SecretStorageState {
    return {
      mode: this.protectionAvailable ? 'os-protected' : 'memory-only',
      persistent: this.protectionAvailable,
      detail: this.protectionAvailable
        ? 'Gateway, Tunnel, and downstream MCP secrets are encrypted with the operating-system user key before persistence.'
        : 'OS encryption is unavailable. Secrets remain in memory and are not persisted; credentials must be re-entered after restart.'
    }
  }

  update(patch: Partial<AppConfig>): AppConfig {
    this.config = mergeConfig({ ...this.config, ...patch })
    void this.persist()
    const snapshot = this.get()
    this.emit('change', snapshot)
    return snapshot
  }

  async flush(): Promise<void> {
    await this.writeQueue
  }

  private async protectConfig(config: AppConfig): Promise<AppConfig> {
    const protectedConfig = structuredClone(config)
    protectedConfig.gateway.authToken = await this.protectValue(protectedConfig.gateway.authToken)
    protectedConfig.tunnel.apiKey = await this.protectValue(protectedConfig.tunnel.apiKey)
    for (let index = 0; index < protectedConfig.mcpServers.length; index += 1) {
      const server = protectedConfig.mcpServers[index]
      const values = server.transport === 'stdio' ? server.env : server.headers
      for (const key of Object.keys(values)) values[key] = await this.protectValue(values[key])
    }
    return protectedConfig
  }

  private async unprotectConfig(saved: Partial<AppConfig>): Promise<Partial<AppConfig>> {
    const config = structuredClone(saved)
    if (config.gateway) config.gateway.authToken = await this.unprotectValue(config.gateway.authToken)
    if (config.tunnel) config.tunnel.apiKey = await this.unprotectValue(config.tunnel.apiKey)
    if (Array.isArray(config.mcpServers)) {
      for (const server of config.mcpServers) {
        const values = server.transport === 'stdio' ? server.env : server.headers
        for (const key of Object.keys(values)) values[key] = await this.unprotectValue(values[key])
      }
    }
    return config
  }

  private async protectValue(value: string): Promise<string> {
    if (!value) return ''
    if (!await this.isProtectionAvailable() || !this.protector) return ''
    const encrypted = await this.protector.encryptString(value)
    return `${protectedPrefix}${encrypted.toString('base64')}`
  }

  private async unprotectValue(value: string): Promise<string> {
    if (!value || !value.startsWith(protectedPrefix)) return value
    if (!await this.isProtectionAvailable() || !this.protector) {
      throw new AppError('Protected configuration cannot be decrypted because OS encryption is unavailable', 'SECRET_STORAGE_UNAVAILABLE')
    }
    try {
      const encrypted = Buffer.from(value.slice(protectedPrefix.length), 'base64')
      return await this.protector.decryptString(encrypted)
    } catch {
      throw new AppError('Protected configuration cannot be decrypted by the current OS user', 'SECRET_STORAGE_DECRYPT_FAILED')
    }
  }

  private isProtectionAvailable(): Promise<boolean> {
    if (!this.protector) return Promise.resolve(false)
    this.availability ??= this.protector.isAvailable().then((available) => {
      this.protectionAvailable = available
      return available
    }).catch(() => {
      this.protectionAvailable = false
      return false
    })
    return this.availability
  }

  private persist(): Promise<void> {
    const snapshot = structuredClone(this.config)
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      const serialized = JSON.stringify(await this.protectConfig(snapshot), null, 2)
      await mkdir(dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.${process.pid}.tmp`
      await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.filePath)
    })
    return this.writeQueue
  }
}