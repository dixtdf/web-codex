import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigStore } from '../../src/core/config-store'
import { ProjectService } from '../../src/core/project-service'
import { ShellService } from '../../src/core/shell-service'
import type { Project } from '../../src/shared/types'

let temporaryDirectory: string
let project: Project
let shells: ShellService

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'web-codex-shell-'))
  const store = new ConfigStore(join(temporaryDirectory, 'config.json'))
  await store.load()
  const projects = new ProjectService(store)
  project = await projects.create({ path: join(temporaryDirectory, 'workspace') })
  shells = new ShellService(projects)
})

afterEach(async () => {
  await shells.stopAll()
  vi.unstubAllEnvs()
  await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
}, 30_000)

describe('ShellService execution', () => {
  it('runs the platform default shell and captures stdout, stderr, and exit metadata', async () => {
    const task = await shells.run({
      projectId: project.id,
      command: nodeEval('console.log(123);console.error(456)')
    })

    expect(task).toMatchObject({ projectId: project.id, status: 'completed', exitCode: 0, signal: null, stdout: '123\n', stderr: '456\n', truncated: false })
    expect(task.pid).toEqual(expect.any(Number))
    expect(Date.parse(task.startedAt)).toBeLessThanOrEqual(Date.parse(task.endedAt ?? ''))
    expect(task.cwd).toBe(project.path)
    expect(shells.get(task.id)).toEqual(task)
    expect(shells.list()).toEqual([task])
    expect(task).not.toHaveProperty('child')
    expect(task).not.toHaveProperty('timeout')

    await expect(shells.stop(task.id)).resolves.toMatchObject({ id: task.id, status: 'completed' })
  })

  it('reports non-zero exits without discarding process output', async () => {
    const task = await shells.run({ projectId: project.id, command: nodeEval('console.log(123);process.exit(7)') })

    expect(task).toMatchObject({ status: 'failed', exitCode: 7, stdout: '123\n' })
  })

  it('supports explicit native shell selection', async () => {
    const task = process.platform === 'win32'
      ? await shells.run({ projectId: project.id, shell: 'powershell', command: `Write-Output 'powershell-ok'` })
      : await shells.run({ projectId: project.id, shell: 'bash', command: `printf 'bash-ok'` })

    expect(task.status).toBe('completed')
    expect(task.stdout.trim()).toBe(process.platform === 'win32' ? 'powershell-ok' : 'bash-ok')
    expect(task.shell).toBe(process.platform === 'win32' ? 'powershell' : 'bash')
  })

  it('completes simple CMD built-in commands with output and exit metadata', async () => {
    if (process.platform !== 'win32') return
    const task = await shells.run({ projectId: project.id, shell: 'cmd', command: 'echo CMD_1453', timeoutMs: 4000 })

    expect(task).toMatchObject({ status: 'completed', exitCode: 0, signal: null, stdout: 'CMD_1453\r\n', stderr: '' })
    const quoted = await shells.run({ projectId: project.id, shell: 'cmd', command: `node -e "console.log('quoted-ok')"`, timeoutMs: 4000 })
    expect(quoted).toMatchObject({ status: 'completed', exitCode: 0 })
    expect(quoted.stdout.trim()).toBe('quoted-ok')
  })

  it('runs inside a project-relative working directory', async () => {
    await mkdir(join(project.path, 'nested'))
    const task = await shells.run({ projectId: project.id, cwd: 'nested', command: nodeEval('console.log(process.cwd())') })

    expect(task.status).toBe('completed')
    expect(task.cwd).toBe(join(project.path, 'nested'))
    expect(task.stdout.trim()).toBe(join(project.path, 'nested'))
  })

  it('bounds retained output and marks truncated tasks', async () => {
    const task = await shells.run({ projectId: project.id, command: nodeEval(`process.stdout.write('123456789')`), maxOutputBytes: 5 })

    expect(task).toMatchObject({ status: 'completed', stdout: '12345', truncated: true })
  })

  it('discards later output chunks after reaching the retained-output limit', async () => {
    const script = `process.stdout.write('12345');setTimeout(process.stdout.write.bind(process.stdout),20,'67890')`
    const task = await shells.run({ projectId: project.id, command: nodeEval(script), maxOutputBytes: 5 })

    expect(task).toMatchObject({ status: 'completed', stdout: '12345', truncated: true })
  })

  it('records process startup failures as failed tasks', async () => {
    if (process.platform === 'win32') {
      vi.stubEnv('ComSpec', join(temporaryDirectory, 'missing-cmd.exe'))
    } else {
      vi.stubEnv('PATH', join(temporaryDirectory, 'missing-bin'))
    }
    const task = await shells.run({ projectId: project.id, command: 'irrelevant', shell: process.platform === 'win32' ? 'cmd' : 'powershell' })

    expect(task.status).toBe('failed')
    expect(task.stderr).toContain('ENOENT')
    expect(task.endedAt).not.toBeNull()
  })
})

describe('ShellService task control', () => {
  it('starts long-running commands in the background and stops their process tree', async () => {
    const task = await shells.run({
      projectId: project.id,
      command: `node -e "setTimeout(() => console.log('finished'), 30000)"`,
      wait: false
    })
    expect(task).toMatchObject({ status: 'running', endedAt: null })

    const stopped = await shells.stop(task.id)
    expect(stopped).toMatchObject({ id: task.id, status: 'stopped' })
    await expect(shells.stop(task.id)).resolves.toMatchObject({ status: 'stopped' })
  })

  it('terminates commands that exceed their timeout', async () => {
    const task = await shells.run({
      projectId: project.id,
      command: `node -e "setTimeout(() => console.log('finished'), 30000)"`,
      timeoutMs: 30
    }, )

    expect(task.status).toBe('stopped')
    expect(task.stderr).toContain('Task timed out after 30ms')
    expect(task.endedAt).not.toBeNull()
  })

  it('validates commands, working directories, task IDs, and unavailable shells', async () => {
    await expect(shells.run({ projectId: project.id, command: '  ' })).rejects.toMatchObject({ code: 'SHELL_COMMAND_REQUIRED' })
    await expect(shells.run({ projectId: project.id, command: 'node --version', cwd: '..' })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' })
    await expect(shells.run({ projectId: project.id, command: 'node --version', shell: process.platform === 'win32' ? 'bash' : 'cmd' })).rejects.toMatchObject({ code: 'SHELL_UNAVAILABLE' })

    expect(() => shells.get('missing')).toThrowError(expect.objectContaining({ code: 'SHELL_TASK_NOT_FOUND' }))
    await expect(shells.stop('missing')).rejects.toMatchObject({ code: 'SHELL_TASK_NOT_FOUND' })
  })

  it('rejects a working-directory symlink that leaves the project', async () => {
    const outside = join(temporaryDirectory, 'outside')
    await mkdir(outside)
    await symlink(outside, join(project.path, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(shells.run({ projectId: project.id, command: 'node --version', cwd: 'linked' })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' })
    expect(shells.list()).toEqual([])
  })
})
function nodeEval(code: string): string {
  return process.platform === 'win32' ? `node -e ${code}` : `node -e "${code}"`
}