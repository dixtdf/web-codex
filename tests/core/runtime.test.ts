import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigStore } from '../../src/core/config-store'
import { Runtime } from '../../src/core/runtime'

let temporaryDirectory: string
let runtime: Runtime

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'web-codex-runtime-'))
  const configPath = join(temporaryDirectory, 'config.json')
  const seed = new ConfigStore(configPath)
  await seed.load()
  seed.update({
    network: { ...seed.get().network, mode: 'direct', refreshIntervalMs: 3000 },
    gateway: { ...seed.get().gateway, port: 0, autoStart: false },
    tunnel: { ...seed.get().tunnel, autoStart: false }
  })
  await seed.flush()
  runtime = new Runtime(configPath)
  await runtime.initialize()
})

afterEach(async () => {
  await runtime.stop()
  await rm(temporaryDirectory, { recursive: true, force: true })
})

describe('Runtime orchestration', () => {
  it('initializes services, emits snapshots, applies config, and starts without account dependencies', async () => {
    const listener = vi.fn()
    runtime.on('change', listener)
    runtime.privileged = true

    expect(runtime.snapshot()).toMatchObject({
      gateway: { running: false },
      tunnel: { running: false },
      proxy: { source: 'direct', proxy: null },
      tasks: [],
      mcpConnections: [],
      privileged: true
    })

    const updated = runtime.updateConfig({ ui: { theme: 'dark', startMinimized: true } })
    expect(updated.ui).toEqual({ theme: 'dark', startMinimized: true })
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ privileged: true }))

    await runtime.start()
    expect(runtime.snapshot().proxy.mode).toBe('direct')
    expect(runtime.gateway.getState().running).toBe(false)
    expect(runtime.tunnel.getState().running).toBe(false)

    await runtime.stop()
    expect(runtime.snapshot().tasks).toEqual([])
  })

  it('emergency-stops the gateway and all active shell tasks', async () => {
    const project = await runtime.projects.create({ path: join(temporaryDirectory, 'workspace') })
    await runtime.gateway.start()
    const task = await runtime.shell.run({
      projectId: project.id,
      command: `node -e "setTimeout(() => {}, 30000)"`,
      wait: false
    })
    expect(runtime.gateway.getState().running).toBe(true)
    expect(runtime.shell.get(task.id).status).toBe('running')

    await runtime.emergencyStop()

    expect(runtime.gateway.getState()).toEqual({ running: false, detail: 'Stopped' })
    expect(runtime.shell.get(task.id).status).toBe('stopped')
    expect(runtime.tunnel.getState().running).toBe(false)
  })

  it('starts the configured gateway automatically and stops it cleanly', async () => {
    const config = runtime.store.get()
    runtime.store.update({ gateway: { ...config.gateway, autoStart: true } })

    await runtime.start()
    expect(runtime.gateway.getState().running).toBe(true)
    expect(runtime.tunnel.getState().running).toBe(false)

    await runtime.stop()
    expect(runtime.gateway.getState().running).toBe(false)
    expect(runtime.tunnel.getState().running).toBe(false)
  })

  it('surfaces missing Tunnel credentials during automatic startup', async () => {
    const config = runtime.store.get()
    runtime.store.update({
      gateway: { ...config.gateway, autoStart: true },
      tunnel: { ...config.tunnel, autoStart: true, tunnelId: '', apiKey: '' }
    })

    await expect(runtime.start()).rejects.toMatchObject({ code: 'TUNNEL_CREDENTIALS_REQUIRED' })
    expect(runtime.gateway.getState().running).toBe(true)
    expect(runtime.tunnel.getState()).toMatchObject({ running: false, detail: 'Tunnel credentials required' })
  })
})