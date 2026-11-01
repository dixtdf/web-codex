import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import packageJson from '../../package.json'
import type { McpConnectionState, McpServerConfig } from '../shared/types'
import { AppError, assertCondition, errorMessage } from './errors'
import { ConfigStore } from './config-store'
import { ProxyManager } from './proxy-manager'
import type { ActivityLogger } from './activity-logger'

export interface NamespacedTool {
  name: string
  originalName: string
  serverId: string
  serverName: string
  description?: string
  inputSchema: Tool['inputSchema']
}

export interface NamespacedResource {
  uri: string
  name: string
  description?: string
  mimeType?: string
  size?: number
  serverId: string
  serverName: string
}

export interface NamespacedPrompt {
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
  serverId: string
  serverName: string
}

interface Connection {
  client: Client
  tools: Map<string, { originalName: string; tool: Tool }>
  state: McpConnectionState
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export type McpServerInput = DistributiveOmit<McpServerConfig, 'id'> & { id?: string }

function normalizeAlias(value: string): string {
  const alias = value.trim().replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+/, '')
  if (!alias) throw new AppError('MCP alias must contain a letter or number', 'MCP_ALIAS_INVALID')
  return alias
}

export class McpHub extends EventEmitter {
  private readonly connections = new Map<string, Connection>()

  constructor(private readonly store: ConfigStore, private readonly proxy: ProxyManager, private readonly logger?: ActivityLogger) {
    super()
  }

  states(): McpConnectionState[] {
    return this.store.get().mcpServers.map((config) => {
      const connection = this.connections.get(config.id)
      return connection?.state ?? {
        id: config.id,
        name: config.name,
        alias: config.alias,
        enabled: config.enabled,
        connected: false,
        toolCount: 0
      }
    })
  }

  async start(): Promise<void> {
    await Promise.allSettled(this.store.get().mcpServers.filter((item) => item.enabled).map((item) => this.connect(item.id)))
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.connections.keys()].map((id) => this.disconnect(id)))
  }

  async save(input: McpServerInput): Promise<McpServerConfig> {
    const id = input.id ?? randomUUID()
    const alias = normalizeAlias(input.alias || input.name)
    const config = this.store.get()
    if (config.mcpServers.some((item) => item.id !== id && item.alias === alias)) {
      throw new AppError(`MCP alias is already used: ${alias}`, 'MCP_ALIAS_DUPLICATE')
    }
    const next = { ...input, id, alias } as McpServerConfig
    if (this.connections.has(id)) await this.disconnect(id)
    const exists = config.mcpServers.some((item) => item.id === id)
    this.store.update({ mcpServers: exists ? config.mcpServers.map((item) => item.id === id ? next : item) : [...config.mcpServers, next] })
    await this.store.flush()
    this.logger?.info({ category: 'mcp', action: 'mcp.config_saved', message: `Saved MCP configuration: ${next.name}`, data: { serverId: id, name: next.name, alias, transport: next.transport, enabled: next.enabled } })
    this.emit('change', this.states())
    return next
  }

  async remove(id: string): Promise<void> {
    await this.disconnect(id)
    const config = this.store.get()
    this.store.update({ mcpServers: config.mcpServers.filter((item) => item.id !== id) })
    await this.store.flush()
    this.connections.delete(id)
    this.logger?.info({ category: 'mcp', action: 'mcp.config_removed', message: `Removed MCP configuration ${id}`, data: { serverId: id } })
    this.emit('change', this.states())
  }

  async connect(id: string): Promise<McpConnectionState> {
    const config = this.store.get().mcpServers.find((item) => item.id === id)
    if (!config) throw new AppError(`MCP server not found: ${id}`, 'MCP_SERVER_NOT_FOUND')
    if (!config.enabled) throw new AppError(`MCP server is disabled: ${config.name}`, 'MCP_SERVER_DISABLED')
    if (config.transport === 'stdio' && config.command === 'openai' && config.args.includes('--web-codex-self')) {
      throw new AppError('Recursive MCP connections are not allowed', 'MCP_RECURSIVE_CONNECTION')
    }
    if (config.transport === 'streamable-http') {
      const target = new URL(config.url)
      const gateway = this.store.get().gateway
      const targetPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
      const localHosts = new Set([gateway.host, 'localhost', '127.0.0.1', '::1', '[::1]'])
      if (target.pathname === '/mcp' && targetPort === gateway.port && localHosts.has(target.hostname)) {
        throw new AppError('Recursive MCP connections are not allowed', 'MCP_RECURSIVE_CONNECTION')
      }
    }
    const startedAt = Date.now()
    this.logger?.info({ category: 'mcp', action: 'mcp.connect', message: `Connecting MCP server: ${config.name}`, status: 'started', data: { serverId: id, transport: config.transport, command: config.transport === 'stdio' ? config.command : undefined, args: config.transport === 'stdio' ? config.args : undefined, url: config.transport === 'streamable-http' ? config.url : undefined } })
    await this.disconnect(id)
    const client = new Client({ name: 'web-codex-hub', version: packageJson.version }, { capabilities: {} })
    const state: McpConnectionState = { id, name: config.name, alias: config.alias, enabled: true, connected: false, toolCount: 0 }
    const connection: Connection = { client, tools: new Map(), state }
    this.connections.set(id, connection)
    this.emit('change', this.states())
    try {
      const transport = config.transport === 'stdio'
        ? new StdioClientTransport({
            command: config.command,
            args: config.args,
            cwd: config.cwd,
            env: this.environmentForStdio(config.env),
            stderr: 'pipe'
          })
        : new StreamableHTTPClientTransport(new URL(config.url), {
            requestInit: { headers: config.headers },
            fetch: (input, init) => this.proxy.fetch(input, init)
          })
      if (transport instanceof StdioClientTransport) {
        let pending = ''
        transport.stderr?.on('data', (chunk: Buffer) => {
          pending += chunk.toString('utf8')
          const lines = pending.split(/\r?\n/)
          pending = lines.pop() ?? ''
          for (const line of lines) {
            if (line.trim()) this.logger?.warn({ category: 'mcp', action: 'mcp.stderr', message: line, data: { serverId: id } })
          }
        })
        transport.stderr?.on('end', () => {
          if (pending.trim()) this.logger?.warn({ category: 'mcp', action: 'mcp.stderr', message: pending, data: { serverId: id, final: true } })
          pending = ''
        })
      }
      client.onclose = () => {
        state.connected = false
        this.logger?.info({ category: 'mcp', action: 'mcp.closed', message: `MCP connection closed: ${config.name}`, status: 'stopped', data: { serverId: id } })
        this.emit('change', this.states())
      }
      client.onerror = (error) => {
        state.error = errorMessage(error)
        this.logger?.error({ category: 'mcp', action: 'mcp.transport_error', message: `MCP transport error: ${config.name}`, data: { serverId: id, error: errorMessage(error) } })
        this.emit('change', this.states())
      }
      await client.connect(transport)
      const listed = await client.listTools()
      for (const tool of listed.tools) {
        connection.tools.set(`${config.alias}__${tool.name}`, { originalName: tool.name, tool })
      }
      state.connected = true
      state.toolCount = connection.tools.size
      state.error = undefined
      this.logger?.info({ category: 'mcp', action: 'mcp.connected', message: `MCP server connected: ${config.name}`, status: 'success', durationMs: Date.now() - startedAt, data: { serverId: id, toolCount: state.toolCount } })
      this.emit('change', this.states())
      return { ...state }
    } catch (error) {
      state.error = errorMessage(error)
      state.connected = false
      this.logger?.error({ category: 'mcp', action: 'mcp.connect_failed', message: `MCP connection failed: ${config.name}`, durationMs: Date.now() - startedAt, data: { serverId: id, error: state.error } })
      this.emit('change', this.states())
      await client.close().catch(() => undefined)
      throw error
    }
  }

  async disconnect(id: string): Promise<void> {
    const connection = this.connections.get(id)
    if (!connection) return
    this.connections.delete(id)
    connection.state.connected = false
    this.logger?.info({ category: 'mcp', action: 'mcp.disconnect', message: `Disconnecting MCP server: ${connection.state.name}`, status: 'stopped', data: { serverId: id } })
    await connection.client.close().catch(() => undefined)
    this.emit('change', this.states())
  }

  listTools(): NamespacedTool[] {
    return [...this.connections.values()].filter((connection) => connection.state.connected).flatMap((connection) => [...connection.tools.entries()].map(([name, entry]) => ({
      name,
      originalName: entry.originalName,
      serverId: connection.state.id,
      serverName: connection.state.name,
      description: entry.tool.description,
      inputSchema: entry.tool.inputSchema
    }))).sort((a, b) => a.name.localeCompare(b.name))
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const startedAt = Date.now()
    for (const connection of this.connections.values()) {
      const entry = connection.tools.get(name)
      if (!entry) continue
      if (!connection.state.connected) {
        this.logger?.error({ category: 'mcp', action: 'mcp.tool_failed', message: `Cannot call tool on disconnected MCP server: ${name}`, data: { serverId: connection.state.id, name, argumentKeys: Object.keys(args) } })
        throw new AppError(`MCP server is disconnected: ${connection.state.name}`, 'MCP_SERVER_DISCONNECTED')
      }
      this.logger?.info({ category: 'mcp', action: 'mcp.tool_call', message: `Calling downstream MCP tool: ${name}`, status: 'started', data: { serverId: connection.state.id, name, originalName: entry.originalName, argumentKeys: Object.keys(args) } })
      try {
        const response = await connection.client.callTool({ name: entry.originalName, arguments: args })
        this.logger?.info({ category: 'mcp', action: 'mcp.tool_success', message: `Downstream MCP tool completed: ${name}`, status: 'success', durationMs: Date.now() - startedAt, data: { serverId: connection.state.id, name } })
        return response
      } catch (error) {
        this.logger?.error({ category: 'mcp', action: 'mcp.tool_failed', message: `Downstream MCP tool failed: ${name}`, durationMs: Date.now() - startedAt, data: { serverId: connection.state.id, name, error: errorMessage(error) } })
        throw error
      }
    }
    this.logger?.error({ category: 'mcp', action: 'mcp.tool_not_found', message: `Downstream MCP tool not found: ${name}`, data: { name, argumentKeys: Object.keys(args) } })
    throw new AppError(`Namespaced MCP tool not found: ${name}`, 'MCP_TOOL_NOT_FOUND')
  }

  async listResources(serverId?: string): Promise<NamespacedResource[]> {
    const connections = this.connectionsFor(serverId)
    const results = await Promise.allSettled(connections.map(async ({ connection, state }) => {
      const response = await connection.client.listResources()
      return response.resources.map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
        size: resource.size,
        serverId: state.id,
        serverName: state.name
      }))
    }))
    return this.settleCollection(results, 'mcp_resource_list').sort((left, right) => left.serverName.localeCompare(right.serverName) || left.uri.localeCompare(right.uri))
  }

  async readResource(serverId: string, uri: string): Promise<unknown> {
    const { connection } = this.connectionFor(serverId)
    assertCondition(uri.trim().length > 0 && uri.length <= 8192, 'Resource URI is required and must be at most 8192 characters', 'MCP_RESOURCE_URI_INVALID')
    const startedAt = Date.now()
    this.logger?.info({ category: 'mcp', action: 'mcp.resource_read', message: 'Reading downstream MCP resource', status: 'started', data: { serverId, uri } })
    try {
      const response = await connection.client.readResource({ uri })
      assertCondition(Buffer.byteLength(JSON.stringify(response)) <= 4_000_000, 'Downstream MCP resource exceeds the 4 MB response limit', 'MCP_RESOURCE_LIMIT')
      this.logger?.info({ category: 'mcp', action: 'mcp.resource_read_success', message: 'Downstream MCP resource read', status: 'success', durationMs: Date.now() - startedAt, data: { serverId, uri } })
      return response
    } catch (error) {
      this.logger?.error({ category: 'mcp', action: 'mcp.resource_read_failed', message: 'Downstream MCP resource read failed', durationMs: Date.now() - startedAt, data: { serverId, uri, error: errorMessage(error) } })
      throw error
    }
  }

  async listPrompts(serverId?: string): Promise<NamespacedPrompt[]> {
    const connections = this.connectionsFor(serverId)
    const results = await Promise.allSettled(connections.map(async ({ connection, state }) => {
      const response = await connection.client.listPrompts()
      return response.prompts.map((prompt) => ({
        name: prompt.name,
        description: prompt.description,
        arguments: prompt.arguments?.map((argument) => ({ name: argument.name, description: argument.description, required: argument.required })),
        serverId: state.id,
        serverName: state.name
      }))
    }))
    return this.settleCollection(results, 'mcp_prompt_list').sort((left, right) => left.serverName.localeCompare(right.serverName) || left.name.localeCompare(right.name))
  }

  async getPrompt(serverId: string, name: string, args: Record<string, string> = {}): Promise<unknown> {
    const { connection } = this.connectionFor(serverId)
    assertCondition(name.trim().length > 0 && name.length <= 512, 'Prompt name is required and must be at most 512 characters', 'MCP_PROMPT_NAME_INVALID')
    const startedAt = Date.now()
    this.logger?.info({ category: 'mcp', action: 'mcp.prompt_get', message: 'Loading downstream MCP prompt', status: 'started', data: { serverId, name, argumentKeys: Object.keys(args) } })
    try {
      const response = await connection.client.getPrompt({ name, arguments: args })
      assertCondition(Buffer.byteLength(JSON.stringify(response)) <= 4_000_000, 'Downstream MCP prompt exceeds the 4 MB response limit', 'MCP_PROMPT_LIMIT')
      this.logger?.info({ category: 'mcp', action: 'mcp.prompt_get_success', message: 'Downstream MCP prompt loaded', status: 'success', durationMs: Date.now() - startedAt, data: { serverId, name } })
      return response
    } catch (error) {
      this.logger?.error({ category: 'mcp', action: 'mcp.prompt_get_failed', message: 'Downstream MCP prompt load failed', durationMs: Date.now() - startedAt, data: { serverId, name, error: errorMessage(error) } })
      throw error
    }
  }

  private connectionsFor(serverId?: string): Array<{ connection: Connection; state: McpConnectionState }> {
    if (serverId) {
      const { connection } = this.connectionFor(serverId)
      return [{ connection, state: connection.state }]
    }
    return [...this.connections.values()].filter((connection) => connection.state.connected).map((connection) => ({ connection, state: connection.state }))
  }

  private connectionFor(serverId: string): { connection: Connection } {
    const connection = this.connections.get(serverId)
    if (!connection) throw new AppError(`MCP server not found: ${serverId}`, 'MCP_SERVER_NOT_FOUND')
    if (!connection.state.connected) throw new AppError(`MCP server is disconnected: ${connection.state.name}`, 'MCP_SERVER_DISCONNECTED')
    return { connection }
  }

  private settleCollection<T>(results: PromiseSettledResult<T[]>[], action: string): T[] {
    const items: T[] = []
    for (const result of results) {
      if (result.status === 'fulfilled') items.push(...result.value)
      else this.logger?.warn({ category: 'mcp', action: `${action}_partial`, message: 'One downstream MCP server did not return a collection', data: { error: errorMessage(result.reason) } })
    }
    return items
  }

  private environmentForStdio(custom: Record<string, string>): Record<string, string> {
    const env = { ...getDefaultEnvironment(), ...custom }
    const proxy = this.proxy.getState()
    if (proxy.proxy) {
      env.HTTPS_PROXY = proxy.proxy
      env.HTTP_PROXY = proxy.proxy
      env.NO_PROXY = proxy.noProxy
    }
    return env
  }
}