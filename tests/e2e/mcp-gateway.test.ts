import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import packageJson from '../../package.json'
import { ConfigStore } from '../../src/core/config-store'
import { FileService } from '../../src/core/file-service'
import { McpGateway } from '../../src/core/mcp-gateway'
import { McpHub } from '../../src/core/mcp-hub'
import { ProjectService } from '../../src/core/project-service'
import { ProxyManager } from '../../src/core/proxy-manager'
import { ShellService } from '../../src/core/shell-service'
import type { Project } from '../../src/shared/types'

interface RpcResponse {
  jsonrpc: string
  id: number | null
  result?: {
    protocolVersion?: string
    serverInfo?: { name: string; version: string }
    resultType?: string
    supportedVersions?: string[]
    capabilities?: Record<string, unknown>
    tools?: Array<{ name: string }>
    structuredContent?: { result: unknown }
    isError?: boolean
    content?: Array<{ type: string; text: string }>
  }
  error?: { code: number; message: string }
}

let temporaryDirectory: string
let store: ConfigStore
let gateway: McpGateway
let projects: ProjectService
let shell: ShellService
let project: Project
let mcpUrl: string
let origin: string

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'web-codex-gateway-'))
  store = new ConfigStore(join(temporaryDirectory, 'config.json'))
  await store.load()
  const config = store.get()
  store.update({ gateway: { ...config.gateway, port: 0, authToken: 'integration-test-token' } })
  projects = new ProjectService(store)
  project = await projects.create({ path: join(temporaryDirectory, 'workspace') })
  const files = new FileService(projects)
  shell = new ShellService(projects)
  const proxy = new ProxyManager(store)
  const hub = new McpHub(store, proxy)
  gateway = new McpGateway({ store, projects, files, shell, hub })
  const state = await gateway.start()
  mcpUrl = state.address ?? ''
  origin = mcpUrl.slice(0, -'/mcp'.length)
})

afterEach(async () => {
  await gateway.stop()
  await store.flush()
  await rm(temporaryDirectory, { recursive: true, force: true })
})

describe('MCP Gateway HTTP transport', () => {
  it('serves health checks and CORS while protecting every MCP method with Bearer auth', async () => {
    const health = await fetch(`${origin}/healthz`)
    expect(health.status).toBe(200)
    await expect(health.json()).resolves.toEqual({ ok: true, name: 'web-codex' })

    const unauthorized = await fetch(mcpUrl, rpcOptions(1, 'tools/list', undefined, false))
    expect(unauthorized.status).toBe(401)
    expect(unauthorized.headers.get('www-authenticate')).toBe('Bearer realm="web-codex"')
    await expect(unauthorized.json()).resolves.toEqual({ error: 'Unauthorized' })

    const metadata = await fetch(`${origin}/.well-known/oauth-protected-resource`)
    expect(metadata.status).toBe(404)

    const preflight = await fetch(mcpUrl, { method: 'OPTIONS' })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Mcp-Session-Id')

    const get = await fetch(mcpUrl, authorizedOptions('GET'))
    expect(get.status).toBe(405)
    const remove = await fetch(mcpUrl, authorizedOptions('DELETE'))
    expect(remove.status).toBe(405)
  })

  it('initializes the MCP protocol and lists all workspace tools', async () => {
    const discovered = await rpc(0, 'server/discover', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } })
    expect(discovered.result).toMatchObject({ resultType: 'complete', capabilities: { tools: {} } })
    expect(discovered.result?.supportedVersions).toContain('2026-07-28')

    const initialized = await rpc(1, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'vitest-client', version: '1.0.0' }
    })
    expect(initialized.error).toBeUndefined()
    expect(initialized.result).toMatchObject({ protocolVersion: '2025-03-26', serverInfo: { name: 'web-codex', version: packageJson.version } })

    const listed = await rpc(2, 'tools/list')
    const names = listed.result?.tools?.map((tool) => tool.name) ?? []
    expect(names).toEqual(expect.arrayContaining([
      'project_list', 'project_context_get', 'file_list', 'file_read', 'file_write', 'file_patch', 'file_search',
      'file_mkdir', 'file_move', 'file_delete', 'file_read_binary', 'file_write_binary', 'file_archive_create', 'file_archive_extract', 'shell_run', 'shell_task_list', 'shell_task_get', 'shell_task_stop',
      'mcp_server_list', 'mcp_tool_list', 'mcp_tool_call'
    ]))
    expect(new Set(names).size).toBe(names.length)
  })

  it('executes project and file tools against the registered workspace', async () => {
    const projects = await callTool(10, 'project_list')
    expect(projects).toEqual([expect.objectContaining({ id: project.id, path: project.path })])

    await callTool(11, 'file_write', { path: 'docs/note.txt', content: 'from MCP' })
    await expect(readFile(join(project.path, 'docs', 'note.txt'), 'utf8')).resolves.toBe('from MCP')
    await expect(callTool(12, 'file_read', { path: 'docs/note.txt' })).resolves.toMatchObject({ content: 'from MCP', truncated: false })

    const context = await callTool(13, 'project_context_get')
    expect(context).toMatchObject({ project: { id: project.id }, instructions: '', instructionFile: null })
  })

  it('transfers binary files and archives through MCP', async () => {
    const first = Buffer.from([0, 255, 1, 2])
    const second = Buffer.from([3, 254, 4, 253])
    await expect(callTool(14, 'file_write_binary', { path: 'models/bracket.stl', base64: first.toString('base64') })).resolves.toMatchObject({ bytes: 4, size: 4 })
    await expect(callTool(15, 'file_write_binary', { path: 'models/bracket.stl', base64: second.toString('base64'), offset: 4 })).resolves.toMatchObject({ bytes: 4, size: 8 })
    const chunk = await callTool(16, 'file_read_binary', { path: 'models/bracket.stl', offset: 2, maxBytes: 4 }) as { base64: string; nextOffset: number; truncated: boolean }
    expect(chunk.base64).toBe(Buffer.from([1, 2, 3, 254]).toString('base64'))
    expect(chunk).toMatchObject({ nextOffset: 6, truncated: true })

    await expect(callTool(17, 'file_archive_create', { sourcePath: 'models', destinationPath: 'models.zip' })).resolves.toMatchObject({ files: 1 })
    await expect(callTool(18, 'file_archive_extract', { archivePath: 'models.zip', destinationPath: 'imported' })).resolves.toMatchObject({ files: 1, path: 'imported' })
    expect(await readFile(join(project.path, 'imported', 'bracket.stl'))).toEqual(Buffer.concat([first, second]))
  })

  it('runs shell tools and exposes task retrieval through MCP', async () => {
    const completed = await callTool(20, 'shell_run', { command: 'node -p 42', timeoutMs: 10_000 })
    expect(completed).toMatchObject({ status: 'completed', exitCode: 0, stdout: '42\n' })
    const taskId = (completed as { id: string }).id

    await expect(callTool(21, 'shell_task_get', { taskId })).resolves.toMatchObject({ id: taskId, status: 'completed' })
    const tasks = await callTool(22, 'shell_task_list')
    expect(tasks).toEqual([expect.objectContaining({ id: taskId, stdout: '42\n' })])
  })

  it('returns tool-level errors without compromising the HTTP transport', async () => {
    const response = await rpc(30, 'tools/call', {
      name: 'file_read',
      arguments: { projectId: project.id, path: '../outside.txt' }
    })
    expect(response.result?.isError).toBe(true)
    expect(response.result?.content?.[0]?.text).toContain('Path leaves the project folder')

    const downstream = await rpc(31, 'tools/call', { name: 'mcp_tool_call', arguments: { name: 'missing__tool' } })
    expect(downstream.result?.isError).toBe(true)
    expect(downstream.result?.content?.[0]?.text).toContain('Namespaced MCP tool not found')
  })

  it('keeps startup idempotent and rejects non-loopback listeners', async () => {
    await expect(gateway.start()).resolves.toMatchObject({ running: true, address: mcpUrl })
    await gateway.stop()
    await gateway.stop()
    expect(gateway.getState()).toEqual({ running: false, detail: 'Stopped' })

    const config = store.get()
    store.update({ gateway: { ...config.gateway, host: '0.0.0.0' } })
    await expect(gateway.start()).rejects.toThrow('MCP Gateway must listen on a loopback address')
  })

  it('can retry startup after a port conflict is resolved', async () => {
    await gateway.stop()
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()))
    const address = blocker.address()
    if (!address || typeof address === 'string') throw new Error('Missing blocker port')
    const config = store.get()
    store.update({ gateway: { ...config.gateway, port: address.port } })

    await expect(gateway.start()).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(gateway.getState().running).toBe(false)

    await new Promise<void>((resolve) => blocker.close(() => resolve()))
    await expect(gateway.start()).resolves.toMatchObject({ running: true, address: `http://127.0.0.1:${address.port}/mcp` })
  })

  it('exposes every remaining file operation through MCP', async () => {
    await callTool(40, 'file_mkdir', { path: 'folder' })
    await callTool(41, 'file_write', { path: 'folder/a.txt', content: 'Alpha' })
    await expect(callTool(42, 'file_patch', { path: 'folder/a.txt', oldText: 'Alpha', newText: 'Beta' })).resolves.toMatchObject({ replacements: 1 })
    await expect(callTool(43, 'file_search', { path: 'folder', query: 'Beta' })).resolves.toEqual([
      { path: 'folder/a.txt', line: 1, column: 1, preview: 'Beta' }
    ])
    await expect(callTool(44, 'file_list', { path: 'folder' })).resolves.toEqual([
      expect.objectContaining({ name: 'a.txt', type: 'file' })
    ])
    await callTool(45, 'file_move', { sourcePath: 'folder/a.txt', destinationPath: 'folder/b.txt' })
    await expect(callTool(46, 'file_read', { path: 'folder/b.txt' })).resolves.toMatchObject({ content: 'Beta' })
    await callTool(47, 'file_delete', { path: 'folder/b.txt' })
    await callTool(48, 'file_delete', { path: 'folder', recursive: true })
    await expect(callTool(49, 'file_list')).resolves.toEqual([])
  })

  it('lists downstream state and stops background shell tasks through MCP', async () => {
    await expect(callTool(50, 'mcp_server_list')).resolves.toEqual([])
    await expect(callTool(51, 'mcp_tool_list')).resolves.toEqual([])
    const started = await callTool(52, 'shell_run', { command: `node -e "setTimeout(() => {}, 30000)"`, wait: false })
    const taskId = (started as { id: string }).id
    await expect(callTool(53, 'shell_task_stop', { taskId })).resolves.toMatchObject({ id: taskId, status: 'stopped' })
  })

  it('enforces per-project remote shell policies without disabling local tasks', async () => {
    await projects.update(project.id, { remoteShell: { mode: 'deny', allowedPrefixes: [] } })
    const denied = await rpc(60, 'tools/call', { name: 'shell_run', arguments: { projectId: project.id, command: 'node -p 7' } })
    expect(denied.result?.isError).toBe(true)
    expect(denied.result?.content?.[0]?.text).toContain('Remote shell access is disabled for this project')

    const localTask = await shell.run({ projectId: project.id, command: 'node -p 7' })
    expect(localTask).toMatchObject({ status: 'completed', exitCode: 0 })

    await projects.update(project.id, { remoteShell: { mode: 'allowlist', allowedPrefixes: ['node --version'] } })
    const allowed = await rpc(61, 'tools/call', { name: 'shell_run', arguments: { projectId: project.id, command: 'node --version' } })
    expect(allowed.result?.isError).not.toBe(true)
    expect(allowed.result?.structuredContent?.result).toMatchObject({ status: 'completed', exitCode: 0 })

    const disallowed = await rpc(62, 'tools/call', { name: 'shell_run', arguments: { projectId: project.id, command: 'node -p 7' } })
    expect(disallowed.result?.isError).toBe(true)
    expect(disallowed.result?.content?.[0]?.text).toContain('does not match this project command allowlist')

    const chained = await rpc(63, 'tools/call', { name: 'shell_run', arguments: { projectId: project.id, command: 'node --version; whoami' } })
    expect(chained.result?.isError).toBe(true)
    expect(chained.result?.content?.[0]?.text).toContain('not allowed by the project allowlist')
  })
})

function authorizedOptions(method: string): RequestInit {
  return {
    method,
    headers: { Authorization: 'Bearer integration-test-token' }
  }
}

function rpcOptions(id: number, method: string, params?: Record<string, unknown>, authenticated = true): RequestInit {
  return {
    method: 'POST',
    headers: {
      ...(authenticated ? { Authorization: 'Bearer integration-test-token' } : {}),
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  }
}

async function rpc(id: number, method: string, params?: Record<string, unknown>): Promise<RpcResponse> {
  const response = await fetch(mcpUrl, rpcOptions(id, method, params))
  expect(response.status).toBe(200)
  return await response.json() as RpcResponse
}

async function callTool(id: number, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const response = await rpc(id, 'tools/call', { name, arguments: { projectId: project.id, ...args } })
  expect(response.result?.isError).not.toBe(true)
  return response.result?.structuredContent?.result
}