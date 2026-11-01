import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigStore } from '../../src/core/config-store'
import { ProjectService } from '../../src/core/project-service'
import { ShellService } from '../../src/core/shell-service'
import type { Project, ShellTask } from '../../src/shared/types'

let temporaryDirectory: string
let project: Project
let projects: ProjectService
let statePath: string
let shells: ShellService

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'web-codex-shell-advanced-'))
  const store = new ConfigStore(join(temporaryDirectory, 'config.json'))
  await store.load()
  projects = new ProjectService(store)
  project = await projects.create({ path: join(temporaryDirectory, 'workspace') })
  statePath = join(temporaryDirectory, 'tasks.json')
  shells = new ShellService(projects, undefined, { statePath })
  await shells.initialize()
})

afterEach(async () => {
  await shells.stopAll()
  await rm(temporaryDirectory, { recursive: true, force: true })
})

describe('interactive and structured processes', () => {
  it('writes stdin, closes input, and reads output in bounded chunks', async () => {
    const script = "process.stdin.setEncoding('utf8');let data='';process.stdin.on('data',(chunk)=>data+=chunk);process.stdin.on('end',()=>console.log('got:'+data.trim()))"
    const task = await shells.runProcess({ projectId: project.id, executable: process.execPath, args: ['-e', script], wait: false })
    expect(task).toMatchObject({ status: 'running', kind: 'process', shell: 'process', stdinOpen: true })

    await expect(shells.writeInput(task.id, 'hello')).resolves.toMatchObject({ id: task.id, status: 'running' })
    await shells.closeInput(task.id)
    await vi.waitFor(() => expect(shells.get(task.id).status).toBe('completed'))
    expect(shells.output(task.id, 'stdout')).toMatchObject({ offset: 0, eof: true, data: 'got:hello\n' })
    expect(shells.summary(task.id).stdoutBytes).toBe(10)
    await expect(shells.writeInput(task.id, 'late')).rejects.toMatchObject({ code: 'SHELL_STDIN_UNAVAILABLE' })
    expect(() => shells.output(task.id, 'stdout', 999)).toThrowError(expect.objectContaining({ code: 'SHELL_OUTPUT_OFFSET_INVALID' }))
  })

  it('paginates UTF-8 task output without stalling or splitting characters', async () => {
    const task = await shells.runProcess({ projectId: project.id, executable: process.execPath, args: ['-e', "console.log('A中🙂B')"] })
    let offset = 0
    let output = ''
    let guard = 0
    while (offset < shells.summary(task.id).stdoutBytes) {
      const chunk = shells.output(task.id, 'stdout', offset, 1)
      expect(chunk.data).not.toContain('\uFFFD')
      expect(chunk.nextOffset).toBeGreaterThan(offset)
      expect(chunk.offset).toBeLessThanOrEqual(chunk.requestedOffset)
      output += chunk.data
      offset = chunk.nextOffset
      if (++guard > 20) throw new Error('Shell output pagination did not advance')
    }
    expect(output).toBe('A中🙂B\n')
    expect(shells.output(task.id, 'stdout', 2, 1)).toMatchObject({ data: '中', offset: 1, requestedOffset: 2, nextOffset: 4 })
  })

  it('deduplicates idempotent structured launches and supports process stdin input', async () => {
    const first = await shells.runProcess({ projectId: project.id, executable: process.execPath, args: ['-e', "process.stdin.on('data',(c)=>process.stdout.write(c))"], stdin: 'piped', idempotencyKey: 'same-process' })
    const second = await shells.runProcess({ projectId: project.id, executable: process.execPath, args: ['-e', 'console.log(2)'], idempotencyKey: 'same-process' })
    expect(second.id).toBe(first.id)
    expect(first).toMatchObject({ status: 'completed', stdout: 'piped' })
    await expect(shells.runProcess({ projectId: project.id, executable: '  ' })).rejects.toMatchObject({ code: 'PROCESS_EXECUTABLE_REQUIRED' })
    await expect(shells.runProcess({ projectId: project.id, executable: process.execPath, args: Array.from({ length: 1001 }, () => 'x') })).rejects.toMatchObject({ code: 'PROCESS_ARGS_LIMIT' })
  })

  it('deduplicates concurrent launches with the same idempotency key', async () => {
    const options = { projectId: project.id, executable: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'], wait: false, idempotencyKey: 'concurrent-process' }
    const [first, second] = await Promise.all([shells.runProcess(options), shells.runProcess(options)])

    expect(second.id).toBe(first.id)
    expect(shells.list().filter((task) => task.idempotencyKey === 'concurrent-process')).toHaveLength(1)
    await shells.stop(first.id)
  })

  it('enforces output limits in bytes without splitting UTF-8 characters', async () => {
    const task = await shells.runProcess({ projectId: project.id, executable: process.execPath, args: ['-e', "process.stdout.write('A中🙂B')"], maxOutputBytes: 5 })

    expect(task).toMatchObject({ status: 'completed', stdout: 'A中', truncated: true })
    expect(Buffer.byteLength(task.stdout)).toBe(4)
    expect(shells.summary(task.id).stdoutBytes).toBe(4)
    await expect(shells.runProcess({ projectId: project.id, executable: process.execPath, maxOutputBytes: 0 })).rejects.toMatchObject({ code: 'SHELL_OUTPUT_LIMIT_INVALID' })
  })

  it.skipIf(process.platform === 'win32')('force-kills a process that ignores graceful termination', async () => {
    const task = await shells.runProcess({ projectId: project.id, executable: process.execPath, args: ['-e', "process.on('SIGTERM', () => {});setInterval(() => {}, 1000)"], wait: false })

    await expect(shells.stop(task.id)).resolves.toMatchObject({ id: task.id, status: 'stopped' })
    expect(shells.get(task.id)).toMatchObject({ status: 'stopped', signal: 'SIGKILL' })
  })

  it('enforces the concurrent process limit and releases slots after stopping tasks', async () => {
    const limited = new ShellService(projects, undefined, { statePath: join(temporaryDirectory, 'limited-tasks.json'), maxConcurrentTasks: 2 })
    try {
      const script = 'setTimeout(() => {}, 30000)'
      const first = await limited.runProcess({ projectId: project.id, executable: process.execPath, args: ['-e', script], wait: false })
      const second = await limited.runProcess({ projectId: project.id, executable: process.execPath, args: ['-e', script], wait: false })
      await expect(limited.runProcess({ projectId: project.id, executable: process.execPath, args: ['-e', script], wait: false })).rejects.toMatchObject({ code: 'SHELL_CONCURRENCY_LIMIT' })
      await limited.stop(first.id)
      const replacement = await limited.runProcess({ projectId: project.id, executable: process.execPath, args: ['-e', 'console.log(2)'] })
      expect(replacement.status).toBe('completed')
      expect(await limited.stop(second.id)).toMatchObject({ status: 'stopped' })
    } finally {
      await limited.stopAll()
      await limited.flush()
    }
  })

  it('validates runtime concurrency-limit updates', async () => {
    expect(shells.concurrencyLimit).toBe(20)
    shells.setConcurrencyLimit(2)
    expect(shells.concurrencyLimit).toBe(2)
    for (const invalid of [0, 201, 1.5, Number.NaN]) {
      expect(() => shells.setConcurrencyLimit(invalid)).toThrowError(expect.objectContaining({ code: 'SHELL_CONCURRENCY_LIMIT_INVALID' }))
    }
    expect(shells.concurrencyLimit).toBe(2)
  })

  it('filters and paginates task summaries without exposing output bodies', async () => {
    await shells.runProcess({ projectId: project.id, executable: process.execPath, args: ['-e', 'console.log(1)'] })
    await shells.runProcess({ projectId: project.id, executable: process.execPath, args: ['-e', 'console.log(2)'] })
    const firstPage = shells.listSummaries({ projectId: project.id, status: 'completed', limit: 1 })
    expect(firstPage.tasks).toHaveLength(1)
    expect(firstPage.tasks[0]).not.toHaveProperty('stdout')
    expect(firstPage.nextCursor).toBe('1')
    const secondPage = shells.listSummaries({ projectId: project.id, status: 'completed', limit: 1, cursor: '1' })
    expect(secondPage.tasks).toHaveLength(1)
    expect(secondPage.nextCursor).toBeNull()
    expect(shells.listSummaries({ projectId: 'missing' }).tasks).toEqual([])
  })
})

describe('task persistence and recovery', () => {
  it('persists completed tasks and marks interrupted running tasks as failed on restart', async () => {
    const completed = await shells.runProcess({ projectId: project.id, executable: process.execPath, args: ['-e', 'console.log(42)'] })
    await shells.flush()
    const restart = new ShellService(new ProjectService(new ConfigStore(join(temporaryDirectory, 'ignored.json'))), undefined, { statePath })
    await restart.initialize()
    expect(restart.get(completed.id)).toMatchObject({ status: 'completed', stdout: '42\n' })

    const stored = JSON.parse(await readFile(statePath, 'utf8')) as ShellTask[]
    expect(stored).toEqual([expect.objectContaining({ id: completed.id, status: 'completed' })])
    stored[0].status = 'running'
    stored[0].endedAt = null
    await writeFile(statePath, JSON.stringify(stored))
    const recovered = new ShellService(new ProjectService(new ConfigStore(join(temporaryDirectory, 'unused.json'))), undefined, { statePath })
    await recovered.initialize()
    expect(recovered.get(completed.id)).toMatchObject({ status: 'failed', stateReason: expect.stringContaining('final process state is unknown') })
  })

  it('tolerates missing or malformed persisted state', async () => {
    const missing = new ShellService(new ProjectService(new ConfigStore(join(temporaryDirectory, 'unused-2.json'))), undefined, { statePath: join(temporaryDirectory, 'missing.json') })
    await expect(missing.initialize()).resolves.toBeUndefined()
    await writeFile(statePath, '{broken')
    const malformed = new ShellService(new ProjectService(new ConfigStore(join(temporaryDirectory, 'unused-3.json'))), undefined, { statePath })
    await expect(malformed.initialize()).resolves.toBeUndefined()
    expect(malformed.list()).toEqual([])
  })
})