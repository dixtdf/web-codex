import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AuditLogEvent, AuditLogFilter, LogCategory, LogLevel, LogOrigin, LogServiceState, LogStatus } from '../shared/types'
import { errorMessage } from './errors'

export interface LogEventInput {
  level?: LogLevel
  category: LogCategory
  action: string
  message: string
  origin?: LogOrigin
  status?: LogStatus
  requestId?: string
  projectId?: string
  taskId?: string
  durationMs?: number
  data?: unknown
}

export interface ActivityLoggerOptions {
  directory: string
  secrets?: () => string[]
  retentionDays?: number
  maxFileBytes?: number
  maxRecentEvents?: number
}

interface LogContext {
  origin: LogOrigin
  requestId?: string
}

function contentSummary(content: string): Record<string, unknown> {
  return {
    omitted: true,
    bytes: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex')
  }
}

function binaryContentSummary(content: string): Record<string, unknown> {
  const binary = Buffer.from(content.replace(/\s/g, ''), 'base64')
  return {
    omitted: true,
    bytes: binary.length,
    sha256: createHash('sha256').update(binary).digest('hex')
  }
}

function redactOpenAIMetadata(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  let changed = false
  if (Array.isArray(value)) {
    for (const item of value) changed = redactOpenAIMetadata(item) || changed
    return changed
  }
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('openai/') || /^timezone(?:_offset_minutes)?$/i.test(key)) {
      (value as Record<string, unknown>)[key] = '[REDACTED]'
      changed = true
    } else {
      changed = redactOpenAIMetadata(child) || changed
    }
  }
  return changed
}

function auditFileOrder(filename: string): { day: string; sequence: number } {
  const match = filename.match(/^audit-(\d{4}-\d{2}-\d{2})(?:-(\d{4}))?\.jsonl$/)
  return { day: match?.[1] ?? '', sequence: Number(match?.[2] ?? 0) }
}

export class ActivityLogger extends EventEmitter {
  private readonly context = new AsyncLocalStorage<LogContext>()
  private readonly recent: AuditLogEvent[] = []
  private readonly secrets?: () => string[]
  private readonly retentionDays: number
  private readonly maxFileBytes: number
  private readonly maxRecentEvents: number
  private writeQueue: Promise<void> = Promise.resolve()
  private lastError?: string

  constructor(public readonly directory: string, options: Omit<ActivityLoggerOptions, 'directory'> = {}) {
    super()
    this.secrets = options.secrets
    this.retentionDays = options.retentionDays ?? 14
    this.maxFileBytes = options.maxFileBytes ?? 10_000_000
    this.maxRecentEvents = options.maxRecentEvents ?? 1500
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    await this.removeExpiredFiles()
    await this.scrubLegacyMetadata()
    await this.loadRecent()
  }

  runWithContext<T>(context: LogContext, callback: () => T): T {
    return this.context.run(context, callback)
  }

  debug(input: LogEventInput): AuditLogEvent {
    return this.record({ ...input, level: 'debug' })
  }

  info(input: LogEventInput): AuditLogEvent {
    return this.record({ ...input, level: 'info' })
  }

  warn(input: LogEventInput): AuditLogEvent {
    return this.record({ ...input, level: 'warn' })
  }

  error(input: LogEventInput): AuditLogEvent {
    return this.record({ ...input, level: 'error', status: input.status ?? 'error' })
  }

  record(input: LogEventInput): AuditLogEvent {
    const context = this.context.getStore()
    const level = input.level ?? 'info'
    const event: AuditLogEvent = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      level,
      category: input.category,
      action: input.action,
      message: this.redactText(input.message),
      origin: input.origin ?? context?.origin ?? 'local',
      status: input.status ?? (level === 'error' ? 'error' : 'info'),
      requestId: input.requestId ?? context?.requestId,
      projectId: input.projectId,
      taskId: input.taskId,
      durationMs: input.durationMs,
      data: input.data === undefined ? undefined : this.sanitize(input.data)
    }
    this.recent.unshift(event)
    if (this.recent.length > this.maxRecentEvents) this.recent.length = this.maxRecentEvents
    this.emit('change', event)
    const line = `${JSON.stringify(event)}\n`
    this.writeQueue = this.writeQueue.then(() => this.append(line, event.timestamp)).catch((error: unknown) => {
      this.lastError = this.redactText(errorMessage(error))
      this.emit('state', this.getState())
    })
    return event
  }

  list(filter: AuditLogFilter = {}): AuditLogEvent[] {
    const query = filter.query?.trim().toLowerCase()
    const limit = Math.max(1, Math.min(filter.limit ?? 300, 2000))
    return this.recent.filter((event) => {
      if (filter.category && filter.category !== 'all' && event.category !== filter.category) return false
      if (filter.level && filter.level !== 'all' && event.level !== filter.level) return false
      if (filter.origin && filter.origin !== 'all' && event.origin !== filter.origin) return false
      if (query && !JSON.stringify(event).toLowerCase().includes(query)) return false
      return true
    }).slice(0, limit)
  }

  getState(): LogServiceState {
    return {
      directory: this.directory,
      persistent: !this.lastError,
      retentionDays: this.retentionDays,
      lastError: this.lastError
    }
  }

  async flush(): Promise<void> {
    await this.writeQueue
  }

  async exportTo(destination: string): Promise<{ files: number; destination: string }> {
    await this.flush()
    const files = await this.logFiles()
    const contents = await Promise.all(files.map((file) => readFile(join(this.directory, file), 'utf8')))
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, contents.map((content) => content.endsWith('\n') ? content : `${content}\n`).join(''), { encoding: 'utf8', mode: 0o600 })
    return { files: files.length, destination }
  }

  redactText(value: string): string {
    let text = value
    const secrets = (this.secrets?.() ?? []).filter((secret) => secret.length >= 4).sort((a, b) => b.length - a.length)
    for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]')
    return text
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
      .replace(/\btunnel_[a-z0-9]{16,}\b/gi, '[REDACTED]')
      .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]')
      .replace(/([?&](?:code|state|session|key)=)[^&\s]+/gi, '$1[REDACTED]')
      .replace(/((?:^|\s)--?(?:access[-_]?token|auth[-_]?token|api[-_]?key|token|password|secret|authorization|private-?key|passphrase|tunnel[-_]?id)\s+)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
      .replace(/((?:"|')?(?:access[-_]?token|auth[-_]?token|api[-_]?key|token|password|secret|authorization|private_?key|passphrase|tunnel[-_]?id)(?:"|')?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
      .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[REDACTED]@')
  }

  private sanitize(value: unknown, key = '', depth = 0, seen = new WeakSet<object>()): unknown {
    if (value === null || value === undefined) return value
    if (typeof value === 'string') {
      if (['content', 'oldText', 'newText'].includes(key)) return contentSummary(value)
      if (key === 'base64') return binaryContentSummary(value)
      const redacted = this.redactText(value)
      return redacted.length > 8000 ? `${redacted.slice(0, 8000)}…[truncated]` : redacted
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value
    if (typeof value === 'bigint') return value.toString()
    if (value instanceof Error) return { name: value.name, message: this.redactText(value.message) }
    if (Buffer.isBuffer(value)) return { omitted: true, bytes: value.length, sha256: createHash('sha256').update(value).digest('hex') }
    if (value instanceof Date) return value.toISOString()
    if (depth >= 8) return '[truncated]'
    if (typeof value === 'object') {
      if (seen.has(value)) return '[circular]'
      seen.add(value)
      if (Array.isArray(value)) return value.slice(0, 200).map((item) => this.sanitize(item, '', depth + 1, seen))
      const output: Record<string, unknown> = {}
      for (const [childKey, childValue] of Object.entries(value).slice(0, 100)) {
        if (childKey.startsWith('openai/') || /^timezone(?:_offset_minutes)?$/i.test(childKey) || /(?:token|secret|password|authorization|cookie|credential|api_?key|private_?key|passphrase|session_?id|tunnel_?id)/i.test(childKey) || /^(?:headers|env)$/i.test(childKey)) {
          output[childKey] = '[REDACTED]'
        } else {
          output[childKey] = this.sanitize(childValue, childKey, depth + 1, seen)
        }
      }
      return output
    }
    return String(value)
  }

  private async append(line: string, timestamp: string): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const day = timestamp.slice(0, 10)
    for (let sequence = 0; sequence < 10_000; sequence += 1) {
      const suffix = sequence === 0 ? '' : `-${String(sequence).padStart(4, '0')}`
      const filePath = join(this.directory, `audit-${day}${suffix}.jsonl`)
      try {
        const info = await stat(filePath)
        if (info.size + Buffer.byteLength(line) > this.maxFileBytes) continue
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await appendFile(filePath, line, { encoding: 'utf8', mode: 0o600 })
      if (this.lastError) {
        this.lastError = undefined
        this.emit('state', this.getState())
      }
      return
    }
    throw new Error('No audit log file is available after rotation')
  }

  private async logFiles(): Promise<string[]> {
    const entries = await readdir(this.directory, { withFileTypes: true })
    return entries.filter((entry) => entry.isFile() && /^audit-\d{4}-\d{2}-\d{2}(?:-\d{4})?\.jsonl$/.test(entry.name)).map((entry) => entry.name).sort((left, right) => {
      const leftOrder = auditFileOrder(left)
      const rightOrder = auditFileOrder(right)
      return leftOrder.day.localeCompare(rightOrder.day) || leftOrder.sequence - rightOrder.sequence
    })
  }

  private async removeExpiredFiles(): Promise<void> {
    const cutoff = Date.now() - this.retentionDays * 86_400_000
    for (const file of await this.logFiles()) {
      const filePath = join(this.directory, file)
      const info = await stat(filePath)
      if (info.mtimeMs < cutoff) await rm(filePath, { force: true })
    }
  }

  private async scrubLegacyMetadata(): Promise<void> {
    for (const file of await this.logFiles()) {
      const filePath = join(this.directory, file)
      const content = await readFile(filePath, 'utf8')
      let changed = false
      const lines = content.split('\n').map((line) => {
        if (!line.trim()) return line
        try {
          const event = JSON.parse(line) as AuditLogEvent
          const metadataChanged = redactOpenAIMetadata(event)
          const tunnelIdsChanged = this.redactEventTunnelIds(event)
          if (!metadataChanged && !tunnelIdsChanged) return line
          changed = true
          return JSON.stringify(event)
        } catch {
          return line
        }
      })
      if (changed) await writeFile(filePath, lines.join('\n'), { encoding: 'utf8', mode: 0o600 })
    }
  }

  private redactEventTunnelIds(event: AuditLogEvent): boolean {
    let changed = false
    if (typeof event.message === 'string') {
      const redacted = this.redactText(event.message)
      if (redacted !== event.message) {
        event.message = redacted
        changed = true
      }
    }
    if (event.data !== undefined) {
      const before = JSON.stringify(event.data)
      event.data = this.redactTunnelIds(event.data)
      if (JSON.stringify(event.data) !== before) changed = true
    }
    return changed
  }

  private redactTunnelIds(value: unknown): unknown {
    if (typeof value === 'string') return this.redactText(value)
    if (Array.isArray(value)) return value.map((item) => this.redactTunnelIds(item))
    if (value !== null && typeof value === 'object') {
      const output: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(value)) output[key] = this.redactTunnelIds(child)
      return output
    }
    return value
  }

  private async loadRecent(): Promise<void> {
    const files = (await this.logFiles()).reverse()
    const loaded: AuditLogEvent[] = []
    for (const file of files) {
      const lines = (await readFile(join(this.directory, file), 'utf8')).split('\n').reverse()
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          loaded.push(JSON.parse(line) as AuditLogEvent)
          if (loaded.length >= this.maxRecentEvents) break
        } catch {
          continue
        }
      }
      if (loaded.length >= this.maxRecentEvents) break
    }
    this.recent.unshift(...loaded)
  }
}