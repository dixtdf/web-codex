import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActivityLogger } from '../../src/core/activity-logger'
import { ConfigStore } from '../../src/core/config-store'
import { McpHub } from '../../src/core/mcp-hub'
import { ProxyManager } from '../../src/core/proxy-manager'
import type { McpServerConfig } from '../../src/shared/types'

let temporaryDirectory: string
let store: ConfigStore
let proxy: ProxyManager
let logger: ActivityLogger
let hub: McpHub
let fixtureServer: Server | undefined
let fixtureInitializeRequests = 0
const activeFixtureServers = new Set<McpServer>()

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'web-codex-hub-'))
  store = new ConfigStore(join(temporaryDirectory, 'config.json'))
  await store.load()
  store.update({ network: { ...store.get().network, mode: 'direct' } })
  proxy = new ProxyManager(store)
  await proxy.detect()
  logger = new ActivityLogger(join(temporaryDirectory, 'logs'))
  await logger.initialize()
  hub = new McpHub(store, proxy, logger)
})

afterEach(async () => {
  await hub.stop()
  await Promise.allSettled([...activeFixtureServers].map((server) => server.close()))
  activeFixtureServers.clear()
  if (fixtureServer) await new Promise<void>((resolve) => fixtureServer?.close(() => resolve()))
  fixtureInitializeRequests = 0
  fixtureServer = undefined
  await proxy.stop()
  await logger.flush()
  await store.flush()
  await rm(temporaryDirectory, { recursive: true, force: true })
})

describe('McpHub configuration', () => {
  it('normalizes aliases, rejects duplicates, and validates connection state', async () => {
    const first = stdioConfig({ name: 'Local tools', alias: '  $local tools!  ' })
    const saved = await hub.save(first)
    expect(saved.alias).toBe('local_tools_')
    expect(hub.states()).toEqual([expect.objectContaining({ id: saved.id, connected: false, toolCount: 0 })])

    await expect(hub.save(stdioConfig({ name: 'Other', alias: saved.alias }))).rejects.toMatchObject({ code: 'MCP_ALIAS_DUPLICATE' })
    await expect(hub.save(stdioConfig({ name: '!!!', alias: '!!!' }))).rejects.toMatchObject({ code: 'MCP_ALIAS_INVALID' })
    await expect(hub.connect('missing')).rejects.toMatchObject({ code: 'MCP_SERVER_NOT_FOUND' })

    await hub.save({ ...saved, enabled: false })
    await expect(hub.connect(saved.id)).rejects.toMatchObject({ code: 'MCP_SERVER_DISABLED' })
    await hub.remove(saved.id)
    expect(hub.states()).toEqual([])
    await hub.disconnect('unknown')
  })

  it('rejects recursive connections to the local application', async () => {
    const config = await hub.save(stdioConfig({ command: 'openai', args: ['--web-codex-self'] }))
    await expect(hub.connect(config.id)).rejects.toMatchObject({ code: 'MCP_RECURSIVE_CONNECTION' })
  })
})

describe('McpHub transports', () => {
  it('discovers and calls stdio tools with namespaced structured results', async () => {
    const fixturePath = fileURLToPath(new URL('../fixtures/stdio-mcp-server.mjs', import.meta.url))
    const config = await hub.save(stdioConfig({
      name: 'Fixture',
      alias: 'local',
      command: process.execPath,
      args: [fixturePath],
      env: { FIXTURE_VALUE: 'configured' }
    }))

    await hub.start()
    expect(hub.states()).toEqual([expect.objectContaining({ id: config.id, connected: true, toolCount: 1, error: undefined })])
    expect(hub.listTools()).toEqual([expect.objectContaining({ name: 'local__echo', originalName: 'echo', serverId: config.id, serverName: 'Fixture' })])

    const result = await hub.callTool('local__echo', { text: 'hello' })
    expect(result).toMatchObject({ structuredContent: { transport: 'stdio', text: 'hello', fixtureValue: 'configured' } })
    const auditCall = logger.list({ category: 'mcp', query: 'mcp.tool_call', limit: 1 })[0]
    expect(JSON.stringify(auditCall.data)).toContain('"argumentKeys":["text"]')
    expect(JSON.stringify(auditCall.data)).not.toContain('hello')
    await expect(hub.callTool('local__missing', {})).rejects.toMatchObject({ code: 'MCP_TOOL_NOT_FOUND' })

    expect(await hub.listResources()).toEqual([expect.objectContaining({ uri: 'fixture://readme', name: 'fixture-resource', mimeType: 'text/plain', serverId: config.id })])
    await expect(hub.readResource(config.id, 'fixture://readme')).resolves.toMatchObject({ contents: [expect.objectContaining({ text: 'fixture-resource-body' })] })
    await expect(hub.readResource(config.id, '')).rejects.toMatchObject({ code: 'MCP_RESOURCE_URI_INVALID' })
    expect(await hub.listPrompts()).toEqual([expect.objectContaining({ name: 'greet', serverId: config.id, arguments: [expect.objectContaining({ name: 'name' })] })])
    await expect(hub.getPrompt(config.id, 'greet', { name: 'Codex' })).resolves.toMatchObject({ messages: [expect.objectContaining({ content: expect.objectContaining({ text: 'Hello Codex' }) })] })
    await expect(hub.getPrompt('missing', 'greet')).rejects.toMatchObject({ code: 'MCP_SERVER_NOT_FOUND' })

    await hub.save({ ...config, enabled: false })
    expect(hub.states()).toEqual([expect.objectContaining({ id: config.id, enabled: false, connected: false })])
    expect(hub.listTools()).toEqual([])
    await expect(hub.connect(config.id)).rejects.toMatchObject({ code: 'MCP_SERVER_DISABLED' })
    await hub.disconnect(config.id)
    expect(hub.states()).toEqual([expect.objectContaining({ connected: false })])
    await expect(hub.callTool('local__echo', {})).rejects.toMatchObject({ code: 'MCP_TOOL_NOT_FOUND' })
    expect(await hub.listResources()).toEqual([])
  })

  it('stops advertising tools after the underlying transport closes', async () => {
    const fixturePath = fileURLToPath(new URL('../fixtures/stdio-mcp-server.mjs', import.meta.url))
    const config = await hub.save(stdioConfig({
      alias: 'closing',
      command: process.execPath,
      args: [fixturePath],
      env: { FIXTURE_EXIT_MS: '100' }
    }))
    await hub.connect(config.id)
    expect(hub.listTools()).toHaveLength(1)

    await vi.waitFor(() => expect(hub.states()[0]?.connected).toBe(false))

    expect(hub.listTools()).toEqual([])
  })

  it('discovers and calls Streamable HTTP tools through the proxy-aware fetch path', async () => {
    const url = await startHttpFixture()
    const config = await hub.save({
      name: 'Remote fixture',
      alias: 'remote',
      enabled: true,
      transport: 'streamable-http',
      url,
      headers: { 'X-Test-Client': 'web-codex' }
    })

    await hub.connect(config.id)
    expect(hub.listTools().map((tool) => tool.name)).toEqual(['remote__echo'])
    await expect(hub.callTool('remote__echo', { text: 'hello' })).resolves.toMatchObject({
      structuredContent: { transport: 'http', text: 'hello', clientHeader: 'web-codex' }
    })
    expect(await hub.listResources(config.id)).toEqual([expect.objectContaining({ uri: 'http://fixture.test/readme', name: 'http-resource' })])
    await expect(hub.readResource(config.id, 'http://fixture.test/readme')).resolves.toMatchObject({ contents: [expect.objectContaining({ text: 'http-resource-body' })] })
    expect(await hub.listPrompts(config.id)).toEqual([expect.objectContaining({ name: 'http-greet' })])
    await expect(hub.getPrompt(config.id, 'http-greet', { name: 'Web' })).resolves.toMatchObject({ messages: [expect.objectContaining({ content: expect.objectContaining({ text: 'HTTP Hello Web' }) })] })
  })

  it('deduplicates concurrent connection attempts to the same server', async () => {
    const url = await startHttpFixture()
    const config = await hub.save({
      name: 'Concurrent fixture',
      alias: 'concurrent',
      enabled: true,
      transport: 'streamable-http',
      url,
      headers: {}
    })

    const [first, second] = await Promise.all([hub.connect(config.id), hub.connect(config.id)])

    expect(second).toEqual(first)
    expect(fixtureInitializeRequests).toBe(1)
    expect(hub.listTools().map((tool) => tool.name)).toEqual(['concurrent__echo'])
  })

  it('records transport failures and allows aliases to be replaced safely', async () => {
    const config = await hub.save({
      name: 'Unavailable',
      alias: 'old',
      enabled: true,
      transport: 'streamable-http',
      url: 'http://127.0.0.1:1/mcp',
      headers: {}
    })
    await expect(hub.connect(config.id)).rejects.toThrow()
    expect(hub.states()).toEqual([expect.objectContaining({ connected: false, error: expect.any(String) })])

    await hub.save({ ...config, alias: 'new' })
    expect(store.get().mcpServers[0].alias).toBe('new')
    expect(hub.states()).toEqual([expect.objectContaining({ alias: 'new', connected: false })])
  })
})

function stdioConfig(patch: Partial<Extract<McpServerConfig, { transport: 'stdio' }>> = {}): Omit<Extract<McpServerConfig, { transport: 'stdio' }>, 'id'> & { id?: string } {
  return {
    name: 'Stdio fixture',
    alias: 'fixture',
    enabled: true,
    transport: 'stdio',
    command: process.execPath,
    args: [],
    env: {},
    ...patch
  }
}

async function startHttpFixture(): Promise<string> {
  const app = express()
  app.use(express.json())
  app.post('/mcp', (request, response) => {
    if (request.body?.method === 'initialize') fixtureInitializeRequests += 1
    void (async () => {
      const server = new McpServer({ name: 'http-fixture', version: '1.0.0' })
      activeFixtureServers.add(server)
      response.on('close', () => {
        activeFixtureServers.delete(server)
        void server.close().catch(() => undefined)
      })
      server.registerTool('echo', { inputSchema: { text: z.string() } }, async ({ text }) => ({
        content: [{ type: 'text', text: `http:${text}` }],
        structuredContent: { transport: 'http', text, clientHeader: request.headers['x-test-client'] ?? null }
      }))
      server.registerResource('http-resource', 'http://fixture.test/readme', {
        description: 'HTTP fixture resource',
        mimeType: 'text/plain'
      }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'http-resource-body' }] }))
      server.registerPrompt('http-greet', {
        description: 'HTTP fixture prompt',
        argsSchema: { name: z.string() }
      }, async ({ name }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `HTTP Hello ${name}` } }] }))
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      await server.connect(transport)
      await transport.handleRequest(request, response, request.body)
    })().catch((error: unknown) => {
      if (!response.headersSent) response.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    })
  })
  fixtureServer = createServer(app)
  await new Promise<void>((resolve) => fixtureServer?.listen(0, '127.0.0.1', () => resolve()))
  const address = fixtureServer.address()
  if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind to a port')
  return `http://127.0.0.1:${address.port}/mcp`
}