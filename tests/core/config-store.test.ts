import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigStore, createDefaultConfig } from '../../src/core/config-store'
import type { SecretProtector } from '../../src/core/secret-protector'

let temporaryDirectory: string
let filePath: string
let protector: SecretProtector

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'web-codex-config-'))
  filePath = join(temporaryDirectory, 'nested', 'config.json')
  await mkdir(dirname(filePath), { recursive: true })
  protector = {
    isAvailable: async () => true,
    encryptString: async (value) => Buffer.from(value, 'utf8'),
    decryptString: async (value) => value.toString('utf8')
  }
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(temporaryDirectory, { recursive: true, force: true })
})

describe('ConfigStore', () => {
  it('creates secure local defaults and reloads protected secrets', async () => {
    const store = new ConfigStore(filePath, protector)
    const config = await store.load()

    expect(config).toMatchObject({
      version: 1,
      projects: [],
      mcpServers: [],
      network: { mode: 'auto', noProxy: 'localhost,127.0.0.1,::1' },
      gateway: { host: '127.0.0.1', port: 32180, autoStart: true },
      tunnel: { autoStart: false, tunnelId: '', apiKey: '', publicUrl: '' },
      ui: { theme: 'system', startMinimized: false }
    })
    expect(config.gateway.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(createDefaultConfig().gateway.authToken).not.toBe(config.gateway.authToken)
    const persisted = JSON.parse(await readFile(filePath, 'utf8'))
    expect(persisted.gateway.authToken).toMatch(/^web-codex:protected:v1:/)
    expect(persisted.gateway.authToken).not.toBe(config.gateway.authToken)
    expect(store.protectionState()).toMatchObject({ mode: 'os-protected', persistent: true })
    await expect(new ConfigStore(filePath, protector).load()).resolves.toEqual(config)
  })

  it('merges partial saved settings without sharing mutable snapshots', async () => {
    await new ConfigStore(filePath, protector).load()
    const saved = createDefaultConfig()
    saved.gateway.port = 41000
    saved.network.manualProxy = 'localhost:8080'
    await writeFile(filePath, JSON.stringify({ gateway: { port: saved.gateway.port }, network: { manualProxy: saved.network.manualProxy }, projects: null }))

    const store = new ConfigStore(filePath, protector)
    const loaded = await store.load()
    expect(loaded.gateway).toMatchObject({ port: 41000, host: '127.0.0.1' })
    expect(loaded.network).toMatchObject({ mode: 'auto', manualProxy: 'localhost:8080' })
    expect(loaded.projects).toEqual([])

    loaded.gateway.port = 1
    expect(store.get().gateway.port).toBe(41000)
  })

  it('serializes queued updates, flushes them, and notifies subscribers', async () => {
    const store = new ConfigStore(filePath, protector)
    await store.load()
    const listener = vi.fn()
    store.on('change', listener)

    store.update({ gateway: { ...store.get().gateway, port: 33001 } })
    store.update({ ui: { theme: 'dark', startMinimized: true } })
    await store.flush()

    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ ui: { theme: 'dark', startMinimized: true } }))
    const persisted = JSON.parse(await readFile(filePath, 'utf8'))
    expect(persisted.gateway.port).toBe(33001)
    expect(persisted.ui.theme).toBe('dark')
  })

  it('surfaces malformed configuration instead of silently replacing it', async () => {
    await new ConfigStore(filePath, protector).load()
    await writeFile(filePath, '{broken')

    await expect(new ConfigStore(filePath, protector).load()).rejects.toThrow(SyntaxError)
    expect(await readFile(filePath, 'utf8')).toBe('{broken')
  })

  it('encrypts Tunnel and downstream MCP secrets and restores them after restart', async () => {
    const store = new ConfigStore(filePath, protector)
    await store.load()
    const config = store.get()
    store.update({
      tunnel: { ...config.tunnel, tunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', apiKey: 'runtime-secret' },
      mcpServers: [
        { id: 'stdio', name: 'Local', alias: 'local', enabled: true, transport: 'stdio', command: 'node', args: [], env: { API_KEY: 'stdio-secret' } },
        { id: 'http', name: 'Remote', alias: 'remote', enabled: true, transport: 'streamable-http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer http-secret' } }
      ]
    })
    await store.flush()

    const raw = await readFile(filePath, 'utf8')
    expect(raw).not.toContain('runtime-secret')
    expect(raw).not.toContain('stdio-secret')
    expect(raw).not.toContain('http-secret')
    const persisted = JSON.parse(raw)
    expect(persisted.tunnel.apiKey).toMatch(/^web-codex:protected:v1:/)
    expect(persisted.mcpServers[0].env.API_KEY).toMatch(/^web-codex:protected:v1:/)
    expect(persisted.mcpServers[1].headers.Authorization).toMatch(/^web-codex:protected:v1:/)

    const reloaded = await new ConfigStore(filePath, protector).load()
    expect(reloaded.tunnel.apiKey).toBe('runtime-secret')
    expect(reloaded.mcpServers[0].transport === 'stdio' && reloaded.mcpServers[0].env.API_KEY).toBe('stdio-secret')
    expect(reloaded.mcpServers[1].transport === 'streamable-http' && reloaded.mcpServers[1].headers.Authorization).toBe('Bearer http-secret')
  })

  it('migrates legacy plaintext secrets to protected fields on load', async () => {
    const legacy = createDefaultConfig()
    legacy.gateway.authToken = 'legacy-gateway-secret'
    legacy.tunnel.apiKey = 'legacy-tunnel-secret'
    legacy.mcpServers = [{ id: 'legacy', name: 'Legacy', alias: 'legacy', enabled: true, transport: 'stdio', command: 'node', args: [], env: { TOKEN: 'legacy-env-secret' } }]
    await writeFile(filePath, JSON.stringify(legacy))

    const store = new ConfigStore(filePath, protector)
    expect((await store.load()).tunnel.apiKey).toBe('legacy-tunnel-secret')
    const raw = await readFile(filePath, 'utf8')
    expect(raw).not.toContain('legacy-gateway-secret')
    expect(raw).not.toContain('legacy-tunnel-secret')
    expect(raw).not.toContain('legacy-env-secret')
  })

  it('never writes plaintext when OS protection is unavailable', async () => {
    const store = new ConfigStore(filePath)
    await store.load()
    const config = store.get()
    store.update({
      gateway: { ...config.gateway, authToken: 'memory-gateway-secret' },
      tunnel: { ...config.tunnel, apiKey: 'memory-tunnel-secret' },
      mcpServers: [{ id: 'memory', name: 'Memory', alias: 'memory', enabled: true, transport: 'stdio', command: 'node', args: [], env: { TOKEN: 'memory-env-secret' } }]
    })
    await store.flush()

    expect(store.protectionState()).toMatchObject({ mode: 'memory-only', persistent: false })
    const raw = await readFile(filePath, 'utf8')
    expect(raw).not.toContain('memory-gateway-secret')
    expect(raw).not.toContain('memory-tunnel-secret')
    expect(raw).not.toContain('memory-env-secret')
    const persisted = JSON.parse(raw)
    expect(persisted.gateway.authToken).toBe('')
    expect(persisted.tunnel.apiKey).toBe('')
    expect(persisted.mcpServers[0].env.TOKEN).toBe('')
  })

  it('fails explicitly when protected data cannot be decrypted', async () => {
    await writeFile(filePath, JSON.stringify({ gateway: { authToken: 'web-codex:protected:v1:aGVsbG8=' } }))
    vi.spyOn(protector, 'decryptString').mockImplementation(() => { throw new Error('wrong user') })
    await expect(new ConfigStore(filePath, protector).load()).rejects.toMatchObject({ code: 'SECRET_STORAGE_DECRYPT_FAILED' })

    await expect(new ConfigStore(filePath).load()).rejects.toMatchObject({ code: 'SECRET_STORAGE_UNAVAILABLE' })
  })
})