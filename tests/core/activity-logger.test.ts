import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActivityLogger } from '../../src/core/activity-logger'
import type { AuditLogEvent, LogServiceState } from '../../src/shared/types'

let temporaryDirectory: string
let directory: string

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'web-codex-audit-'))
  directory = join(temporaryDirectory, 'logs')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(temporaryDirectory, { recursive: true, force: true })
})

describe('ActivityLogger JSONL persistence', () => {
  it('writes one redacted JSON object per line with remote context and useful filters', async () => {
    const logger = new ActivityLogger(directory, { secrets: () => ['configured-secret', 'abc'] })
    await logger.initialize()

    logger.runWithContext({ origin: 'remote', requestId: 'req-1' }, () => {
      logger.info({
        category: 'shell',
        action: 'shell.start',
        message: 'Running command with configured-secret',
        projectId: 'project-1',
        taskId: 'task-1',
        data: {
          command: 'curl --token cli-secret --api-key=assigned-secret',
          content: 'raw-file-content',
          headers: { Authorization: 'Bearer header-secret' },
          token: 'object-secret',
          _meta: {
            'openai/subject': 'subject-secret',
            'openai/session': 'session-secret',
            'openai/userLocation': { city: 'PrivateCity' },
            timezone: 'Private/Zone'
          },
          safe: true
        }
      })
    })
    logger.warn({ category: 'network', action: 'network.changed', message: 'Proxy changed', origin: 'system' })
    logger.error({ category: 'app', action: 'app.failed', message: 'Failure' })
    await logger.flush()

    const raw = await readAuditText()
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(3)
    const events = lines.map((line) => JSON.parse(line) as AuditLogEvent)
    expect(events[0]).toMatchObject({
      level: 'info',
      category: 'shell',
      action: 'shell.start',
      origin: 'remote',
      status: 'info',
      requestId: 'req-1',
      projectId: 'project-1',
      taskId: 'task-1'
    })
    expect(events[1]).toMatchObject({ level: 'warn', origin: 'system', status: 'info' })
    expect(events[2]).toMatchObject({ level: 'error', origin: 'local', status: 'error' })
    expect(raw).toContain('curl --token [REDACTED] --api-key=[REDACTED]')
    expect(raw).toContain('"content":{"omitted":true,"bytes":16,"sha256":')
    for (const secret of ['configured-secret', 'cli-secret', 'assigned-secret', 'header-secret', 'object-secret', 'raw-file-content', 'subject-secret', 'session-secret', 'PrivateCity', 'Private/Zone']) {
      expect(raw).not.toContain(secret)
    }

    expect(logger.list({ category: 'shell', origin: 'remote', level: 'info', query: 'shell.start', limit: 1 })).toEqual([events[0]])
    expect(logger.list({ category: 'all', origin: 'all', level: 'all', limit: 0 })).toHaveLength(1)
    expect(logger.getState()).toEqual({ directory, persistent: true, retentionDays: 14, lastError: undefined })
  })

  it('scrubs previously persisted ChatGPT identity, session, location, and timezone metadata', async () => {
    await mkdir(directory, { recursive: true })
    const legacy = auditEvent('gateway.request')
    legacy.data = {
      body: {
        params: {
          _meta: {
            'openai/subject': 'legacy-subject',
            'openai/session': 'legacy-session',
            'openai/organization': 'legacy-organization',
            'openai/userLocation': { city: 'LegacyCity', country: 'XX' },
            timezone: 'Legacy/Zone',
            timezone_offset_minutes: -480
          }
        }
      }
    }
    await writeFile(join(directory, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify(legacy)}\n`)

    const logger = new ActivityLogger(directory)
    await logger.initialize()
    const raw = await readAuditText()
    for (const secret of ['legacy-subject', 'legacy-session', 'legacy-organization', 'LegacyCity', 'Legacy/Zone', '-480']) {
      expect(raw).not.toContain(secret)
    }
    expect(raw).toContain('"openai/subject":"[REDACTED]"')
    expect(raw).toContain('"timezone_offset_minutes":"[REDACTED]"')
  })

  it('redacts Tunnel IDs from new and legacy audit records', async () => {
    const tunnelId = 'tunnel_0123456789abcdef0123456789abcdef'
    const logger = new ActivityLogger(directory)
    await logger.initialize()
    logger.info({
      category: 'tunnel',
      action: 'tunnel.start',
      message: `Starting Tunnel ${tunnelId}`,
      data: {
        tunnel_id: tunnelId,
        TUNNEL_ID: tunnelId,
        command: `tunnel-client run --tunnel-id ${tunnelId}`,
        requestId: 'keep-me'
      }
    })
    await logger.flush()
    expect(await readAuditText()).not.toContain(tunnelId)

    const legacy = auditEvent('tunnel.legacy')
    legacy.message = `Legacy Tunnel ${tunnelId}`
    legacy.requestId = 'legacy-request'
    legacy.data = { tunnelId, command: `run ${tunnelId}`, keep: 'visible' }
    await writeFile(join(directory, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify(legacy) + String.fromCharCode(10), { flag: 'a' })

    const reloaded = new ActivityLogger(directory)
    await reloaded.initialize()
    const raw = await readAuditText()
    expect(raw).not.toContain(tunnelId)
    expect(raw).toContain('[REDACTED]')
    expect(raw).toContain('legacy-request')
    expect(raw).toContain('"keep":"visible"')
    expect(raw).toContain('tunnel.legacy')
  })

  it('redacts common credential forms and summarizes complex values without raw content', async () => {
    const logger = new ActivityLogger(directory)
    await logger.initialize()
    const redacted = logger.redactText([
      'curl --token cli-secret --password "quoted-secret"',
      'TOKEN=environment-secret',
      '{"token":"json-secret"}',
      'Authorization: Bearer bearer-secret',
      'https://user:url-secret@example.com',
      'sk-abcdefgh'
    ].join('\n'))

    for (const secret of ['cli-secret', 'quoted-secret', 'environment-secret', 'json-secret', 'bearer-secret', 'url-secret', 'sk-abcdefgh']) {
      expect(redacted).not.toContain(secret)
    }
    expect(redacted).toContain('curl --token [REDACTED] --password [REDACTED]')
    expect(redacted).toContain('https://[REDACTED]@example.com')

    const circular: Record<string, unknown> = { safe: 'ok' }
    circular.self = circular
    let deep: Record<string, unknown> = { value: 'end' }
    for (let index = 0; index < 12; index += 1) deep = { child: deep }
    logger.debug({
      category: 'app',
      action: 'app.sanitize',
      message: 'Sanitize',
      data: {
        when: new Date('2026-01-02T03:04:05.000Z'),
        bytes: Buffer.from('buffer-content'),
        big: 42n,
        error: new Error('TOKEN=error-secret'),
        circular,
        deep,
        long: 'x'.repeat(8100),
        nil: null,
        missing: undefined,
        list: [1, 'TOKEN=list-secret'],
        callback: () => 'not called'
      }
    })
    await logger.flush()

    const raw = await readAuditText()
    expect(raw).toContain('"bytes":14')
    expect(raw).toContain('"big":"42"')
    expect(raw).toContain('2026-01-02T03:04:05.000Z')
    expect(raw).toContain('[circular]')
    expect(raw).toContain('[truncated]')
    expect(raw).not.toContain('buffer-content')
    expect(raw).not.toContain('error-secret')
    expect(raw).not.toContain('list-secret')
  })

  it('rotates files, bounds recent events, reloads JSONL, and exports a combined audit file', async () => {
    const logger = new ActivityLogger(directory, { maxFileBytes: 550, maxRecentEvents: 3 })
    await logger.initialize()
    for (let index = 0; index < 8; index += 1) {
      logger.info({ category: 'app', action: `event.${index}`, message: `Audit event ${index}`, data: { index } })
    }
    await logger.flush()

    const files = await readdir(directory)
    expect(files.length).toBeGreaterThan(1)
    expect(files.every((file) => /^audit-.*\.jsonl$/.test(file))).toBe(true)
    expect(logger.list()).toHaveLength(3)
    expect(logger.list()[0].action).toBe('event.7')

    const reloaded = new ActivityLogger(directory, { maxRecentEvents: 4 })
    await reloaded.initialize()
    expect(reloaded.list()).toHaveLength(4)
    expect(reloaded.list()[0].action).toBe('event.7')

    const destination = join(temporaryDirectory, 'exports', 'audit.jsonl')
    await expect(logger.exportTo(destination)).resolves.toEqual({ files: files.length, destination })
    const exported = (await readFile(destination, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as AuditLogEvent)
    expect(exported.map((event) => event.action)).toEqual(Array.from({ length: 8 }, (_, index) => `event.${index}`))
  })

  it('removes expired files and ignores malformed lines while loading recent events', async () => {
    await mkdir(directory, { recursive: true })
    const oldEvent = auditEvent('old.event')
    const oldPath = join(directory, 'audit-2020-01-01.jsonl')
    await writeFile(oldPath, `${JSON.stringify(oldEvent)}\n`)
    const past = new Date('2020-01-01T00:00:00.000Z')
    await utimes(oldPath, past, past)

    const currentPath = join(directory, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`)
    await writeFile(currentPath, `{broken\n${JSON.stringify(auditEvent('current.event'))}\n`)
    const logger = new ActivityLogger(directory)
    await logger.initialize()

    expect((await readdir(directory)).some((file) => file.startsWith('audit-2020-01-01'))).toBe(false)
    expect(logger.list().map((event) => event.action)).toEqual(['current.event'])
  })

  it('surfaces persistence failures and recovers after the directory becomes writable', async () => {
    const blocked = join(temporaryDirectory, 'blocked')
    await writeFile(blocked, 'not a directory')
    const logger = new ActivityLogger(blocked)
    const listener = vi.fn<(state: LogServiceState) => void>()
    logger.on('state', listener)

    logger.info({ category: 'app', action: 'write.failed', message: 'Failure' })
    await logger.flush()
    expect(logger.getState()).toMatchObject({ persistent: false, lastError: expect.any(String) })
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ persistent: false }))

    await rm(blocked)
    logger.info({ category: 'app', action: 'write.recovered', message: 'Recovered' })
    await logger.flush()
    expect(logger.getState()).toMatchObject({ persistent: true, lastError: undefined })
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ persistent: true }))
    expect((await readFile(join(blocked, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8'))).toContain('write.recovered')
  })
})

async function readAuditText(): Promise<string> {
  const files = (await readdir(directory)).filter((file) => file.endsWith('.jsonl')).sort()
  const contents = await Promise.all(files.map((file) => readFile(join(directory, file), 'utf8')))
  return contents.join('')
}

function auditEvent(action: string): AuditLogEvent {
  return {
    id: action,
    timestamp: new Date().toISOString(),
    level: 'info',
    category: 'app',
    action,
    message: action,
    origin: 'local',
    status: 'info'
  }
}