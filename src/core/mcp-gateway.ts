import { createServer, type Server } from 'node:http'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import express, { type Express, type Request, type Response } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import packageJson from '../../package.json'
import type { LogCategory, ServiceState } from '../shared/types'
import { ConfigStore } from './config-store'
import { ProjectService } from './project-service'
import { FileService } from './file-service'
import { ShellService } from './shell-service'
import { McpHub } from './mcp-hub'
import { assertCondition, errorMessage } from './errors'
import { authorizeRemoteShell } from './remote-shell-policy'
import type { ActivityLogger } from './activity-logger'

export interface GatewayDependencies {
  store: ConfigStore
  projects: ProjectService
  files: FileService
  shell: ShellService
  hub: McpHub
  logger?: ActivityLogger
}

function result(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value ?? null }
  }
}

function tokenMatches(provided: string, expected: string): boolean {
  const left = createHash('sha256').update(provided).digest()
  const right = createHash('sha256').update(expected).digest()
  return timingSafeEqual(left, right)
}

function auditRequestBody(body: unknown): unknown {
  if (Array.isArray(body)) return { entries: body.length, body: body.map((entry) => auditRequestBody(entry)) }
  if (!body || typeof body !== 'object') return body
  const request = body as { method?: string; params?: { name?: string; arguments?: unknown } }
  if (request.method !== 'tools/call' || request.params?.name !== 'mcp_tool_call') return body
  const input = request.params.arguments
  const downstreamArguments = input && typeof input === 'object' && !Array.isArray(input) ? (input as { arguments?: unknown }).arguments : undefined
  const keys = downstreamArguments && typeof downstreamArguments === 'object' && !Array.isArray(downstreamArguments) ? Object.keys(downstreamArguments) : []
  const name = input && typeof input === 'object' && !Array.isArray(input) ? (input as { name?: unknown }).name : undefined
  return { ...request, params: { ...(request.params ?? {}), arguments: { name, arguments: { omitted: true, keys } } } }
}

function toolCategory(name: string): LogCategory {
  if (name.startsWith('project_')) return 'project'
  if (name.startsWith('file_')) return 'file'
  if (name.startsWith('shell_')) return 'shell'
  if (name.startsWith('mcp_')) return 'mcp'
  return 'gateway'
}

function auditWorkspaceTools(server: McpServer, logger?: ActivityLogger): void {
  if (!logger) return
  const register = server.registerTool.bind(server)
  server.registerTool = ((name: string, config: unknown, callback: (...args: unknown[]) => unknown) => {
    const audited = async (...args: unknown[]): Promise<unknown> => {
      const startedAt = Date.now()
      try {
        const response = await callback(...args)
        const failed = typeof response === 'object' && response !== null && 'isError' in response && (response as { isError?: unknown }).isError === true
        logger[failed ? 'error' : 'info']({ category: toolCategory(name), action: failed ? 'gateway.tool_error' : 'gateway.tool_success', message: `Remote MCP tool ${name} ${failed ? 'failed' : 'completed'}`, status: failed ? 'error' : 'success', durationMs: Date.now() - startedAt, data: { tool: name, failed } })
        return response
      } catch (error) {
        logger.error({ category: toolCategory(name), action: 'gateway.tool_error', message: `Remote MCP tool ${name} threw an error`, durationMs: Date.now() - startedAt, data: { tool: name, error: errorMessage(error) } })
        throw error
      }
    }
    return register(name, config as never, audited as never)
  }) as typeof server.registerTool
}

export function createWorkspaceServer(dependencies: GatewayDependencies): McpServer {
  const { projects, files, shell, hub } = dependencies
  const server = new McpServer(
    { name: 'web-codex', version: packageJson.version },
    { instructions: 'Web Codex exposes real local workspaces. Call project_list first, then project_context_get for the selected project and follow its AGENTS.md or agent.md instructions. Each project may restrict remote shell commands through remoteShell; denied commands must not be bypassed. Use file tools for precise edits and shell tools for builds, tests, Git, and system operations. Paths are relative to the selected project unless documented otherwise. Long-running commands can be started with wait=false and inspected with shell_task_get.' }
  )
  auditWorkspaceTools(server, dependencies.logger)

  server.registerTool('project_list', {
    title: 'List local projects',
    description: 'List every project registered in Web Codex. Use the returned projectId for all workspace tools.',
    inputSchema: {}
  }, async () => result(projects.list()))

  server.registerTool('project_context_get', {
    title: 'Read project context',
    description: 'Read project metadata and its AGENTS.md or agent.md instructions before performing project work.',
    inputSchema: { projectId: z.string() }
  }, async ({ projectId }) => result(await projects.context(projectId)))

  server.registerTool('file_list', {
    title: 'List project files',
    description: 'List files and directories at a project-relative path.',
    inputSchema: { projectId: z.string(), path: z.string().default('.') }
  }, async ({ projectId, path }) => result(await files.list(projectId, path)))

  server.registerTool('file_read', {
    title: 'Read a project file',
    description: 'Read UTF-8 text with byte offset and bounded output. Continue reading when truncated is true.',
    inputSchema: {
      projectId: z.string(),
      path: z.string(),
      offset: z.number().int().nonnegative().default(0),
      maxBytes: z.number().int().positive().max(2_000_000).default(200_000)
    }
  }, async ({ projectId, path, offset, maxBytes }) => result(await files.read(projectId, path, maxBytes, offset)))

  server.registerTool('file_write', {
    title: 'Write a project file',
    description: 'Create or replace a UTF-8 project file, creating missing parent directories.',
    inputSchema: { projectId: z.string(), path: z.string(), content: z.string() }
  }, async ({ projectId, path, content }) => result(await files.write(projectId, path, content)))

  server.registerTool('file_patch', {
    title: 'Patch a project file',
    description: 'Replace exact text with an expected replacement count. Prefer this for focused edits.',
    inputSchema: {
      projectId: z.string(),
      path: z.string(),
      oldText: z.string(),
      newText: z.string(),
      expectedReplacements: z.number().int().positive().default(1)
    }
  }, async ({ projectId, path, oldText, newText, expectedReplacements }) => result(await files.patch(projectId, path, oldText, newText, expectedReplacements)))

  server.registerTool('file_search', {
    title: 'Search project files',
    description: 'Search text recursively while skipping dependencies, build outputs, and binary files.',
    inputSchema: {
      projectId: z.string(),
      query: z.string(),
      path: z.string().default('.'),
      regex: z.boolean().default(false),
      caseSensitive: z.boolean().default(false),
      maxResults: z.number().int().positive().max(1000).default(100)
    }
  }, async ({ projectId, query, path, regex, caseSensitive, maxResults }) => result(await files.search(projectId, query, { path, regex, caseSensitive, maxResults })))

  server.registerTool('file_mkdir', {
    title: 'Create a directory',
    description: 'Create a project-relative directory and missing parents.',
    inputSchema: { projectId: z.string(), path: z.string() }
  }, async ({ projectId, path }) => result(await files.createDirectory(projectId, path)))

  server.registerTool('file_move', {
    title: 'Move a file or directory',
    description: 'Move a project file or directory to another location inside the same project.',
    inputSchema: { projectId: z.string(), sourcePath: z.string(), destinationPath: z.string() }
  }, async ({ projectId, sourcePath, destinationPath }) => result(await files.move(projectId, sourcePath, destinationPath)))

  server.registerTool('file_delete', {
    title: 'Delete a file or directory',
    description: 'Delete a project file or directory. The project root cannot be deleted.',
    inputSchema: { projectId: z.string(), path: z.string(), recursive: z.boolean().default(false) }
  }, async ({ projectId, path, recursive }) => result(await files.remove(projectId, path, recursive)))

  server.registerTool('shell_run', {
    title: 'Run a local command',
    description: 'Run cmd, PowerShell, bash, or zsh in a registered project. Use wait=false for servers and other long-running tasks.',
    inputSchema: {
      projectId: z.string(),
      command: z.string(),
      shell: z.enum(['auto', 'cmd', 'powershell', 'bash', 'zsh']).default('auto'),
      cwd: z.string().default('.'),
      timeoutMs: z.number().int().positive().max(86_400_000).default(120_000),
      wait: z.boolean().default(true)
    }
  }, async ({ projectId, command, shell: shellKind, cwd, timeoutMs, wait }) => {
    const policy = projects.get(projectId).remoteShell
    const decision = authorizeRemoteShell(policy, command)
    assertCondition(decision.allowed, decision.reason ?? 'Remote shell command denied by project policy', 'REMOTE_SHELL_DENIED')
    return result(await shell.run({ projectId, command, shell: shellKind, cwd, timeoutMs, wait }))
  })

  server.registerTool('shell_task_list', {
    title: 'List shell tasks',
    description: 'List running and completed local commands with their current output.',
    inputSchema: {}
  }, async () => result(shell.list()))

  server.registerTool('shell_task_get', {
    title: 'Read a shell task',
    description: 'Get status, exit code, stdout, and stderr for a running or completed command.',
    inputSchema: { taskId: z.string() }
  }, async ({ taskId }) => result(shell.get(taskId)))

  server.registerTool('shell_task_stop', {
    title: 'Stop a shell task',
    description: 'Stop a running command and its process tree.',
    inputSchema: { taskId: z.string() }
  }, async ({ taskId }) => result(await shell.stop(taskId)))

  server.registerTool('mcp_server_list', {
    title: 'List connected MCP servers',
    description: 'List downstream MCP server connection states managed by Web Codex.',
    inputSchema: {}
  }, async () => result(hub.states()))

  server.registerTool('mcp_tool_list', {
    title: 'List downstream MCP tools',
    description: 'List tools from connected MCP servers. Names are namespaced as alias__tool.',
    inputSchema: {}
  }, async () => result(hub.listTools()))

  server.registerTool('mcp_tool_call', {
    title: 'Call a downstream MCP tool',
    description: 'Call a namespaced tool returned by mcp_tool_list with a JSON arguments object.',
    inputSchema: { name: z.string(), arguments: z.record(z.string(), z.unknown()).default({}) }
  }, async ({ name, arguments: args }) => result(await hub.callTool(name, args)))

  return server
}

export class McpGateway {
  private httpServer?: Server
  private readonly activeServers = new Set<McpServer>()
  private state: ServiceState = { running: false, detail: 'Stopped' }

  constructor(private readonly dependencies: GatewayDependencies) {}

  getState(): ServiceState {
    return { ...this.state }
  }

  async start(): Promise<ServiceState> {
    if (this.httpServer) return this.getState()
    const settings = this.dependencies.store.get().gateway
    if (!['127.0.0.1', 'localhost', '::1'].includes(settings.host)) {
      throw new Error('MCP Gateway must listen on a loopback address')
    }
    this.dependencies.logger?.info({ category: 'gateway', action: 'gateway.start', message: 'Starting local MCP Gateway', origin: 'system', status: 'started', data: { host: settings.host, port: settings.port } })
    const app = this.createExpressApp()
    const server = createServer(app)
    this.httpServer = server
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen)
        server.listen(settings.port, settings.host, () => {
          server.off('error', rejectListen)
          resolveListen()
        })
      })
    } catch (error) {
      this.httpServer = undefined
      this.dependencies.logger?.error({ category: 'gateway', action: 'gateway.start_failed', message: 'Local MCP Gateway failed to start', origin: 'system', data: { host: settings.host, port: settings.port, error: errorMessage(error) } })
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      throw error
    }
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : settings.port
    this.state = { running: true, detail: 'Ready for ChatGPT', address: `http://${settings.host}:${port}/mcp` }
    this.dependencies.logger?.info({ category: 'gateway', action: 'gateway.started', message: 'Local MCP Gateway is ready', origin: 'system', status: 'success', data: { address: this.state.address } })
    return this.getState()
  }

  async stop(): Promise<void> {
    const server = this.httpServer
    this.httpServer = undefined
    await Promise.allSettled([...this.activeServers].map((item) => item.close()))
    this.activeServers.clear()
    if (server) {
      server.closeIdleConnections()
      server.closeAllConnections()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    }
    this.state = { running: false, detail: 'Stopped' }
    this.dependencies.logger?.info({ category: 'gateway', action: 'gateway.stopped', message: 'Local MCP Gateway stopped', origin: 'system', status: 'stopped' })
  }

  private createExpressApp(): Express {
    const app = express()
    app.disable('x-powered-by')
    app.set('trust proxy', 'loopback')
    app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
      res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate')
      if (req.method === 'OPTIONS') res.status(204).end()
      else next()
    })
    app.get('/healthz', (_req, res) => res.json({ ok: true, name: 'web-codex' }))
        app.use('/mcp', (req, res, next) => {
      const authorization = req.headers.authorization ?? ''
      const provided = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
      if (!provided || !tokenMatches(provided, this.dependencies.store.get().gateway.authToken)) {
        this.dependencies.logger?.warn({ category: 'security', action: 'gateway.auth_rejected', message: 'Rejected unauthenticated MCP request', origin: 'remote', data: { method: req.method, path: req.path, remoteAddress: req.socket.remoteAddress } })
        res.setHeader('WWW-Authenticate', 'Bearer realm="web-codex"')
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      next()
    })
    app.use('/mcp', express.json({ limit: '10mb' }))
    app.post('/mcp', (req, res) => void this.handleRequest(req, res))
    const methodNotAllowed = (req: Request, res: Response): void => {
      this.dependencies.logger?.warn({ category: 'gateway', action: 'gateway.method_rejected', message: `Rejected MCP HTTP method: ${req.method}`, origin: 'remote', data: { method: req.method } })
      res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed in stateless mode' }, id: null })
    }
    app.get('/mcp', methodNotAllowed)
    app.delete('/mcp', methodNotAllowed)
    app.use((req, res) => {
      this.dependencies.logger?.debug({ category: 'gateway', action: 'gateway.route_not_found', message: `MCP route not found: ${req.method} ${req.path}`, origin: 'remote', data: { method: req.method, path: req.path } })
      res.status(404).end()
    })
    return app
  }

  private async handleRequest(req: Request, res: Response): Promise<void> {
    const body = req.body as { id?: string | number; method?: string; params?: { name?: string } } | unknown[] | undefined
    const requestId = !Array.isArray(body) && body?.id !== undefined ? String(body.id) : randomUUID()
    const method = Array.isArray(body) ? 'batch' : body?.method ?? 'unknown'
    const tool = !Array.isArray(body) ? body?.params?.name : undefined
    const startedAt = Date.now()
    this.dependencies.logger?.info({ category: 'gateway', action: 'gateway.request', message: `Remote MCP request: ${method}`, origin: 'remote', status: 'started', requestId, data: { method, tool, body: auditRequestBody(req.body) } })
    const server = createWorkspaceServer(this.dependencies)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    this.activeServers.add(server)
    res.on('close', () => {
      this.activeServers.delete(server)
      void server.close().catch(() => undefined)
    })
    try {
      await server.connect(transport)
      const handle = (): Promise<void> => transport.handleRequest(req, res, req.body)
      if (this.dependencies.logger) await this.dependencies.logger.runWithContext({ origin: 'remote', requestId }, handle)
      else await handle()
      this.dependencies.logger?.info({ category: 'gateway', action: 'gateway.response', message: `Remote MCP request completed: ${method}`, origin: 'remote', status: res.statusCode < 400 ? 'success' : 'error', requestId, durationMs: Date.now() - startedAt, data: { method, tool, statusCode: res.statusCode } })
    } catch (error) {
      this.activeServers.delete(server)
      this.dependencies.logger?.error({ category: 'gateway', action: 'gateway.request_failed', message: `Remote MCP request failed: ${method}`, origin: 'remote', requestId, durationMs: Date.now() - startedAt, data: { method, tool, error: errorMessage(error) } })
      await server.close().catch(() => undefined)
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: errorMessage(error) }, id: null })
      }
    }
  }
}