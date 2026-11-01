import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import packageJson from '../../package.json'
import { ConfigStore } from '../../src/core/config-store'
import { FileService } from '../../src/core/file-service'
import { GitService } from '../../src/core/git-service'
import { HostService } from '../../src/core/host-service'
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
    tools?: Array<{ name: string; inputSchema?: { additionalProperties?: boolean; properties?: Record<string, unknown> } }>
    structuredContent?: { result?: unknown; error?: { code: string; message: string; details?: unknown } }
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
  const files = new FileService(projects, { trashDirectory: join(temporaryDirectory, 'trash') })
  shell = new ShellService(projects)
  const proxy = new ProxyManager(store)
  const hub = new McpHub(store, proxy)
  const git = new GitService(projects)
  const host = new HostService(projects, proxy, () => false)
  gateway = new McpGateway({ store, projects, files, shell, hub, git, host })
  const state = await gateway.start()
  mcpUrl = state.address ?? ''
  origin = mcpUrl.slice(0, -'/mcp'.length)
})

afterEach(async () => {
  await gateway.stop()
  await store.flush()
  await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
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

  it('returns a JSON-RPC parse error for malformed authenticated requests', async () => {
    const response = await fetch(mcpUrl, {
      method: 'POST',
      headers: { Authorization: 'Bearer integration-test-token', 'Content-Type': 'application/json' },
      body: '{"jsonrpc":"2.0"'
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } })
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
      'file_mkdir', 'file_move', 'file_delete', 'file_hash', 'file_attributes', 'file_copy', 'file_delete_plan', 'file_backup', 'trash_list', 'trash_restore',
      'file_read_binary', 'file_download', 'file_transfer_status', 'file_write_binary', 'file_archive_create', 'file_archive_extract',
      'upload_list', 'upload_copy', 'upload_extract', 'shell_run', 'process_run', 'shell_task_list', 'shell_task_get', 'shell_task_output',
      'shell_task_input', 'shell_task_close_input', 'shell_task_stop', 'git_status', 'git_diff', 'git_log', 'git_branch_list', 'git_worktree_list', 'git_stage',
      'git_worktree_add', 'git_worktree_remove', 'git_conflict_list', 'git_resolve_conflicts', 'git_commit', 'host_capabilities', 'connection_health', 'project_create', 'project_update', 'project_remove', 'project_instructions_update',
      'mcp_server_list', 'mcp_tool_list', 'mcp_tool_call', 'mcp_resource_list', 'mcp_resource_read', 'mcp_prompt_list', 'mcp_prompt_get'
    ]))
    expect(new Set(names).size).toBe(names.length)
    const tools = listed.result?.tools ?? []
    for (const tool of tools) expect(tool.inputSchema?.additionalProperties, tool.name).toBe(false)
    const expectedArguments: Record<string, string[]> = {
      file_write: ['expectedSha256'],
      file_patch: ['expectedSha256', 'dryRun'],
      file_move: ['overwrite', 'expectedSourceSha256', 'expectedDestinationSha256'],
      file_delete: ['dryRun', 'expectedSha256'],
      file_search: ['respectGitignore', 'cursor', 'includeGlobs', 'excludeGlobs'],
      shell_task_list: ['projectId', 'status', 'limit', 'cursor'],
      shell_task_output: ['taskId', 'stream', 'offset', 'maxBytes'],
      shell_task_input: ['taskId', 'data', 'appendNewline']
    }
    for (const [name, arguments_] of Object.entries(expectedArguments)) {
      const tool = tools.find((candidate) => candidate.name === name)
      for (const argument of arguments_) expect(tool?.inputSchema?.properties, `${name}.${argument}`).toHaveProperty(argument)
    }
  })

  it('reports host and connection health and exposes empty downstream resource collections', async () => {
    await expect(callTool(3, 'connection_health')).resolves.toMatchObject({
      healthy: true,
      versions: { webCodex: packageJson.version },
      gateway: { authentication: 'bearer' },
      services: { files: true, shell: true },
      sandboxed: false
    })
    await expect(callTool(4, 'host_capabilities')).resolves.toMatchObject({
      host: { platform: process.platform },
      resources: { cpuCount: expect.any(Number) },
      executionBoundary: { sandboxed: false }
    })
    await expect(callTool(5, 'mcp_resource_list')).resolves.toEqual([])
    await expect(callTool(6, 'mcp_prompt_list')).resolves.toEqual([])
  })

  it('executes project and file tools against the registered workspace', async () => {
    const projects = await callTool(10, 'project_list')
    expect(projects).toEqual([expect.objectContaining({ id: project.id, path: project.path })])

    await callTool(11, 'file_write', { path: 'docs/note.txt', content: 'from MCP' })
    await expect(readFile(join(project.path, 'docs', 'note.txt'), 'utf8')).resolves.toBe('from MCP')
    await expect(callTool(12, 'file_read', { path: 'docs/note.txt' })).resolves.toMatchObject({ content: 'from MCP', actualOffset: 0, requestedOffset: 0, nextOffset: 8, bytes: 8, truncated: false })

    const context = await callTool(13, 'project_context_get')
    expect(context).toMatchObject({ project: { id: project.id }, instructions: '', instructionFile: null })
  })

  it('reports stale project registrations without treating enabled as accessible', async () => {
    const stale = await projects.create({ path: join(temporaryDirectory, 'missing-workspace') })
    await rm(stale.path, { recursive: true, force: true })
    const listed = await callTool(103, 'project_list') as Array<{ id: string; enabled: boolean; health: { accessible: boolean; status: string; error: string | null } }>
    expect(listed).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: project.id, health: { accessible: true, status: 'ready', error: null } }),
      expect.objectContaining({ id: stale.id, enabled: true, health: { accessible: false, status: 'unavailable', error: expect.any(String) } })
    ]))
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

  it('runs file recovery, transfer diagnostics, and Git tools through MCP', async () => {
    await callTool(70, 'process_run', { executable: 'git', args: ['init', '-b', 'main'] })
    await callTool(71, 'process_run', { executable: 'git', args: ['config', 'user.name', 'MCP Test'] })
    await callTool(72, 'process_run', { executable: 'git', args: ['config', 'user.email', 'mcp@example.test'] })
    await callTool(73, 'file_write', { path: 'README.md', content: 'hello\n' })

    const hash = await callTool(74, 'file_hash', { path: 'README.md' }) as { sha256: string; size: number }
    expect(hash).toMatchObject({ size: 6, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
    await expect(callTool(90, 'file_attributes', { path: 'README.md' })).resolves.toMatchObject({ type: 'file', size: 6, readable: true })
    await expect(callTool(75, 'file_copy', { sourcePath: 'README.md', destinationPath: 'README-copy.md' })).resolves.toMatchObject({ path: 'README-copy.md', bytes: 6, sha256: hash.sha256 })
    await expect(callTool(76, 'file_delete_plan', { path: 'README-copy.md' })).resolves.toMatchObject({ type: 'file', files: 1, bytes: 6 })
    await expect(callTool(77, 'file_transfer_status', { path: 'README.md' })).resolves.toMatchObject({ sha256: hash.sha256, suggestedChunkCount: 1 })
    await expect(callTool(78, 'file_download', { path: 'README.md', maxBytes: 6 })).resolves.toMatchObject({ nextOffset: 6, truncated: false })

    const backup = await callTool(79, 'file_backup', { path: 'README.md' }) as { id: string }
    await expect(callTool(80, 'file_delete', { path: 'README.md' })).resolves.toMatchObject({ recoverable: true })
    expect(await callTool(81, 'trash_list') as unknown[]).toEqual(expect.arrayContaining([expect.objectContaining({ id: backup.id, reason: 'backup' })]))
    await expect(callTool(82, 'trash_restore', { trashId: backup.id })).resolves.toMatchObject({ path: 'README.md' })

    await expect(callTool(83, 'git_status')).resolves.toMatchObject({ branch: 'main', clean: false })
    await expect(callTool(84, 'git_stage', { paths: ['README.md'] })).resolves.toEqual({ staged: ['README.md'] })
    await expect(callTool(85, 'git_diff', { staged: true })).resolves.toMatchObject({ diff: expect.stringContaining('+hello') })
    await expect(callTool(86, 'git_commit', { message: 'Add README', paths: ['README.md'] })).resolves.toMatchObject({ subject: 'Add README' })
    await expect(callTool(87, 'git_log', { limit: 1 })).resolves.toEqual([expect.objectContaining({ author: 'MCP Test', subject: 'Add README' })])
    expect(await callTool(88, 'git_branch_list')).toEqual([expect.objectContaining({ name: 'main', current: true })])
    await expect(callTool(89, 'git_worktree_list')).resolves.toEqual([expect.objectContaining({ branch: 'main', bare: false })])
    await expect(callTool(91, 'git_worktree_add', { path: '.worktrees/e2e', branch: 'e2e-worktree' })).resolves.toMatchObject({ path: '.worktrees/e2e', branch: 'e2e-worktree' })
    expect(await callTool(92, 'git_worktree_list') as unknown[]).toEqual(expect.arrayContaining([expect.objectContaining({ branch: 'e2e-worktree' })]))
    await expect(callTool(93, 'git_worktree_remove', { path: '.worktrees/e2e' })).resolves.toEqual({ removed: '.worktrees/e2e' })
  })

  it('runs shell tools and exposes task retrieval through MCP', async () => {
    const completed = await callTool(20, 'shell_run', { command: 'node -p 42', timeoutMs: 10_000 })
    expect(completed).toMatchObject({ status: 'completed', exitCode: 0, stdout: '42\n' })
    const taskId = (completed as { id: string }).id

    await expect(callTool(21, 'shell_task_get', { taskId })).resolves.toMatchObject({ id: taskId, status: 'completed' })
    const tasks = await callTool(22, 'shell_task_list') as { tasks: Array<{ id: string; stdoutBytes: number }>; nextCursor: string | null }
    expect(tasks.tasks).toEqual([expect.objectContaining({ id: taskId, stdoutBytes: 3 })])
    expect(tasks.nextCursor).toBeNull()
    await expect(callTool(23, 'shell_task_output', { taskId, stream: 'stdout', offset: 0, maxBytes: 10 })).resolves.toMatchObject({ data: '42\n', eof: true })
    if (process.platform === 'win32') {
      await expect(callTool(24, 'shell_run', { shell: 'cmd', command: 'echo CMD_1453', timeoutMs: 4000 })).resolves.toMatchObject({ status: 'completed', exitCode: 0, stdout: 'CMD_1453\r\n', stderr: '' })
    }
  })

  it('enforces deletion previews, version checks, and strict argument schemas', async () => {
    const original = await callTool(94, 'file_write', { path: 'protected.txt', content: 'OLD' }) as { sha256: string }
    const current = await callTool(95, 'file_write', { path: 'protected.txt', content: 'NEW' }) as { sha256: string }

    const stale = await rpc(96, 'tools/call', { name: 'file_delete', arguments: { projectId: project.id, path: 'protected.txt', expectedSha256: original.sha256 } })
    expect(stale.result?.isError).toBe(true)
    expect(stale.result?.structuredContent?.error).toMatchObject({ code: 'FILE_VERSION_CONFLICT' })
    await expect(callTool(97, 'file_read', { path: 'protected.txt' })).resolves.toMatchObject({ content: 'NEW' })

    const unknown = await rpc(98, 'tools/call', { name: 'file_delete', arguments: { projectId: project.id, path: 'protected.txt', dryRun: true, unexpectedOption: true } })
    expect(unknown.result?.isError).toBe(true)
    expect(unknown.result?.content?.[0]?.text).toContain('unexpectedOption')
    const nestedUnknown = await rpc(104, 'tools/call', { name: 'project_update', arguments: { projectId: project.id, remoteShell: { mode: 'allow', allowedPrefixes: [], unexpectedOption: true } } })
    expect(nestedUnknown.result?.isError).toBe(true)
    expect(nestedUnknown.result?.content?.[0]?.text).toContain('unexpectedOption')
    await expect(callTool(99, 'file_read', { path: 'protected.txt' })).resolves.toMatchObject({ content: 'NEW' })
    await expect(callTool(100, 'file_delete', { path: 'protected.txt', expectedSha256: current.sha256, dryRun: true })).resolves.toMatchObject({ dryRun: true, trashId: null })
    await expect(callTool(101, 'file_read', { path: 'protected.txt' })).resolves.toMatchObject({ content: 'NEW' })
    await expect(callTool(102, 'file_delete', { path: 'protected.txt', expectedSha256: current.sha256 })).resolves.toMatchObject({ dryRun: false, trashId: expect.any(String) })
  })

  it('returns tool-level errors without compromising the HTTP transport', async () => {
    const response = await rpc(30, 'tools/call', {
      name: 'file_read',
      arguments: { projectId: project.id, path: '../outside.txt' }
    })
    expect(response.result?.isError).toBe(true)
    expect(response.result?.structuredContent?.error).toMatchObject({ code: 'PATH_OUTSIDE_PROJECT', message: 'Path leaves the project folder' })
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
    await expect(callTool(43, 'file_search', { path: 'folder', query: 'Beta' })).resolves.toEqual({
      matches: [{ path: 'folder/a.txt', line: 1, column: 1, preview: 'Beta' }],
      nextCursor: null
    })
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

const toolsWithoutImplicitProject = new Set([
  'project_list', 'project_create', 'connection_health', 'trash_list', 'trash_restore', 'upload_list',
  'shell_task_get', 'shell_task_output', 'shell_task_input', 'shell_task_close_input', 'shell_task_stop',
  'mcp_server_list', 'mcp_tool_list', 'mcp_tool_call', 'mcp_resource_list', 'mcp_resource_read', 'mcp_prompt_list', 'mcp_prompt_get'
])

async function callTool(id: number, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const toolArguments = toolsWithoutImplicitProject.has(name) ? args : { projectId: project.id, ...args }
  const response = await rpc(id, 'tools/call', { name, arguments: toolArguments })
  expect(response.result?.isError).not.toBe(true)
  return response.result?.structuredContent?.result
}