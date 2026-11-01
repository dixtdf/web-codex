import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigStore } from '../../src/core/config-store'
import { ProxyManager, proxyInternals, shouldBypassProxy } from '../../src/core/proxy-manager'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, execFile: Object.assign(execFileMock, { [promisify.custom]: execFileMock }) }
})

const proxyEnvironmentKeys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']
const originalEnvironment = new Map<string, string | undefined>()
let temporaryDirectory: string
let store: ConfigStore
let proxy: ProxyManager

beforeEach(async () => {
  for (const key of proxyEnvironmentKeys) {
    originalEnvironment.set(key, process.env[key])
    delete process.env[key]
  }
  execFileMock.mockReset()
  execFileMock.mockRejectedValue(new Error('Unexpected system command'))
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'web-codex-proxy-'))
  store = new ConfigStore(join(temporaryDirectory, 'config.json'))
  await store.load()
  proxy = new ProxyManager(store)
})

afterEach(async () => {
  await proxy.stop()
  await store.flush()
  await rm(temporaryDirectory, { recursive: true, force: true })
  for (const key of proxyEnvironmentKeys) {
    const value = originalEnvironment.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  originalEnvironment.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('proxy parsing and bypass rules', () => {
  it('parses environment precedence and Windows proxy formats', () => {
    expect(proxyInternals.environmentProxy({ HTTPS_PROXY: 'https://secure', HTTP_PROXY: 'http://plain', NO_PROXY: 'example.com' })).toEqual({ proxy: 'https://secure', noProxy: 'example.com' })
    expect(proxyInternals.environmentProxy({ http_proxy: 'http://lower', all_proxy: 'http://fallback' })).toEqual({ proxy: 'http://lower', noProxy: '' })
    expect(proxyInternals.parseWindowsProxy('ProxyEnable REG_DWORD 0x0\nProxyServer REG_SZ proxy:8080')).toBeNull()
    expect(proxyInternals.parseWindowsProxy('ProxyEnable REG_DWORD 0x1')).toBeNull()
    expect(proxyInternals.parseWindowsProxy('ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ proxy:8080')).toBe('http://proxy:8080')
    expect(proxyInternals.parseWindowsProxy('ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ http=http-proxy:8080;https=https-proxy:8443')).toBe('http://https-proxy:8443')
    expect(proxyInternals.parseWindowsProxy('ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ socks=socks-proxy:1080')).toBe('http://socks-proxy:1080')
  })

  it('parses macOS secure and plain HTTP proxy settings', () => {
    expect(proxyInternals.parseMacProxy('HTTPSEnable : 1\nHTTPSProxy : secure.local\nHTTPSPort : 8443')).toBe('http://secure.local:8443')
    expect(proxyInternals.parseMacProxy('HTTPEnable : 1\nHTTPProxy : plain.local')).toBe('http://plain.local:80')
    expect(proxyInternals.parseMacProxy('HTTPEnable : 0\nHTTPProxy : plain.local')).toBeNull()
  })

  it('always bypasses loopback and applies domains, ports, wildcards, and invalid inputs', () => {
    expect(shouldBypassProxy('not a url', '*')).toBe(false)
    expect(shouldBypassProxy('http://localhost:32180', '')).toBe(true)
    expect(shouldBypassProxy('http://127.0.0.1', '')).toBe(true)
    expect(shouldBypassProxy('http://[::1]:32180', '')).toBe(true)
    expect(shouldBypassProxy('https://example.com', '*')).toBe(true)
    expect(shouldBypassProxy('https://api.example.com', '.example.com')).toBe(true)
    expect(shouldBypassProxy('https://example.com:8443', 'example.com:8443')).toBe(true)
    expect(shouldBypassProxy('https://example.com', 'example.com:8443')).toBe(false)
    expect(shouldBypassProxy('https://notexample.com', 'example.com')).toBe(false)
    expect(shouldBypassProxy('http://example.com', 'example.com:80')).toBe(true)
    expect(shouldBypassProxy('http://[2001:db8::1]:8080', '[2001:db8::1]:8080')).toBe(true)
    expect(shouldBypassProxy('http://[2001:db8::1]:8081', '[2001:db8::1]:8080')).toBe(false)
    expect(shouldBypassProxy('http://[2001:db8::1]', '[2001:db8::1]')).toBe(true)
  })
})

describe('ProxyManager detection', () => {
  it('supports direct and manual modes with scheme normalization and agent reuse', async () => {
    store.update({ network: { ...store.get().network, mode: 'direct', noProxy: 'local.test' } })
    expect(await proxy.detect()).toMatchObject({ mode: 'direct', source: 'direct', proxy: null, noProxy: 'local.test' })

    store.update({ network: { ...store.get().network, mode: 'manual', manualProxy: 'proxy.local:8080' } })
    expect(await proxy.detect()).toMatchObject({ source: 'manual', proxy: 'http://proxy.local:8080' })
    const dispatcher = proxy.dispatcherFor('https://example.com')
    expect(proxy.dispatcherFor('https://example.com')).toBe(dispatcher)
    expect(proxy.dispatcherFor('http://127.0.0.1:32180')).toBeUndefined()

    store.update({ network: { ...store.get().network, mode: 'manual', manualProxy: undefined } })
    expect(await proxy.detect()).toMatchObject({ source: 'direct', proxy: null })
    expect(proxy.dispatcherFor('https://example.com')).toBeUndefined()
  })

  it('prefers environment proxy settings without executing system detection', async () => {
    process.env.HTTPS_PROXY = 'http://environment.local:8080'
    process.env.NO_PROXY = 'env.local'
    store.update({ network: { ...store.get().network, mode: 'auto', noProxy: 'config.local' } })

    expect(await proxy.detect()).toMatchObject({ source: 'environment', proxy: 'http://environment.local:8080', noProxy: 'env.local,config.local' })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('detects Windows system proxy settings through the expected registry command', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    execFileMock.mockResolvedValue({ stdout: 'ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ windows.local:8080', stderr: '' })

    expect(await proxy.detect()).toMatchObject({ source: 'system', proxy: 'http://windows.local:8080' })
    expect(execFileMock).toHaveBeenCalledWith('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { windowsHide: true })
  })

  it('detects macOS and Linux manual system proxies', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    execFileMock.mockResolvedValue({ stdout: 'HTTPSEnable : 1\nHTTPSProxy : mac.local\nHTTPSPort : 8443', stderr: '' })
    expect(await proxy.detect()).toMatchObject({ source: 'system', proxy: 'http://mac.local:8443' })
    expect(execFileMock).toHaveBeenCalledWith('scutil', ['--proxy'], { windowsHide: true })

    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    execFileMock.mockImplementation(async (_command: string, args: string[]) => {
      const key = args.join(' ')
      const stdout = key.includes(' mode') ? "'manual'\n" : key.includes(' host') ? "'linux.local'\n" : '8080\n'
      return { stdout, stderr: '' }
    })
    expect(await proxy.detect()).toMatchObject({ source: 'system', proxy: 'http://linux.local:8080' })
  })

  it('falls back to direct for disabled or unavailable Linux system settings', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    execFileMock.mockResolvedValue({ stdout: "'none'\n", stderr: '' })
    expect(await proxy.detect()).toMatchObject({ source: 'direct', proxy: null })

    execFileMock.mockRejectedValue(new Error('gsettings unavailable'))
    expect(await proxy.detect()).toMatchObject({ source: 'direct', proxy: null })
  })

  it('retains the last proxy state when system detection fails', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    execFileMock.mockRejectedValue(new Error('registry denied'))

    expect(await proxy.detect()).toMatchObject({ source: 'direct', proxy: null, error: 'registry denied' })
  })

  it('does not let a stale system detection overwrite newer direct settings', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    let resolveRegistry!: (value: { stdout: string; stderr: string }) => void
    execFileMock.mockImplementation(() => new Promise((resolve) => {
      resolveRegistry = resolve
    }))
    const pending = proxy.detect()
    store.update({ network: { ...store.get().network, mode: 'direct' } })
    await expect(proxy.detect()).resolves.toMatchObject({ mode: 'direct', source: 'direct', proxy: null })

    resolveRegistry({ stdout: 'ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ stale.local:8080', stderr: '' })
    await expect(pending).resolves.toMatchObject({ mode: 'direct', source: 'direct', proxy: null })
    expect(proxy.getState()).toMatchObject({ mode: 'direct', source: 'direct', proxy: null })
  })

  it('refreshes on the configured interval and stops its timer', async () => {
    vi.useFakeTimers()
    store.update({ network: { ...store.get().network, mode: 'direct', refreshIntervalMs: 100 } })
    await proxy.start()
    const initialCheckedAt = proxy.getState().checkedAt
    await vi.advanceTimersByTimeAsync(3000)
    expect(Date.parse(proxy.getState().checkedAt)).toBeGreaterThan(Date.parse(initialCheckedAt))

    await proxy.stop()
    const stoppedCheckedAt = proxy.getState().checkedAt
    await vi.advanceTimersByTimeAsync(3000)
    expect(proxy.getState().checkedAt).toBe(stoppedCheckedAt)
  })

  it('fetches real loopback resources without using a proxy', async () => {
    store.update({ network: { ...store.get().network, mode: 'direct' } })
    await proxy.detect()
    const server = createServer((_request, response) => response.end('loopback-ok'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test server address')

    try {
      const response = await proxy.fetch(`http://127.0.0.1:${address.port}/health`)
      expect(response.status).toBe(200)
      await expect(response.text()).resolves.toBe('loopback-ok')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})