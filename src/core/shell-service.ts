import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ShellKind, ShellOutputChunk, ShellTask, ShellTaskListResult, ShellTaskSummary } from '../shared/types'
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
  idempotencyKey?: string
}

export interface ProcessRunOptions {
  projectId: string
  executable: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  inheritEnv?: boolean
  stdin?: string
  timeoutMs?: number
  wait?: boolean
  maxOutputBytes?: number
  idempotencyKey?: string
}

export interface ShellTaskFilter {
  projectId?: string
  status?: ShellTask['status']
  limit?: number
  cursor?: string
}

export interface ShellServiceOptions {
  statePath?: string
  maxConcurrentTasks?: number
}

interface MutableTask extends ShellTask {
  child?: ChildProcess
  timeout?: NodeJS.Timeout
}

interface LaunchInput {
  projectId: string
  command: string
  kind: ShellTask['kind']
  shell: ShellTask['shell']
  executable: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  stdin?: string
  timeoutMs?: number
  wait: boolean
  maxOutputBytes?: number
  idempotencyKey?: string
  windowsVerbatimArguments?: boolean
  cleanupDir?: string
}

interface PersistedTask extends ShellTask {
  child?: never
  timeout?: never
}

function defaultShell(): Exclude<ShellKind, 'auto'> {
  if (process.platform === 'win32') return 'cmd'
  const configured = process.env.SHELL ?? ''
  if (configured.endsWith('zsh')) return 'zsh'
  return 'bash'
}

async function shellCommand(shell: Exclude<ShellKind, 'auto'>, command: string): Promise<{ executable: string; args: string[]; cleanupDir?: string }> {
  if (shell === 'cmd') {
    assertCondition(process.platform === 'win32', 'cmd is only available on Windows', 'SHELL_UNAVAILABLE')
    if (!/[^\x00-\x7f]/.test(command)) {
      return { executable: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', command] }
    }
    const directory = await mkdtemp(join(tmpdir(), 'web-codex-cmd-'))
    const script = join(directory, 'command.cmd')
    await writeFile(script, `@echo off\r\nchcp 65001>nul\r\n${command}\r\nexit /b %ERRORLEVEL%\r\n`, { encoding: 'utf8', mode: 0o600 })
    return { executable: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${script}"`], cleanupDir: directory }
  }
  if (shell === 'powershell') {
    const utf8Prefix = '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;'
    return {
      executable: process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${utf8Prefix}${command}`]
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

function summarize(task: MutableTask): ShellTaskSummary {
  return {
    id: task.id,
    projectId: task.projectId,
    command: task.command,
    kind: task.kind,
    shell: task.shell,
    executable: task.executable,
    args: task.args,
    cwd: task.cwd,
    status: task.status,
    pid: task.pid,
    exitCode: task.exitCode,
    signal: task.signal,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    truncated: task.truncated,
    stdinOpen: task.stdinOpen,
    idempotencyKey: task.idempotencyKey,
    stateReason: task.stateReason,
    stdoutBytes: Buffer.byteLength(task.stdout),
    stderrBytes: Buffer.byteLength(task.stderr)
  }
}

function taskOutput(task: MutableTask, stream: 'stdout' | 'stderr', offset: number, maxBytes: number): ShellOutputChunk {
  const buffer = Buffer.from(task[stream], 'utf8')
  assertCondition(Number.isSafeInteger(offset) && offset >= 0 && offset <= buffer.length, 'Invalid output offset', 'SHELL_OUTPUT_OFFSET_INVALID')
  assertCondition(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 1_000_000, 'maxBytes must be between 1 and 1000000', 'SHELL_OUTPUT_LIMIT_INVALID')
  let start = offset
  while (start > 0 && start < buffer.length && (buffer[start] & 0xc0) === 0x80) start -= 1
  let end = Math.min(start + maxBytes, buffer.length)
  while (end < buffer.length && end > start && (buffer[end] & 0xc0) === 0x80) end -= 1
  if (end === start && start < buffer.length) {
    end = start + 1
    while (end < buffer.length && (buffer[end] & 0xc0) === 0x80) end += 1
  }
  return {
    taskId: task.id,
    stream,
    offset: start,
    requestedOffset: offset,
    nextOffset: end,
    totalBytes: buffer.length,
    data: buffer.subarray(start, end).toString('utf8'),
    eof: end >= buffer.length
  }
}

export class ShellService extends EventEmitter {
  private readonly tasks = new Map<string, MutableTask>()
  private readonly maxOutputBytes = 2_000_000
  private readonly statePath?: string
  private maxConcurrentTasks: number
  private persistTimer?: NodeJS.Timeout
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly projects: ProjectService, private readonly logger?: ActivityLogger, options: ShellServiceOptions = {}) {
    super()
    this.statePath = options.statePath
    this.maxConcurrentTasks = Math.max(1, Math.min(Math.trunc(options.maxConcurrentTasks ?? 20), 200))
  }

  get concurrencyLimit(): number {
    return this.maxConcurrentTasks
  }

  setConcurrencyLimit(value: number): void {
    assertCondition(Number.isInteger(value) && value >= 1 && value <= 200, "Concurrency limit must be an integer between 1 and 200", "SHELL_CONCURRENCY_LIMIT_INVALID")
    this.maxConcurrentTasks = value
  }

  async initialize(): Promise<void> {
    if (!this.statePath) return
    try {
      const stored = JSON.parse(await readFile(this.statePath, 'utf8')) as PersistedTask[]
      assertCondition(Array.isArray(stored), 'Task state must be an array', 'SHELL_STATE_INVALID')
      let recovered = 0
      for (const item of stored) {
        if (!item || typeof item.id !== 'string' || typeof item.projectId !== 'string') continue
        const task: MutableTask = {
          ...item,
          kind: item.kind ?? 'shell',
          stdinOpen: false,
          stdout: typeof item.stdout === 'string' ? item.stdout : '',
          stderr: typeof item.stderr === 'string' ? item.stderr : ''
        }
        if (task.status === 'running') {
          task.status = 'failed'
          task.stateReason = 'Application restarted before task completion; final process state is unknown'
          task.endedAt = new Date().toISOString()
          recovered += 1
        }
        this.tasks.set(task.id, task)
      }
      if (recovered > 0) {
        this.logger?.warn({ category: 'shell', action: 'shell.state_recovered', message: 'Recovered interrupted shell tasks with unknown final state', origin: 'system', data: { recovered } })
        this.schedulePersist()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger?.warn({ category: 'shell', action: 'shell.state_load_failed', message: 'Could not load persisted task state', origin: 'system', data: { error: error instanceof Error ? error.message : String(error) } })
      }
    }
  }

  list(): ShellTask[] {
    return [...this.tasks.values()].map(publicTask).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  listSummaries(filter: ShellTaskFilter = {}): ShellTaskListResult {
    const limit = Math.max(1, Math.min(filter.limit ?? 20, 100))
    const offset = Math.max(0, Number.parseInt(filter.cursor ?? '0', 10) || 0)
    const filtered = [...this.tasks.values()]
      .filter((task) => !filter.projectId || task.projectId === filter.projectId)
      .filter((task) => !filter.status || task.status === filter.status)
      .map(summarize)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    return {
      tasks: filtered.slice(offset, offset + limit),
      nextCursor: offset + limit < filtered.length ? String(offset + limit) : null
    }
  }

  summary(id: string): ShellTaskSummary {
    const task = this.tasks.get(id)
    if (!task) throw new AppError(`Shell task not found: ${id}`, 'SHELL_TASK_NOT_FOUND')
    return summarize(task)
  }

  get(id: string): ShellTask {
    const task = this.tasks.get(id)
    if (!task) throw new AppError(`Shell task not found: ${id}`, 'SHELL_TASK_NOT_FOUND')
    return publicTask(task)
  }

  output(id: string, stream: 'stdout' | 'stderr', offset = 0, maxBytes = 65_536): ShellOutputChunk {
    const task = this.tasks.get(id)
    if (!task) throw new AppError(`Shell task not found: ${id}`, 'SHELL_TASK_NOT_FOUND')
    return taskOutput(task, stream, offset, maxBytes)
  }

  async run(options: ShellRunOptions): Promise<ShellTask> {
    assertCondition(options.command.trim().length > 0, 'Command is required', 'SHELL_COMMAND_REQUIRED')
    const shell = options.shell && options.shell !== 'auto' ? options.shell : defaultShell()
    this.validateIdempotencyKey(options.idempotencyKey)
    const existing = this.findByIdempotencyKey(options.projectId, options.idempotencyKey)
    if (existing) return existing
    const cwd = await this.projectCwd(options.projectId, options.cwd)
    const invocation = await shellCommand(shell, options.command)
    return this.launch({
      projectId: options.projectId,
      command: options.command,
      kind: 'shell',
      shell,
      executable: invocation.executable,
      args: invocation.args,
      cleanupDir: invocation.cleanupDir,
      cwd,
      env: process.platform === 'win32' ? { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } : process.env,
      timeoutMs: options.timeoutMs,
      wait: options.wait !== false,
      maxOutputBytes: options.maxOutputBytes,
      idempotencyKey: options.idempotencyKey,
      windowsVerbatimArguments: process.platform === 'win32' && shell === 'cmd'
    })
  }

  async runProcess(options: ProcessRunOptions): Promise<ShellTask> {
    assertCondition(options.executable.trim().length > 0, 'Executable is required', 'PROCESS_EXECUTABLE_REQUIRED')
    assertCondition((options.args?.length ?? 0) <= 1000, 'Process argument limit exceeded', 'PROCESS_ARGS_LIMIT')
    this.validateIdempotencyKey(options.idempotencyKey)
    const existing = this.findByIdempotencyKey(options.projectId, options.idempotencyKey)
    if (existing) return existing
    const cwd = await this.projectCwd(options.projectId, options.cwd)
    const args = options.args ?? []
    const env = options.inheritEnv === false ? { ...options.env } : { ...process.env, ...options.env }
    return this.launch({
      projectId: options.projectId,
      command: [options.executable, ...args].join(' '),
      kind: 'process',
      shell: 'process',
      executable: options.executable,
      args,
      cwd,
      env,
      stdin: options.stdin,
      timeoutMs: options.timeoutMs,
      wait: options.wait !== false,
      maxOutputBytes: options.maxOutputBytes,
      idempotencyKey: options.idempotencyKey
    })
  }

  async writeInput(id: string, data: string, appendNewline = true): Promise<ShellTaskSummary> {
    const task = this.tasks.get(id)
    if (!task) throw new AppError(`Shell task not found: ${id}`, 'SHELL_TASK_NOT_FOUND')
    assertCondition(task.status === 'running' && task.child?.stdin && !task.child.stdin.destroyed, 'Task standard input is not available', 'SHELL_STDIN_UNAVAILABLE')
    assertCondition(Buffer.byteLength(data) <= 1_000_000, 'Standard input exceeds 1 MB', 'SHELL_STDIN_LIMIT')
    await new Promise<void>((resolveWrite, rejectWrite) => {
      task.child?.stdin?.write(appendNewline ? `${data}\n` : data, (error) => error ? rejectWrite(error) : resolveWrite())
    })
    this.logger?.info({ category: 'shell', action: 'shell.stdin', message: 'Wrote standard input to running task', projectId: task.projectId, taskId: id, data: { bytes: Buffer.byteLength(data), appendNewline } })
    this.schedulePersist()
    return summarize(task)
  }

  async closeInput(id: string): Promise<ShellTaskSummary> {
    const task = this.tasks.get(id)
    if (!task) throw new AppError(`Shell task not found: ${id}`, 'SHELL_TASK_NOT_FOUND')
    task.child?.stdin?.end()
    task.stdinOpen = false
    this.logger?.info({ category: 'shell', action: 'shell.stdin_closed', message: 'Closed task standard input', projectId: task.projectId, taskId: id })
    this.emit('change', publicTask(task))
    this.schedulePersist()
    return summarize(task)
  }

  async stop(id: string): Promise<ShellTask> {
    const task = this.tasks.get(id)
    if (!task) throw new AppError(`Shell task not found: ${id}`, 'SHELL_TASK_NOT_FOUND')
    if (task.status !== 'running' || !task.child) return publicTask(task)
    task.status = 'stopped'
    task.stdinOpen = false
    this.logger?.warn({ category: 'shell', action: 'shell.stop', message: 'Stopping shell command', status: 'stopped', projectId: task.projectId, taskId: id, data: { command: task.command, pid: task.pid } })
    const child = task.child
    if (child.stdin && !child.stdin.destroyed) child.stdin.end()
    const exited = new Promise<void>((resolveExit) => child.once('close', () => resolveExit()))
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
    await Promise.race([
      exited,
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 2000))
    ])
    this.emit('change', publicTask(task))
    this.schedulePersist()
    return publicTask(task)
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.tasks.values()].filter((task) => task.status === 'running').map((task) => this.stop(task.id)))
    await this.flush()
  }

  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = undefined
    }
    await this.persist()
    await this.writeQueue
  }

  private async projectCwd(projectId: string, requestedCwd?: string): Promise<string> {
    const root = await this.projects.root(projectId)
    const cwd = resolve(root, requestedCwd ?? '.')
    const pathFromRoot = relative(root, cwd)
    assertCondition(pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot)), 'Working directory leaves the project folder', 'PATH_OUTSIDE_PROJECT')
    const canonicalCwd = await realpath(cwd)
    const canonicalPathFromRoot = relative(root, canonicalCwd)
    assertCondition(canonicalPathFromRoot === '' || (!canonicalPathFromRoot.startsWith(`..${sep}`) && canonicalPathFromRoot !== '..' && !isAbsolute(canonicalPathFromRoot)), 'Working directory leaves the project folder', 'PATH_OUTSIDE_PROJECT')
    return canonicalCwd
  }

  private validateIdempotencyKey(key?: string): void {
    if (!key) return
    assertCondition(key.length <= 256, 'idempotencyKey must be 256 characters or fewer', 'IDEMPOTENCY_KEY_INVALID')
  }

  private findByIdempotencyKey(projectId: string, key?: string): ShellTask | null {
    if (!key) return null
    const task = [...this.tasks.values()].find((item) => item.projectId === projectId && item.idempotencyKey === key)
    return task ? publicTask(task) : null
  }

  private async launch(input: LaunchInput): Promise<ShellTask> {
    const runningTasks = [...this.tasks.values()].filter((task) => task.status === 'running').length
    assertCondition(runningTasks < this.maxConcurrentTasks, `Concurrent task limit reached (${this.maxConcurrentTasks})`, 'SHELL_CONCURRENCY_LIMIT')
    const id = randomUUID()
    const task: MutableTask = {
      id,
      projectId: input.projectId,
      command: input.command,
      kind: input.kind,
      shell: input.shell,
      executable: input.executable,
      args: input.args,
      cwd: input.cwd,
      status: 'running',
      exitCode: null,
      signal: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      stdout: '',
      stderr: '',
      truncated: false,
      stdinOpen: false,
      idempotencyKey: input.idempotencyKey
    }
    this.logger?.info({ category: 'shell', action: input.kind === 'process' ? 'process.start' : 'shell.start', message: input.kind === 'process' ? `Running executable: ${input.executable}` : `Running ${input.shell} command`, status: 'started', projectId: input.projectId, taskId: id, data: { command: input.command, executable: input.executable, args: input.args, shell: input.shell, cwd: input.cwd, wait: input.wait, timeoutMs: input.timeoutMs, idempotencyKey: input.idempotencyKey } })
    let child: ChildProcess
    try {
      child = spawn(input.executable, input.args, {
        cwd: input.cwd,
        env: input.env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: input.windowsVerbatimArguments,
        stdio: 'pipe',
        detached: process.platform !== 'win32'
      })
    } catch (error) {
      task.status = 'failed'
      task.stateReason = error instanceof Error ? error.message : String(error)
      task.endedAt = new Date().toISOString()
      this.tasks.set(id, task)
      this.logger?.error({ category: 'shell', action: 'shell.spawn_failed', message: 'Failed to start process', projectId: input.projectId, taskId: id, data: { error: task.stateReason } })
      this.schedulePersist()
      if (input.cleanupDir) await rm(input.cleanupDir, { recursive: true, force: true }).catch(() => undefined)
      return publicTask(task)
    }
    task.child = child
    task.pid = child.pid
    task.stdinOpen = Boolean(child.stdin && !child.stdin.destroyed)
    this.tasks.set(id, task)
    this.pruneTasks()
    await this.persist()
    const outputLimit = Math.min(input.maxOutputBytes ?? this.maxOutputBytes, this.maxOutputBytes)
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
    const append = (stream: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      const current = Buffer.byteLength(task[stream])
      if (current >= outputLimit) {
        task.truncated = true
        return
      }
      const text = typeof chunk === 'string' ? chunk : decoders[stream].write(chunk)
      task[stream] += text.slice(0, outputLimit - current)
      if (Buffer.byteLength(text) > outputLimit - current) task.truncated = true
      this.emit('change', publicTask(task))
      this.schedulePersist()
    }
    child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk))
    child.on('error', (error) => {
      task.stderr += error.message
      task.status = 'failed'
      task.stateReason = error.message
      task.endedAt = new Date().toISOString()
      task.stdinOpen = false
      this.logger?.error({ category: 'shell', action: 'shell.process_error', message: 'Process failed', projectId: task.projectId, taskId: id, data: { command: task.command, error: error.message } })
      this.emit('change', publicTask(task))
      this.schedulePersist()
      if (input.cleanupDir) void rm(input.cleanupDir, { recursive: true, force: true }).catch(() => undefined)
    })
    const finished = new Promise<void>((resolveFinished) => {
      child.once('close', (exitCode, signal) => {
        if (task.timeout) clearTimeout(task.timeout)
        const stdoutTail = decoders.stdout.end()
        const stderrTail = decoders.stderr.end()
        if (stdoutTail) append('stdout', stdoutTail)
        if (stderrTail) append('stderr', stderrTail)
        task.exitCode = exitCode
        task.signal = signal
        task.status = task.status === 'stopped' ? 'stopped' : exitCode === 0 ? 'completed' : 'failed'
        task.endedAt = new Date().toISOString()
        task.child = undefined
        task.stdinOpen = false
        if (task.stateReason === undefined) delete task.stateReason
        this.logger?.[task.status === 'failed' ? 'error' : 'info']({ category: 'shell', action: 'shell.closed', message: `Task ${task.status}`, status: task.status === 'completed' ? 'success' : task.status === 'stopped' ? 'stopped' : 'error', projectId: task.projectId, taskId: id, durationMs: Date.parse(task.endedAt) - Date.parse(task.startedAt), data: { command: task.command, exitCode, signal, stdoutBytes: Buffer.byteLength(task.stdout), stderrBytes: Buffer.byteLength(task.stderr), truncated: task.truncated } })
        if (input.cleanupDir) void rm(input.cleanupDir, { recursive: true, force: true }).catch(() => undefined)
        this.emit('change', publicTask(task))
        this.schedulePersist()
        resolveFinished()
      })
    })
    if (input.timeoutMs && input.timeoutMs > 0) {
      task.timeout = setTimeout(() => {
        if (task.status === 'running') {
          task.stderr += `\nTask timed out after ${input.timeoutMs}ms`
          task.stateReason = `Timed out after ${input.timeoutMs}ms`
          this.logger?.warn({ category: 'shell', action: 'shell.timeout', message: `Task timed out after ${input.timeoutMs}ms`, projectId: task.projectId, taskId: id, data: { command: task.command, timeoutMs: input.timeoutMs } })
          void this.stop(id)
        }
      }, Math.min(input.timeoutMs, 86_400_000))
    }
    if (input.stdin !== undefined && child.stdin) child.stdin.end(input.stdin)
    this.emit('change', publicTask(task))
    this.schedulePersist()
    if (input.wait) await finished
    return publicTask(task)
  }

  private pruneTasks(): void {
    if (this.tasks.size <= 200) return
    const removable = [...this.tasks.values()]
      .filter((task) => task.status !== 'running')
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    while (this.tasks.size > 200 && removable.length > 0) {
      const task = removable.shift()
      if (task) this.tasks.delete(task.id)
    }
  }

  private schedulePersist(): void {
    if (!this.statePath || this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      void this.persist()
    }, 500)
    this.persistTimer.unref()
  }

  private persist(): Promise<void> {
    if (!this.statePath) return Promise.resolve()
    const state = JSON.stringify([...this.tasks.values()].map(publicTask), null, 2)
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.statePath as string), { recursive: true })
      const temporary = `${this.statePath}.${process.pid}.tmp`
      await writeFile(temporary, state, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.statePath as string)
    }).catch((error: unknown) => {
      this.logger?.warn({ category: 'shell', action: 'shell.state_write_failed', message: 'Could not persist task state', origin: 'system', data: { error: error instanceof Error ? error.message : String(error) } })
    })
    return this.writeQueue
  }
}