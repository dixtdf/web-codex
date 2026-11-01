import { createServer, type Server } from 'node:http'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import express, { type Express, type Request, type Response } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { extname } from 'node:path'
import { pathToFileURL } from 'node:url'
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
import type { UploadService } from './upload-service'
import type { GitService } from './git-service'
import type { HostService } from './host-service'

export interface GatewayDependencies {
  store: ConfigStore
  projects: ProjectService
  files: FileService
  shell: ShellService
  hub: McpHub
  uploads?: UploadService
  git?: GitService
  host?: HostService
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

const binaryMimeTypes: Record<string, string> = { '.step': 'application/step', '.stp': 'application/step', '.stl': 'model/stl', '.zip': 'application/zip', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.pdf': 'application/pdf', '.kicad_pcb': 'text/plain', '.kicad_sch': 'text/plain', '.kicad_pro': 'application/json' }

function mimeForPath(path: string): string {
  return binaryMimeTypes[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

const workspaceInstructions = 'Web Codex exposes real local workspaces. Call project_list first, then project_context_get for the selected project and follow its AGENTS.md or agent.md instructions. Each project may restrict remote shell commands through remoteShell; denied commands must not be bypassed. Use file tools for precise edits and shell tools for builds, tests, Git, and system operations. Paths are relative to the selected project unless documented otherwise. Long-running commands can be started with wait=false and inspected with shell_task_get; use shell_task_output with offset/maxBytes for task stdout and stderr.'
const supportedProtocolVersions = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

function auditWorkspaceTools(server: McpServer, logger?: ActivityLogger): void {
  const register = server.registerTool.bind(server)
  server.registerTool = ((name: string, config: unknown, callback: (...args: unknown[]) => unknown) => {
    const audited = async (...args: unknown[]): Promise<unknown> => {
      const startedAt = Date.now()
      try {
        const response = await callback(...args)
        const failed = typeof response === 'object' && response !== null && 'isError' in response && (response as { isError?: unknown }).isError === true
        logger?.[failed ? 'error' : 'info']({ category: toolCategory(name), action: failed ? 'gateway.tool_error' : 'gateway.tool_success', message: `Remote MCP tool ${name} ${failed ? 'failed' : 'completed'}`, status: failed ? 'error' : 'success', durationMs: Date.now() - startedAt, data: { tool: name, failed } })
        return response
      } catch (error) {
        const candidate = error as Error & { code?: string; details?: unknown }
        const structured = { code: candidate.code ?? 'TOOL_ERROR', message: errorMessage(error), details: candidate.details }
        logger?.error({ category: toolCategory(name), action: 'gateway.tool_error', message: `Remote MCP tool ${name} failed`, durationMs: Date.now() - startedAt, data: { tool: name, ...structured } })
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: structured }) }],
          structuredContent: { error: structured },
          isError: true
        }
      }
    }
    const definition = config as { inputSchema?: z.ZodRawShape }
    const strictConfig = definition.inputSchema
      ? { ...definition, inputSchema: z.object(definition.inputSchema).strict() }
      : definition
    return register(name, strictConfig as never, audited as never)
  }) as typeof server.registerTool
}

export function createWorkspaceServer(dependencies: GatewayDependencies): McpServer {
  const { projects, files, shell, hub, uploads, git, host } = dependencies
  const server = new McpServer(
    { name: 'web-codex', version: packageJson.version },
    { instructions: workspaceInstructions }
  )
  auditWorkspaceTools(server, dependencies.logger)

  server.registerTool('project_list', {
    title: 'List local projects',
    description: 'List every project registered in Web Codex with live path health and its remote shell policy. enabled records registration state; health.accessible reports current filesystem availability. Use the returned projectId for workspace tools.',
    inputSchema: {}
  }, async () => result(await projects.listWithHealth()))

  server.registerTool('project_context_get', {
    title: 'Read project context',
    description: 'Read project metadata and its AGENTS.md or agent.md instructions before performing project work.',
    inputSchema: { projectId: z.string() }
  }, async ({ projectId }) => result(await projects.context(projectId)))

  server.registerTool('project_create', {
    title: 'Register a local project',
    description: 'Register a local folder as a workspace. This grants remote structured file access inside that folder and applies the supplied remote shell policy.',
    inputSchema: {
      path: z.string(),
      name: z.string().optional(),
      enabled: z.boolean().default(true),
      createDirectory: z.boolean().default(true),
      remoteShell: z.object({ mode: z.enum(['allow', 'allowlist', 'deny']).default('allow'), allowedPrefixes: z.array(z.string()).max(200).default([]) }).optional()
    }
  }, async ({ path, name, enabled, createDirectory, remoteShell }) => result(await projects.create({ path, name, enabled, createDirectory, remoteShell })))

  server.registerTool('project_update', {
    title: 'Update a project',
    description: 'Change a registered project name, path, enabled state, or remote shell policy. Removing a project registration never deletes source files.',
    inputSchema: {
      projectId: z.string(),
      name: z.string().optional(),
      path: z.string().optional(),
      enabled: z.boolean().optional(),
      remoteShell: z.object({ mode: z.enum(['allow', 'allowlist', 'deny']), allowedPrefixes: z.array(z.string()).max(200).default([]) }).optional()
    }
  }, async ({ projectId, ...patch }) => result(await projects.update(projectId, patch)))

  server.registerTool('project_remove', {
    title: 'Remove a project registration',
    description: 'Unregister a project without deleting files. Existing tasks and the project folder remain on disk.',
    inputSchema: { projectId: z.string() }
  }, async ({ projectId }) => {
    await projects.remove(projectId)
    return result({ removed: projectId })
  })

  server.registerTool('project_instructions_update', {
    title: 'Update project instructions',
    description: 'Write AGENTS.md or update an existing agent.md with project-specific instructions.',
    inputSchema: { projectId: z.string(), content: z.string() }
  }, async ({ projectId, content }) => result(await projects.saveInstructions(projectId, content)))

  server.registerTool('file_list', {
    title: 'List project files',
    description: 'List files and directories at a project-relative path.',
    inputSchema: { projectId: z.string(), path: z.string().default('.') }
  }, async ({ projectId, path }) => result(await files.list(projectId, path)))

  server.registerTool('file_read', {
    title: 'Read a project file',
    description: 'Read UTF-8 text by byte offset. Chunks align to complete UTF-8 characters and return actual offset, nextOffset, size, truncation, and SHA-256. Continue with nextOffset when truncated.',
    inputSchema: {
      projectId: z.string(),
      path: z.string(),
      offset: z.number().int().nonnegative().default(0),
      maxBytes: z.number().int().positive().max(2_000_000).default(200_000)
    }
  }, async ({ projectId, path, offset, maxBytes }) => result(await files.read(projectId, path, maxBytes, offset)))

  server.registerTool('file_write', {
    title: 'Write a project file atomically',
    description: 'Create or replace a UTF-8 project file using atomic rename. Supply expectedSha256 from file_read to prevent overwriting concurrent user changes.',
    inputSchema: { projectId: z.string(), path: z.string(), content: z.string(), expectedSha256: z.string().optional() }
  }, async ({ projectId, path, content, expectedSha256 }) => result(await files.write(projectId, path, content, { expectedSha256 })))

  server.registerTool('file_patch', {
    title: 'Patch a project file with conflict detection',
    description: 'Replace exact text atomically. expectedSha256 detects concurrent changes; dryRun reports the hashes without writing.',
    inputSchema: {
      projectId: z.string(),
      path: z.string(),
      oldText: z.string(),
      newText: z.string(),
      expectedReplacements: z.number().int().positive().default(1),
      expectedSha256: z.string().optional(),
      dryRun: z.boolean().default(false)
    }
  }, async ({ projectId, path, oldText, newText, expectedReplacements, expectedSha256, dryRun }) => result(await files.patch(projectId, path, oldText, newText, expectedReplacements, { expectedSha256, dryRun })))

  server.registerTool('file_search', {
    title: 'Search project files',
    description: 'Search text recursively while skipping dependencies, build outputs, binary files, and root .gitignore patterns. Returns matches and nextCursor; pass the cursor back with the same filters for the next page.',
    inputSchema: {
      projectId: z.string(),
      query: z.string(),
      path: z.string().default('.'),
      regex: z.boolean().default(false),
      caseSensitive: z.boolean().default(false),
      maxResults: z.number().int().positive().max(1000).default(100),
      respectGitignore: z.boolean().default(true),
      cursor: z.string().optional()
    }
  }, async ({ projectId, query, path, regex, caseSensitive, maxResults, respectGitignore, cursor }) => result(await files.search(projectId, query, { path, regex, caseSensitive, maxResults, respectGitignore, cursor })))

  server.registerTool('file_mkdir', {
    title: 'Create a directory',
    description: 'Create a project-relative directory and missing parents.',
    inputSchema: { projectId: z.string(), path: z.string() }
  }, async ({ projectId, path }) => result(await files.createDirectory(projectId, path)))

  server.registerTool('file_move', {
    title: 'Move a file or directory',
    description: 'Move a project entry. Existing destinations are rejected by default. Overwriting a file requires overwrite=true, expectedDestinationSha256, and optional expectedSourceSha256; hashes are returned.',
    inputSchema: {
      projectId: z.string(),
      sourcePath: z.string(),
      destinationPath: z.string(),
      overwrite: z.boolean().default(false),
      expectedSourceSha256: z.string().optional(),
      expectedDestinationSha256: z.string().optional()
    }
  }, async ({ projectId, sourcePath, destinationPath, overwrite, expectedSourceSha256, expectedDestinationSha256 }) => result(await files.move(projectId, sourcePath, destinationPath, { overwrite, expectedSourceSha256, expectedDestinationSha256 })))

  server.registerTool('file_delete', {
    title: 'Delete a file or directory safely',
    description: 'Preview with dryRun or delete a project entry. For regular files, expectedSha256 prevents deleting a version that changed after it was reviewed. The project root cannot be deleted.',
    inputSchema: { projectId: z.string(), path: z.string(), recursive: z.boolean().default(false), expectedSha256: z.string().optional(), dryRun: z.boolean().default(false) }
  }, async ({ projectId, path, recursive, expectedSha256, dryRun }) => result(await files.remove(projectId, path, recursive, { expectedSha256, dryRun })))

  server.registerTool('file_hash', {
    title: 'Hash a project file',
    description: 'Return normalized path, size, modification time, and SHA-256 for version checks and transfer verification.',
    inputSchema: { projectId: z.string(), path: z.string() }
  }, async ({ projectId, path }) => result(await files.hash(projectId, path)))

  server.registerTool('file_attributes', {
    title: 'Read file attributes',
    description: 'Return entry type, size, POSIX mode, ownership ids, executable/readable/writable flags, and timestamps.',
    inputSchema: { projectId: z.string(), path: z.string() }
  }, async ({ projectId, path }) => result(await files.attributes(projectId, path)))

  server.registerTool('file_copy', {
    title: 'Copy a project entry',
    description: 'Copy a file or directory inside the project without moving or deleting the source.',
    inputSchema: { projectId: z.string(), sourcePath: z.string(), destinationPath: z.string(), onConflict: z.enum(['fail', 'overwrite', 'rename']).default('fail') }
  }, async ({ projectId, sourcePath, destinationPath, onConflict }) => result(await files.copy(projectId, sourcePath, destinationPath, onConflict)))

  server.registerTool('file_delete_plan', {
    title: 'Preview deletion impact',
    description: 'Count files, directories, bytes, and sample paths before deleting a project entry.',
    inputSchema: { projectId: z.string(), path: z.string() }
  }, async ({ projectId, path }) => result(await files.deletePlan(projectId, path)))

  server.registerTool('file_backup', {
    title: 'Back up a project entry',
    description: 'Copy a project file or directory into the local recoverable trash store without changing the source.',
    inputSchema: { projectId: z.string(), path: z.string() }
  }, async ({ projectId, path }) => result(await files.backup(projectId, path)))

  server.registerTool('trash_list', {
    title: 'List recoverable deleted or backed-up entries',
    description: 'List local trash records with trashId, project, original path, reason, type, bytes, and deletion time.',
    inputSchema: {}
  }, async () => result(await files.trashList()))

  server.registerTool('trash_restore', {
    title: 'Restore a deleted or backed-up entry',
    description: 'Restore a trash record to its original project path. Use overwrite=true only after reviewing the current destination.',
    inputSchema: { trashId: z.string(), overwrite: z.boolean().default(false) }
  }, async ({ trashId, overwrite }) => result(await files.restoreTrash(trashId, overwrite)))

  server.registerTool('file_read_binary', {
    title: 'Read a binary file in chunks',
    description: 'Read a project file as base64 with byte offsets and SHA-256. Use nextOffset for subsequent chunks; each chunk is at most 4 MB.',
    inputSchema: { projectId: z.string(), path: z.string(), offset: z.number().int().nonnegative().default(0), maxBytes: z.number().int().positive().max(4_000_000).default(1_000_000) }
  }, async ({ projectId, path, offset, maxBytes }) => result(await files.readBinary(projectId, path, offset, maxBytes)))

  server.registerTool('file_download', {
    title: 'Download a project file chunk as an MCP resource',
    description: 'Return up to 4 MB as an inline MCP resource plus metadata, hash, and nextOffset. Remote hosts that cannot consume inline blobs can still use file_read_binary.',
    inputSchema: { projectId: z.string(), path: z.string(), offset: z.number().int().nonnegative().default(0), maxBytes: z.number().int().positive().max(4_000_000).default(1_000_000) }
  }, async ({ projectId, path, offset, maxBytes }) => {
    const info = await files.absolutePath(projectId, path)
    const chunk = await files.readBinary(projectId, path, offset, maxBytes)
    const metadata = { ...chunk, absolutePath: info.absolutePath, mimeType: mimeForPath(path) }
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(metadata) },
        { type: 'resource' as const, resource: { uri: pathToFileURL(info.absolutePath).toString(), mimeType: mimeForPath(path), blob: chunk.base64 } }
      ],
      structuredContent: { result: metadata }
    }
  })

  server.registerTool('file_transfer_status', {
    title: 'Check file transfer state',
    description: 'Return file size, modification time, SHA-256, and suggested 4 MB chunk count for comparing local and remote transfer completion.',
    inputSchema: { projectId: z.string(), path: z.string() }
  }, async ({ projectId, path }) => {
    const hash = await files.hash(projectId, path)
    return result({ ...hash, suggestedChunkCount: Math.max(1, Math.ceil(hash.size / 4_000_000)) })
  })

  server.registerTool('file_write_binary', {
    title: 'Write a binary file chunk',
    description: 'Write a base64 chunk to a project file. Chunks must be sequential, at most 4 MB, and match the current file size. Verify the final SHA-256 when needed.',
    inputSchema: { projectId: z.string(), path: z.string(), base64: z.string(), offset: z.number().int().nonnegative().default(0), truncate: z.boolean().optional(), expectedSha256: z.string().optional() }
  }, async ({ projectId, path, base64, offset, truncate, expectedSha256 }) => result(await files.writeBinary(projectId, path, base64, { offset, truncate, expectedSha256 })))

  server.registerTool('file_archive_create', {
    title: 'Create a ZIP archive',
    description: 'Create a ZIP from a project file or directory, excluding dependencies and build output. Useful for STEP, STL, KiCad, and complete project transfer.',
    inputSchema: { projectId: z.string(), sourcePath: z.string().default('.'), destinationPath: z.string().default('web-codex-export.zip') }
  }, async ({ projectId, sourcePath, destinationPath }) => result(await files.createArchive(projectId, sourcePath, destinationPath)))

  server.registerTool('file_archive_extract', {
    title: 'Extract a ZIP archive safely',
    description: 'Extract a project ZIP with entry count, size, and path traversal protections.',
    inputSchema: { projectId: z.string(), archivePath: z.string(), destinationPath: z.string().default('.') }
  }, async ({ projectId, archivePath, destinationPath }) => result(await files.extractArchive(projectId, archivePath, destinationPath)))

  server.registerTool('upload_list', {
    title: 'List uploaded attachments',
    description: 'List files dropped into the Web Codex attachment inbox, including STEP, STL, KiCad, and ZIP files. No base64 transfer is needed to copy them into a project.',
    inputSchema: {}
  }, async () => {
    assertCondition(uploads, 'Attachment inbox is unavailable', 'UPLOAD_UNAVAILABLE')
    return result(await uploads.list())
  })

  server.registerTool('upload_copy', {
    title: 'Copy an attachment into a project',
    description: 'Copy an uploaded attachment into a project directory without base64 encoding. Same-name behavior is controlled by onConflict.',
    inputSchema: { uploadId: z.string(), projectId: z.string(), destinationPath: z.string().default('./'), onConflict: z.enum(['fail', 'overwrite', 'rename']).default('fail') }
  }, async ({ uploadId, projectId, destinationPath, onConflict }) => {
    assertCondition(uploads, 'Attachment inbox is unavailable', 'UPLOAD_UNAVAILABLE')
    return result(await uploads.copyToProject(uploadId, projectId, destinationPath, onConflict))
  })

  server.registerTool('upload_extract', {
    title: 'Extract an uploaded ZIP into a project',
    description: 'Safely extract an uploaded ZIP into a project directory with entry count, size, and path traversal protections.',
    inputSchema: { uploadId: z.string(), projectId: z.string(), destinationPath: z.string().default('.') }
  }, async ({ uploadId, projectId, destinationPath }) => {
    assertCondition(uploads, 'Attachment inbox is unavailable', 'UPLOAD_UNAVAILABLE')
    return result(await uploads.extractToProject(uploadId, projectId, destinationPath))
  })

  server.registerTool('shell_run', {
    title: 'Run a local command',
    description: 'Run cmd, PowerShell, bash, or zsh in a registered project. Commands have the full desktop-user authority and can access outside the project; the working-directory boundary is not a sandbox. Use wait=false for servers and other long-running tasks.',
    inputSchema: {
      projectId: z.string(),
      command: z.string(),
      shell: z.enum(['auto', 'cmd', 'powershell', 'bash', 'zsh']).default('auto'),
      cwd: z.string().default('.'),
      timeoutMs: z.number().int().positive().max(86_400_000).default(120_000),
      wait: z.boolean().default(true),
      idempotencyKey: z.string().max(256).optional()
    }
  }, async ({ projectId, command, shell: shellKind, cwd, timeoutMs, wait, idempotencyKey }) => {
    const policy = projects.get(projectId).remoteShell
    const decision = authorizeRemoteShell(policy, command)
    assertCondition(decision.allowed, decision.reason ?? 'Remote shell command denied by project policy', 'REMOTE_SHELL_DENIED')
    return result(await shell.run({ projectId, command, shell: shellKind, cwd, timeoutMs, wait, idempotencyKey }))
  })

  server.registerTool('process_run', {
    title: 'Run a structured executable',
    description: 'Run an executable with separate argv, environment, and standard input. No shell interprets the arguments, but the process still has full desktop-user authority and is not project-sandboxed. Reuse idempotencyKey to avoid duplicate side effects.',
    inputSchema: {
      projectId: z.string(),
      executable: z.string(),
      args: z.array(z.string()).max(1000).default([]),
      cwd: z.string().default('.'),
      env: z.record(z.string(), z.string()).default({}),
      inheritEnv: z.boolean().default(true),
      stdin: z.string().optional(),
      timeoutMs: z.number().int().positive().max(86_400_000).default(120_000),
      wait: z.boolean().default(true),
      idempotencyKey: z.string().max(256).optional()
    }
  }, async ({ projectId, executable, args, cwd, env, inheritEnv, stdin, timeoutMs, wait, idempotencyKey }) => {
    const decision = authorizeRemoteShell(projects.get(projectId).remoteShell, [executable, ...args].join(' '))
    assertCondition(decision.allowed, decision.reason ?? 'Remote process denied by project policy', 'REMOTE_SHELL_DENIED')
    return result(await shell.runProcess({ projectId, executable, args, cwd, env, inheritEnv, stdin, timeoutMs, wait, idempotencyKey }))
  })

  server.registerTool('shell_task_list', {
    title: 'List task metadata',
    description: 'List task metadata only, without stdout or stderr. Filter by project/status and use nextCursor for pagination.',
    inputSchema: { projectId: z.string().optional(), status: z.enum(['running', 'completed', 'failed', 'stopped']).optional(), limit: z.number().int().positive().max(100).default(20), cursor: z.string().optional() }
  }, async ({ projectId, status, limit, cursor }) => result(shell.listSummaries({ projectId, status, limit, cursor })))

  server.registerTool('shell_task_get', {
    title: 'Read task metadata',
    description: 'Get task status, exit code, timestamps, output byte sizes, and error state. Use shell_task_output for stdout or stderr content.',
    inputSchema: { taskId: z.string() }
  }, async ({ taskId }) => result(shell.summary(taskId)))

  server.registerTool('shell_task_output', {
    title: 'Read task output incrementally',
    description: 'Read stdout or stderr by byte offset. Continue with nextOffset until eof is true, avoiding huge repeated responses.',
    inputSchema: { taskId: z.string(), stream: z.enum(['stdout', 'stderr']).default('stdout'), offset: z.number().int().nonnegative().default(0), maxBytes: z.number().int().positive().max(1_000_000).default(65_536) }
  }, async ({ taskId, stream, offset, maxBytes }) => result(shell.output(taskId, stream, offset, maxBytes)))

  server.registerTool('shell_task_input', {
    title: 'Write task standard input',
    description: 'Write text to a running task stdin. This is a pipe and does not emulate a full PTY/TUI terminal.',
    inputSchema: { taskId: z.string(), data: z.string(), appendNewline: z.boolean().default(true) }
  }, async ({ taskId, data, appendNewline }) => result(await shell.writeInput(taskId, data, appendNewline)))

  server.registerTool('shell_task_close_input', {
    title: 'Close task standard input',
    description: 'Close stdin for a running task so a program waiting for EOF can continue.',
    inputSchema: { taskId: z.string() }
  }, async ({ taskId }) => result(await shell.closeInput(taskId)))

  server.registerTool('shell_task_stop', {
    title: 'Stop a shell task',
    description: 'Stop a running command and its process tree.',
    inputSchema: { taskId: z.string() }
  }, async ({ taskId }) => result(await shell.stop(taskId)))

  server.registerTool('git_status', {
    title: 'Read Git status',
    description: 'Return branch, upstream, ahead/behind counts, clean state, and changed paths for the project repository.',
    inputSchema: { projectId: z.string() }
  }, async ({ projectId }) => {
    assertCondition(git, 'Git service is unavailable', 'GIT_UNAVAILABLE')
    return result(await git.status(projectId))
  })

  server.registerTool('git_diff', {
    title: 'Read a Git diff',
    description: 'Return a bounded unified diff for working-tree or staged changes. Base revision and path are validated.',
    inputSchema: { projectId: z.string(), staged: z.boolean().default(false), base: z.string().optional(), path: z.string().optional() }
  }, async ({ projectId, staged, base, path }) => {
    assertCondition(git, 'Git service is unavailable', 'GIT_UNAVAILABLE')
    return result(await git.diff(projectId, { staged, base, path }))
  })

  server.registerTool('git_log', {
    title: 'Read recent Git history',
    description: 'Return recent commits with full hash, short hash, author, ISO date, and subject.',
    inputSchema: { projectId: z.string(), limit: z.number().int().positive().max(100).default(20) }
  }, async ({ projectId, limit }) => {
    assertCondition(git, 'Git service is unavailable', 'GIT_UNAVAILABLE')
    return result(await git.log(projectId, limit))
  })

  server.registerTool('git_branch_list', {
    title: 'List Git branches',
    description: 'List local and remote branches with abbreviated commit and current-branch marker.',
    inputSchema: { projectId: z.string() }
  }, async ({ projectId }) => {
    assertCondition(git, 'Git service is unavailable', 'GIT_UNAVAILABLE')
    return result(await git.branches(projectId))
  })

  server.registerTool('git_worktree_list', {
    title: 'List Git worktrees',
    description: 'List linked worktrees with path, HEAD, branch, bare, and prunable state. This operation is read-only.',
    inputSchema: { projectId: z.string() }
  }, async ({ projectId }) => {
    assertCondition(git, 'Git service is unavailable', 'GIT_UNAVAILABLE')
    return result(await git.worktrees(projectId))
  })

  server.registerTool('git_worktree_add', {
    title: 'Create a project-contained Git worktree',
    description: 'Create a new-branch worktree below the project .worktrees directory. Destination, branch, and base revision are validated.',
    inputSchema: { projectId: z.string(), path: z.string(), branch: z.string(), base: z.string().default('HEAD') }
  }, async ({ projectId, path, branch, base }) => {
    assertCondition(git, 'Git service is unavailable', 'GIT_UNAVAILABLE')
    return result(await git.addWorktree(projectId, path, branch, base))
  })

  server.registerTool('git_worktree_remove', {
    title: 'Remove a registered project worktree',
    description: 'Remove a worktree only when its project-relative path is registered below .worktrees. The main worktree and unregistered paths are protected.',
    inputSchema: { projectId: z.string(), path: z.string(), force: z.boolean().default(false) }
  }, async ({ projectId, path, force }) => {
    assertCondition(git, 'Git service is unavailable', 'GIT_UNAVAILABLE')
    return result(await git.removeWorktree(projectId, path, force))
  })

  server.registerTool('git_conflict_list', {
    title: 'List unresolved Git conflicts',
    description: 'Return unmerged project-relative paths from the current index state. This operation is read-only.',
    inputSchema: { projectId: z.string() }
  }, async ({ projectId }) => {
    assertCondition(git, 'Git service is unavailable', 'GIT_UNAVAILABLE')
    return result(await git.conflicts(projectId))
  })

  server.registerTool('git_resolve_conflicts', {
    title: 'Resolve explicit Git conflicts',
    description: 'Resolve only paths that are currently unmerged using an explicit ours or theirs strategy, then stage the chosen files. No implicit strategy or force option exists.',
    inputSchema: { projectId: z.string(), paths: z.array(z.string()).min(1).max(200), strategy: z.enum(['ours', 'theirs']) }
  }, async ({ projectId, paths, strategy }) => {
    assertCondition(git, 'Git service is unavailable', 'GIT_UNAVAILABLE')
    return result(await git.resolveConflicts(projectId, paths, strategy))
  })

  server.registerTool('git_stage', {
    title: 'Stage explicit project paths',
    description: 'Stage only the listed project-relative paths. Paths cannot leave the project.',
    inputSchema: { projectId: z.string(), paths: z.array(z.string()).min(1).max(200) }
  }, async ({ projectId, paths }) => {
    assertCondition(git, 'Git service is unavailable', 'GIT_UNAVAILABLE')
    return result(await git.stage(projectId, paths))
  })

  server.registerTool('git_commit', {
    title: 'Create a local Git commit',
    description: 'Commit staged changes or explicitly listed paths. Does not amend, push, or bypass Git hooks.',
    inputSchema: { projectId: z.string(), message: z.string().max(4000), paths: z.array(z.string()).max(200).optional() }
  }, async ({ projectId, message, paths }) => {
    assertCondition(git, 'Git service is unavailable', 'GIT_UNAVAILABLE')
    return result(await git.commit(projectId, message, paths))
  })

  server.registerTool('host_capabilities', {
    title: 'Describe host and execution boundaries',
    description: 'Return OS, CPU/memory/disk, runtimes, available tools, proxy, project permissions, and truthful sandbox boundaries.',
    inputSchema: { projectId: z.string().optional() }
  }, async ({ projectId }) => {
    assertCondition(host, 'Host diagnostics are unavailable', 'HOST_UNAVAILABLE')
    return result(await host.capabilities(projectId))
  })

  server.registerTool('connection_health', {
    title: 'Check local execution health',
    description: 'Return Gateway process uptime, protocol versions, authorization mode, and execution-service readiness.',
    inputSchema: {}
  }, async () => {
    const config = dependencies.store.get()
    return result({
      healthy: true,
      processUptimeSeconds: Math.round(process.uptime()),
      versions: { webCodex: packageJson.version, node: process.version, mcpProtocols: supportedProtocolVersions },
      gateway: { host: config.gateway.host, port: config.gateway.port, authentication: 'bearer' },
      services: { files: true, shell: true, uploads: Boolean(uploads), git: Boolean(git), host: Boolean(host), downstreamMcp: true },
      sandboxed: false
    })
  })

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

  server.registerTool('mcp_resource_list', {
    title: 'List downstream MCP resources',
    description: 'List resources exposed by connected MCP servers. Each result includes serverId, URI, MIME type, and metadata.',
    inputSchema: { serverId: z.string().optional() }
  }, async ({ serverId }) => result(await hub.listResources(serverId)))

  server.registerTool('mcp_resource_read', {
    title: 'Read a downstream MCP resource',
    description: 'Read one downstream MCP resource by serverId and exact URI. Responses are limited to 4 MB.',
    inputSchema: { serverId: z.string(), uri: z.string() }
  }, async ({ serverId, uri }) => result(await hub.readResource(serverId, uri)))

  server.registerTool('mcp_prompt_list', {
    title: 'List downstream MCP prompts',
    description: 'List reusable prompts exposed by connected MCP servers, including declared argument metadata.',
    inputSchema: { serverId: z.string().optional() }
  }, async ({ serverId }) => result(await hub.listPrompts(serverId)))

  server.registerTool('mcp_prompt_get', {
    title: 'Load a downstream MCP prompt',
    description: 'Load one reusable prompt by serverId and prompt name with string arguments. Prompt content is returned as MCP messages.',
    inputSchema: { serverId: z.string(), name: z.string(), arguments: z.record(z.string(), z.string()).default({}) }
  }, async ({ serverId, name, arguments: args }) => result(await hub.getPrompt(serverId, name, args)))

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
    if (method === 'server/discover' && !Array.isArray(body)) {
      res.status(200).json({
        jsonrpc: '2.0',
        id: body?.id ?? null,
        result: {
          resultType: 'complete',
          supportedVersions: supportedProtocolVersions,
          capabilities: { tools: { listChanged: true } },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'web-codex', version: packageJson.version } },
          instructions: workspaceInstructions
        }
      })
      this.dependencies.logger?.info({ category: 'gateway', action: 'gateway.response', message: 'Remote MCP request completed: server/discover', origin: 'remote', status: 'success', requestId, durationMs: Date.now() - startedAt, data: { method, statusCode: 200, supportedVersions: supportedProtocolVersions } })
      return
    }
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