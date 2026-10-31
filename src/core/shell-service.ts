import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ShellKind, ShellTask } from '../shared/types'
import { AppError, assertCondition } from './errors'
import { ProjectService } from './project-service'
import type { ActivityLogger } from './activity-logger'

export interface ShellRunOptions {
  projectId: string
  command: string
  shell?: ShellKind
  cwd?: string
  timeoutMs?: number
  wait?: boolean
  maxOutputBytes?: number
}

interface MutableTask extends ShellTask {
  child?: ChildProcess
  timeout?: NodeJS.Timeout
}

function defaultShell(): Exclude<ShellKind, 'auto'> {
  if (process.platform === 'win32') return 'cmd'
  const configured = process.env.SHELL ?? ''
  if (configured.endsWith('zsh')) return 'zsh'
  return 'bash'
}

function shellCommand(shell: Exclude<ShellKind, 'auto'>, command: string): { executable: string; args: string[] } {
  if (shell === 'cmd') {
    assertCondition(process.platform === 'win32', 'cmd is only available on Windows', 'SHELL_UNAVAILABLE')
    return { executable: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', command] }
  }
  if (shell === 'powershell') {
    return {
      executable: process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
    }
  }
  assertCondition(process.platform !== 'win32', `${shell} is not a default Windows shell`, 'SHELL_UNAVAILABLE')
  return { executable: shell, args: ['-lc', command] }
}

function publicTask(task: MutableTask): ShellTask {
  const snapshot = { ...task }
  delete snapshot.child
  delete snapshot.timeout
  return snapshot
}

export class ShellService extends EventEmitter {
  private readonly tasks = new Map<string, MutableTask>()
  private readonly maxOutputBytes = 2_000_000

  constructor(private readonly projects: ProjectService, private readonly logger?: ActivityLogger) {
    super()
  }

  list(): ShellTask[] {
    return [...this.tasks.values()].map(publicTask).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  get(id: string): ShellTask {
    const task = this.tasks.get(id)
    if (!task) throw new AppError(`Shell task not found: ${id}`, 'SHELL_TASK_NOT_FOUND')
    return publicTask(task)
  }

  async run(options: ShellRunOptions): Promise<ShellTask> {
    assertCondition(options.command.trim().length > 0, 'Command is required', 'SHELL_COMMAND_REQUIRED')
    const root = await this.projects.root(options.projectId)
    const cwd = resolve(root, options.cwd ?? '.')
    const pathFromRoot = relative(root, cwd)
    assertCondition(pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot)), 'Working directory leaves the project folder', 'PATH_OUTSIDE_PROJECT')
    const canonicalCwd = await realpath(cwd)
    const canonicalPathFromRoot = relative(root, canonicalCwd)
    assertCondition(canonicalPathFromRoot === '' || (!canonicalPathFromRoot.startsWith(`..${sep}`) && canonicalPathFromRoot !== '..' && !isAbsolute(canonicalPathFromRoot)), 'Working directory leaves the project folder', 'PATH_OUTSIDE_PROJECT')
    const shell = options.shell && options.shell !== 'auto' ? options.shell : defaultShell()
    const invocation = shellCommand(shell, options.command)
    const id = randomUUID()
    const task: MutableTask = {
      id,
      projectId: options.projectId,
      command: options.command,
      shell,
      cwd: canonicalCwd,
      status: 'running',
      exitCode: null,
      signal: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      stdout: '',
      stderr: '',
      truncated: false
    }
    this.logger?.info({ category: 'shell', action: 'shell.start', message: `Running ${shell} command`, status: 'started', projectId: options.projectId, taskId: id, data: { command: options.command, shell, cwd: canonicalCwd, wait: options.wait !== false, timeoutMs: options.timeoutMs } })
    const child = spawn(invocation.executable, invocation.args, {
      cwd: canonicalCwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32'
    })
    task.child = child
    task.pid = child.pid
    this.tasks.set(id, task)
    const outputLimit = Math.min(options.maxOutputBytes ?? this.maxOutputBytes, this.maxOutputBytes)
    const append = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      const current = Buffer.byteLength(task[stream])
      if (current >= outputLimit) {
        task.truncated = true
        return
      }
      const text = chunk.toString('utf8')
      task[stream] += text.slice(0, outputLimit - current)
      if (Buffer.byteLength(text) > outputLimit - current) task.truncated = true
      this.emit('change', publicTask(task))
    }
    child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk))
    child.on('error', (error) => {
      task.stderr += error.message
      task.status = 'failed'
      task.endedAt = new Date().toISOString()
      this.logger?.error({ category: 'shell', action: 'shell.process_error', message: 'Shell process failed', projectId: task.projectId, taskId: id, data: { command: task.command, error: error.message } })
      this.emit('change', publicTask(task))
    })
    const finished = new Promise<void>((resolveFinished) => {
      child.once('close', (exitCode, signal) => {
        if (task.timeout) clearTimeout(task.timeout)
        task.exitCode = exitCode
        task.signal = signal
        task.status = task.status === 'stopped' ? 'stopped' : exitCode === 0 ? 'completed' : 'failed'
        task.endedAt = new Date().toISOString()
        task.child = undefined
        this.logger?.[task.status === 'failed' ? 'error' : 'info']({ category: 'shell', action: 'shell.closed', message: `Shell command ${task.status}`, status: task.status === 'completed' ? 'success' : task.status === 'stopped' ? 'stopped' : 'error', projectId: task.projectId, taskId: id, durationMs: Date.parse(task.endedAt) - Date.parse(task.startedAt), data: { command: task.command, exitCode, signal, stdoutBytes: Buffer.byteLength(task.stdout), stderrBytes: Buffer.byteLength(task.stderr), truncated: task.truncated } })
        this.emit('change', publicTask(task))
        resolveFinished()
      })
    })
    if (options.timeoutMs && options.timeoutMs > 0) {
      task.timeout = setTimeout(() => {
        if (task.status === 'running') {
          task.stderr += `\nCommand timed out after ${options.timeoutMs}ms`
          this.logger?.warn({ category: 'shell', action: 'shell.timeout', message: `Shell command timed out after ${options.timeoutMs}ms`, projectId: task.projectId, taskId: id, data: { command: task.command, timeoutMs: options.timeoutMs } })
          void this.stop(id)
        }
      }, Math.min(options.timeoutMs, 86_400_000))
    }
    this.emit('change', publicTask(task))
    if (options.wait !== false) {
      await finished
    }
    return publicTask(task)
  }

  async stop(id: string): Promise<ShellTask> {
    const task = this.tasks.get(id)
    if (!task) throw new AppError(`Shell task not found: ${id}`, 'SHELL_TASK_NOT_FOUND')
    if (task.status !== 'running' || !task.child) return publicTask(task)
    task.status = 'stopped'
    this.logger?.warn({ category: 'shell', action: 'shell.stop', message: 'Stopping shell command', status: 'stopped', projectId: task.projectId, taskId: id, data: { command: task.command, pid: task.pid } })
    const child = task.child
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
      await new Promise<void>((resolveKill) => {
        const timeout = setTimeout(resolveKill, 5000)
        timeout.unref()
        killer.once('close', () => {
          clearTimeout(timeout)
          resolveKill()
        })
        killer.once('error', () => {
          clearTimeout(timeout)
          resolveKill()
        })
      })
    } else if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
    } else {
      child.kill('SIGTERM')
    }
    this.emit('change', publicTask(task))
    return publicTask(task)
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.tasks.values()].filter((task) => task.status === 'running').map((task) => this.stop(task.id)))
  }
}