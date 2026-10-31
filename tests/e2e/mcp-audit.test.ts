import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ActivityLogger } from '../../src/core/activity-logger'
import { ConfigStore } from '../../src/core/config-store'
import { FileService } from '../../src/core/file-service'
import { McpGateway } from '../../src/core/mcp-gateway'
import { McpHub } from '../../src/core/mcp-hub'
import { ProjectService } from '../../src/core/project-service'
import { ProxyManager } from '../../src/core/proxy-manager'
import { ShellService } from '../../src/core/shell-service'
import type { AuditLogEvent, Project } from '../../src/shared/types'

let temporaryDirectory: string
let store: ConfigStore
let logger: ActivityLogger
let gateway: McpGateway
let project: Project
let mcpUrl: string

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'web-codex-remote-audit-'))
  store = new ConfigStore(join(temporaryDirectory, 'config.json'))
  await store.load()
  store.update({ gateway: { ...store.get().gateway, port: 0, authToken: 'integration-test-token' } })
  logger = new ActivityLogger(join(temporaryDirectory, 'logs'), { secrets: () => [store.get().gateway.authToken] })
  await logger.initialize()
  const projects = new ProjectService(store)
  project = await projects.create({ path: join(temporaryDirectory, 'workspace') })
  const files = new FileService(projects)
  const shell = new ShellService(projects, logger)
  const proxy = new ProxyManager(store, logger)
  const hub = new McpHub(store, proxy, logger)
  gateway = new McpGateway({ store, projects, files, shell, hub, logger })
  mcpUrl = (await gateway.start()).address ?? ''
})

afterEach(async () => {
  await gateway.stop()
  await logger.flush()
  await store.flush()
  await rm(temporaryDirectory, { recursive: true, force: true })
})

describe('remote MCP JSONL audit', () => {
  it('links remote requests and shell actions while omitting secrets and file content', async () => {
    await callTool('audit-shell', 'shell_run', { command: 'node -p 42' })
    await callTool('audit-file', 'file_write', { path: 'private.txt', content: 'raw-private-content' })
    await callTool('audit-downstream', 'mcp_tool_call', {
      name: 'missing__tool',
      arguments: { token: 'argument-secret', nested: { value: 'nested-secret' } }
    })
    await logger.flush()

    const raw = await readAuditText()
    const events = raw.trim().split('\n').map((line) => JSON.parse(line) as AuditLogEvent)
    const shellStart = events.find((event) => event.action === 'shell.start' && event.requestId === 'audit-shell')
    expect(shellStart).toMatchObject({ origin: 'remote', projectId: project.id, taskId: expect.any(String) })
    expect(JSON.stringify(shellStart?.data)).toContain('node -p 42')

    const downstreamRequest = events.find((event) => event.action === 'gateway.request' && event.requestId === 'audit-downstream')
    expect(JSON.stringify(downstreamRequest?.data)).toContain('"omitted":true')
    expect(JSON.stringify(downstreamRequest?.data)).toContain('"keys":["token","nested"]')
    expect(raw).toContain('"content":{"omitted":true,"bytes":19,"sha256":')
    for (const secret of ['integration-test-token', 'raw-private-content', 'argument-secret', 'nested-secret']) {
      expect(raw).not.toContain(secret)
    }
  })

  it('records only batch metadata instead of arbitrary batch argument values', async () => {
    const response = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer integration-test-token',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify([{ jsonrpc: '2.0', id: 'batch-1', method: 'tools/call', params: { name: 'file_write', arguments: { projectId: project.id, path: 'batch.txt', content: 'batch-secret' } } }])
    })
    expect(response.status).not.toBe(401)
    await response.text()
    await logger.flush()

    const raw = await readAuditText()
    expect(raw).toContain('"entries":1')
    expect(raw).not.toContain('batch-secret')
  })
})

async function callTool(id: string, name: string, args: Record<string, unknown>): Promise<void> {
  const response = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer integration-test-token',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { projectId: project.id, ...args } } })
  })
  expect(response.status).toBe(200)
  await response.text()
}

async function readAuditText(): Promise<string> {
  const directory = join(temporaryDirectory, 'logs')
  const files = (await readdir(directory)).filter((file) => file.endsWith('.jsonl')).sort()
  const contents = await Promise.all(files.map((file) => readFile(join(directory, file), 'utf8')))
  return contents.join('')
}