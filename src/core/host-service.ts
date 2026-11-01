import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { statfs } from 'node:fs/promises'
import { cpus, arch, freemem, homedir, platform, release, totalmem, uptime, type as osType } from 'node:os'
import type { ProjectService } from './project-service'
import type { ProxyManager } from './proxy-manager'

const execFileAsync = promisify(execFile)

export interface HostCapabilities {
  host: {
    platform: NodeJS.Platform
    type: string
    release: string
    arch: string
    hostname: string
    home: string
    uptimeSeconds: number
    privileged: boolean
  }
  resources: {
    cpuModel: string
    cpuCount: number
    totalMemoryBytes: number
    freeMemoryBytes: number
    disk?: { path: string; totalBytes: number; freeBytes: number }
  }
  runtimes: {
    node: string
    electron?: string
    npm?: string
  }
  tools: Record<string, { available: boolean; path?: string }>
  environment: Record<string, string | undefined>
  project?: { id: string; root: string; enabled: boolean; remoteShellMode: string; allowedPrefixes: string[] }
  proxy: ReturnType<ProxyManager['getState']>
  executionBoundary: {
    sandboxed: false
    files: string
    shell: string
    network: string
    note: string
  }
  features: string[]
}

export class HostService {
  private cache?: { expiresAt: number; tools: Record<string, { available: boolean; path?: string }> }

  constructor(private readonly projects: ProjectService, private readonly proxy: ProxyManager, private readonly isPrivileged: () => boolean = () => false) {}

  async capabilities(projectId?: string): Promise<HostCapabilities> {
    const project = projectId ? this.projects.get(projectId) : undefined
    const root = project?.path ?? process.cwd()
    const cpuList = cpus()
    let disk: HostCapabilities['resources']['disk']
    try {
      const stats = await statfs(root)
      disk = { path: root, totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize }
    } catch {
      disk = undefined
    }
    return {
      host: { platform: platform(), type: osType(), release: release(), arch: arch(), hostname: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'localhost', home: homedir(), uptimeSeconds: Math.round(uptime()), privileged: this.isPrivileged() },
      resources: { cpuModel: cpuList[0]?.model ?? 'unknown', cpuCount: cpuList.length, totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), disk },
      runtimes: { node: process.version, electron: process.versions.electron, npm: process.env.npm_config_user_agent?.match(/npm\/([^\s]+)/)?.[1] },
      tools: await this.detectTools(),
      environment: { SHELL: process.env.SHELL, ComSpec: process.env.ComSpec, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMPDIR: process.env.TMPDIR },
      project: project ? { id: project.id, root: project.path, enabled: project.enabled, remoteShellMode: project.remoteShell?.mode ?? 'allow', allowedPrefixes: project.remoteShell?.allowedPrefixes ?? [] } : undefined,
      proxy: this.proxy.getState(),
      executionBoundary: {
        sandboxed: false,
        files: 'Structured file tools are restricted to registered project roots and reject symlink/path escapes.',
        shell: 'Shell and process tools execute with the desktop user authority; cwd validation is not an OS sandbox.',
        network: 'Child processes use the host network. Remote MCP HTTP honors the configured proxy; loopback always bypasses it.',
        note: 'Use per-project remote shell deny/allowlist policies when restricted remote execution is required.'
      },
      features: ['projects', 'files', 'binary-transfer', 'archives', 'uploads', 'shell', 'structured-process', 'task-recovery', 'task-pagination', 'git', 'mcp-hub', 'proxy', 'jsonl-audit', 'trash']
    }
  }

  private async detectTools(): Promise<Record<string, { available: boolean; path?: string }>> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.tools
    const names = ['git', 'node', 'npm', 'python', 'python3', 'pwsh', 'powershell', 'cmd', 'bash', 'sh', 'zsh']
    const entries = await Promise.all(names.map(async (name) => {
      try {
        const command = process.platform === 'win32' ? 'where.exe' : 'which'
        const { stdout } = await execFileAsync(command, [name], { windowsHide: true, timeout: 5000, encoding: 'utf8' })
        return [name, { available: true, path: stdout.split(/\r?\n/)[0]?.trim() }]
      } catch {
        return [name, { available: false }]
      }
    }))
    const tools = Object.fromEntries(entries)
    this.cache = { expiresAt: Date.now() + 30_000, tools }
    return tools
  }
}