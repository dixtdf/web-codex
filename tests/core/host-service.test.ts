import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '../../src/core/config-store'
import { HostService } from '../../src/core/host-service'
import { ProjectService } from '../../src/core/project-service'
import { ProxyManager } from '../../src/core/proxy-manager'
import type { Project } from '../../src/shared/types'

let temporaryDirectory: string
let project: Project
let host: HostService

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'web-codex-host-'))
  const store = new ConfigStore(join(temporaryDirectory, 'config.json'))
  await store.load()
  store.update({ network: { ...store.get().network, mode: 'direct' } })
  const projects = new ProjectService(store)
  project = await projects.create({ path: join(temporaryDirectory, 'workspace') })
  const proxy = new ProxyManager(store)
  await proxy.detect()
  host = new HostService(projects, proxy, () => true)
})

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true })
})

describe('HostService capabilities', () => {
  it('reports bounded host, resource, tool, project, proxy, and execution-boundary data', async () => {
    const capabilities = await host.capabilities(project.id)

    expect(capabilities.host).toMatchObject({ platform: process.platform, arch: process.arch, privileged: true, home: expect.any(String) })
    expect(capabilities.resources.cpuCount).toBeGreaterThan(0)
    expect(capabilities.resources.totalMemoryBytes).toBeGreaterThan(0)
    expect(capabilities.runtimes.node).toBe(process.version)
    expect(capabilities.tools.node).toEqual(expect.objectContaining({ available: true, path: expect.any(String) }))
    expect(capabilities.project).toMatchObject({ id: project.id, root: project.path, enabled: true, remoteShellMode: 'allow' })
    expect(capabilities.proxy).toMatchObject({ mode: 'direct', source: 'direct' })
    expect(capabilities.executionBoundary.sandboxed).toBe(false)
    expect(capabilities.features).toEqual(expect.arrayContaining(['files', 'binary-transfer', 'uploads', 'shell', 'git', 'trash']))
    expect(Object.keys(capabilities.environment)).not.toContain('WEB_CODEX_TOKEN')
    expect(Object.keys(capabilities.environment).length).toBeLessThanOrEqual(5)
  })

  it('supports host-only queries, caches tool detection, and rejects unknown projects', async () => {
    const first = await host.capabilities()
    const second = await host.capabilities()
    expect(first.project).toBeUndefined()
    expect(second.tools).toEqual(first.tools)
    await expect(host.capabilities('missing')).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })
  })
})