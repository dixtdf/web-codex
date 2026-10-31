import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { promisify } from 'node:util'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigStore } from '../../src/core/config-store'
import { ProxyManager } from '../../src/core/proxy-manager'
import { TunnelManager, buildTunnelCommand } from '../../src/core/tunnel-manager'

const { spawnMock, execFileMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), execFileMock: vi.fn() }))
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, spawn: spawnMock, execFile: Object.assign(execFileMock, { [promisify.custom]: execFileMock }) }
})

const tunnelId = 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
let temporaryDirectory: string
let store: ConfigStore
let proxy: ProxyManager
let tunnel: TunnelManager
let clientPath: string
let profileDir: string
let healthFile: string

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'web-codex-tunnel-'))
  clientPath = join(temporaryDirectory, 'tunnel-client.exe')
  profileDir = join(temporaryDirectory, 'tunnel-client')
  healthFile = join(profileDir, 'health.url')
  store = new ConfigStore(join(temporaryDirectory, 'config.json'))
  await store.load()
  store.update({
    network: { ...store.get().network, mode: 'direct' },
    gateway: { ...store.get().gateway, port: 34567, authToken: 'test-gateway-token' },
    tunnel: { ...store.get().tunnel, tunnelId, apiKey: 'test-api-key', publicUrl: '' }
  })
  proxy = new ProxyManager(store)
  await proxy.detect()
  vi.spyOn(proxy, 'fetch').mockResolvedValue(new Response('ready', { status: 200 }))
  tunnel = new TunnelManager(store, proxy, undefined, clientPath)
  spawnMock.mockReset()
  execFileMock.mockReset()
  execFileMock.mockImplementation(async (_command: string, args: string[]) => {
    if (args[0] === 'run' && args[1] === '--help') {
      return { stdout: 'run version 0.0.19\n--mcp.server-url\n--control-plane.tunnel-id\n--health.url-file', stderr: '' }
    }
    if (args[0] === 'init') return { stdout: 'Created profile web-codex', stderr: '' }
    if (args[0] === 'doctor') return { stdout: 'All checks passed', stderr: '' }
    throw new Error(`Unexpected execFile: ${args.join(' ')}`)
  })
})

afterEach(async () => {
  vi.useRealTimers()
  await tunnel.stop()
  await proxy.stop()
  await store.flush()
  vi.restoreAllMocks()
  await rm(temporaryDirectory, { recursive: true, force: true })
})

describe('buildTunnelCommand', () => {
  it('builds the official run command and injects credentials through environment only', async () => {
    store.update({ network: { ...store.get().network, mode: 'manual', manualProxy: 'proxy.local:8080', noProxy: 'internal.local' } })
    await proxy.detect()

    const command = buildTunnelCommand(store, proxy, clientPath, profileDir)
    expect(command).toEqual({
      command: clientPath,
      args: ['run', '--profile', 'web-codex', '--profile-dir', profileDir, '--health.listen-addr', '127.0.0.1:0', '--health.url-file', healthFile],
      env: {
        CONTROL_PLANE_TUNNEL_ID: tunnelId,
        CONTROL_PLANE_API_KEY: 'test-api-key',
        MCP_SERVER_URL: 'http://127.0.0.1:34567/mcp',
        MCP_AUTHORIZATION: 'Bearer test-gateway-token',
        MCP_EXTRA_HEADERS: 'Authorization: env:MCP_AUTHORIZATION',
        MCP_DISCOVERY_EXTRA_HEADERS: 'Authorization: env:MCP_AUTHORIZATION',
        WEB_CODEX_HOST: '127.0.0.1',
        WEB_CODEX_PORT: '34567',
        WEB_CODEX_LOCAL_URL: 'http://127.0.0.1:34567/mcp',
        WEB_CODEX_TOKEN: 'test-gateway-token',
        HTTPS_PROXY: 'http://proxy.local:8080',
        HTTP_PROXY: 'http://proxy.local:8080',
        NO_PROXY: 'internal.local,localhost,127.0.0.1,::1'
      }
    })
    expect(command.args).not.toContain('test-api-key')
    expect(command.args).not.toContain('test-gateway-token')
  })

  it('omits proxy variables in direct mode', () => {
    const command = buildTunnelCommand(store, proxy, clientPath, profileDir)
    expect(command.env).not.toHaveProperty('HTTPS_PROXY')
    expect(command.env).not.toHaveProperty('HTTP_PROXY')
  })
})

describe('TunnelManager validation and preflight', () => {
  it('rejects missing credentials before any client process', async () => {
    store.update({ tunnel: { ...store.get().tunnel, tunnelId: '  ', apiKey: '' } })
    await expect(tunnel.start()).rejects.toMatchObject({ code: 'TUNNEL_CREDENTIALS_REQUIRED' })
    expect(tunnel.getState()).toMatchObject({ running: false, detail: 'Tunnel credentials required' })
    expect(spawnMock).not.toHaveBeenCalled()
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('rejects malformed Tunnel IDs before initialization', async () => {
    store.update({ tunnel: { ...store.get().tunnel, tunnelId: 'tunnel_dummy' } })
    await expect(tunnel.start()).rejects.toMatchObject({ code: 'TUNNEL_ID_INVALID' })
    expect(spawnMock).not.toHaveBeenCalled()
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('detects a missing bundled client before spawning', async () => {
    execFileMock.mockRejectedValue(new Error('spawn tunnel-client ENOENT'))
    await expect(tunnel.start()).rejects.toMatchObject({ code: 'TUNNEL_CLIENT_UNAVAILABLE' })
    expect(tunnel.getState()).toMatchObject({
      running: false,
      phase: 'error',
      detail: 'Tunnel client unavailable',
      client: { available: false, error: expect.stringContaining('内置 Tunnel 客户端不可用') }
    })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects clients without official MCP and health options', async () => {
    execFileMock.mockResolvedValue({ stdout: 'Codex CLI\nCommands: exec, login, mcp', stderr: '' })
    await expect(tunnel.checkClient()).resolves.toEqual({
      available: false,
      error: '内置 Tunnel 客户端缺少 run、MCP 或健康检查参数支持'
    })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('surfaces doctor failures without starting the daemon', async () => {
    execFileMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === 'run') return { stdout: '--mcp.server-url --control-plane.tunnel-id --health.url-file', stderr: '' }
      if (args[0] === 'init') return { stdout: 'Created', stderr: '' }
      if (args[0] === 'doctor') throw new Error('OAuth discovery failed')
      throw new Error('Unexpected command')
    })

    await expect(tunnel.start()).rejects.toMatchObject({ code: 'TUNNEL_DOCTOR_FAILED' })
    expect(tunnel.getState()).toMatchObject({ running: false, phase: 'error', detail: 'Tunnel preflight failed', error: expect.stringContaining('OAuth discovery failed') })
    expect(spawnMock).not.toHaveBeenCalled()
  })
})

describe('TunnelManager process lifecycle', () => {
  it('initializes no-auth profile, runs doctor, and waits for real readyz health', async () => {
    const child = fakeChild(() => {
      queueMicrotask(() => {
        child.emit('spawn')
        child.stdout?.emit('data', Buffer.from('daemon started\n'))
        void mkdir(profileDir, { recursive: true }).then(() => writeFile(healthFile, 'http://127.0.0.1:8080'))
      })
    })

    await expect(tunnel.start()).resolves.toMatchObject({ running: true })
    await vi.waitFor(() => expect(tunnel.getState()).toMatchObject({ running: true, phase: 'ready', detail: 'Waiting for ChatGPT', error: undefined }))
    await expect(tunnel.start()).resolves.toMatchObject({ phase: 'ready' })
    expect(spawnMock).toHaveBeenCalledWith(clientPath, expectedRunArgs(), expect.objectContaining({
      shell: false,
      windowsHide: true,
      env: expect.objectContaining({ CONTROL_PLANE_TUNNEL_ID: tunnelId, CONTROL_PLANE_API_KEY: 'test-api-key', MCP_EXTRA_HEADERS: 'Authorization: env:MCP_AUTHORIZATION' })
    }))
    const init = execFileMock.mock.calls.find((call) => call[1][0] === 'init')
    expect(init?.[1]).toEqual(expect.arrayContaining(['--sample', 'sample_mcp_remote_no_auth', '--tunnel-id', tunnelId, '--mcp-server-url', 'http://127.0.0.1:34567/mcp']))
    expect(init?.[1]).not.toContain('test-api-key')
    expect(init?.[1]).not.toContain('test-gateway-token')
    expect(execFileMock.mock.calls.some((call) => call[1][0] === 'doctor')).toBe(true)

    const stopping = tunnel.stop()
    child.emit('close', 0, null)
    await stopping
    expect(tunnel.getState()).toMatchObject({ running: false, phase: 'disconnected', detail: 'Not connected' })
  })

  it('reports child exit codes without keeping a connection', async () => {
    store.update({ tunnel: { ...store.get().tunnel, publicUrl: 'https://configured.example.test/mcp' } })
    const child = fakeChild(() => queueMicrotask(() => {
      child.emit('spawn')
      child.emit('close', 3, null)
    }))

    await tunnel.start()
    await vi.waitFor(() => expect(tunnel.getState()).toMatchObject({ running: false, phase: 'error', detail: 'Tunnel disconnected', error: 'Tunnel exited with code 3' }))
    expect(tunnel.getState().publicUrl).toBe('https://configured.example.test/mcp')
  })

  it('surfaces child startup errors', async () => {
    const child = fakeChild(() => queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))))

    await tunnel.start()
    await vi.waitFor(() => expect(tunnel.getState()).toMatchObject({ running: false, phase: 'error', detail: 'Tunnel failed to start', error: 'spawn ENOENT' }))
  })

  it('handles spawn errors and output failures', async () => {
    const child = fakeChild(() => queueMicrotask(() => {
      child.emit('spawn')
      child.stderr?.emit('data', Buffer.from('Unauthorized: invalid API key\n'))
    }))

    await tunnel.start()
    await vi.waitFor(() => expect(tunnel.getState()).toMatchObject({ running: true, phase: 'error', detail: 'Tunnel reported an error' }))
    child.emit('close', 0, null)
    await vi.waitFor(() => expect(tunnel.getState()).toMatchObject({ running: false, phase: 'disconnected', detail: 'Tunnel disconnected' }))
  })

  it('marks readiness timeouts as errors instead of claiming a connection', async () => {
    tunnel = new TunnelManager(store, proxy, undefined, clientPath, 30)
    const child = fakeChild(() => queueMicrotask(() => child.emit('spawn')))
    await tunnel.start()

    await vi.waitFor(() => expect(tunnel.getState()).toMatchObject({ running: true, phase: 'error', detail: 'Tunnel readiness timed out' }))
    const stopping = tunnel.stop()
    child.emit('close', 0, null)
    await stopping
  })

  it('captures synchronous spawn validation failures', async () => {
    spawnMock.mockImplementationOnce(() => { throw new Error('spawn EINVAL') })
    await expect(tunnel.start()).resolves.toMatchObject({ running: false, detail: 'Tunnel failed to start', error: 'spawn EINVAL' })
  })
})

function expectedRunArgs(): string[] {
  return ['run', '--profile', 'web-codex', '--profile-dir', profileDir, '--health.listen-addr', '127.0.0.1:0', '--health.url-file', healthFile]
}

function fakeChild(onSpawn: () => void): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn()
  }) as unknown as ChildProcess
  spawnMock.mockImplementation((command: string) => {
    if (command === 'taskkill.exe') queueMicrotask(() => child.emit('close', 0, null))
    else queueMicrotask(onSpawn)
    return child
  })
  return child
}