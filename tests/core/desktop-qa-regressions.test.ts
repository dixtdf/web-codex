import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '../../src/core/config-store'
import { FileService } from '../../src/core/file-service'
import { ProjectService } from '../../src/core/project-service'
import { ShellService } from '../../src/core/shell-service'
import type { Project } from '../../src/shared/types'

let temporaryDirectory: string
let project: Project
let files: FileService
let shells: ShellService

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'web-codex-desktop-qa-'))
  const store = new ConfigStore(join(temporaryDirectory, 'config.json'))
  await store.load()
  const projects = new ProjectService(store)
  project = await projects.create({ path: join(temporaryDirectory, 'workspace') })
  files = new FileService(projects, { trashDirectory: join(temporaryDirectory, 'trash') })
  shells = new ShellService(projects)
})

afterEach(async () => {
  await shells.stopAll()
  await rm(temporaryDirectory, { recursive: true, force: true })
})

describe('Desktop QA regressions', () => {
  it('never returns a replacement character when UTF-8 reads cross multi-byte boundaries', async () => {
    const text = '中文🙂 café'
    await files.write(project.id, 'unicode.txt', text)
    const size = Buffer.byteLength(text)

    expect(await files.read(project.id, 'unicode.txt')).toMatchObject({ content: text, offset: 0, nextOffset: size, truncated: false })
    const boundary = await files.read(project.id, 'unicode.txt', 9, 5)
    expect(boundary.content).not.toContain('\uFFFD')
    expect(boundary.requestedOffset).toBe(5)
    expect(boundary.offset).toBeLessThanOrEqual(5)
    expect(boundary.actualOffset).toBe(boundary.offset)
    expect(boundary.bytes).toBe(Buffer.byteLength(boundary.content))
    expect(boundary.nextOffset).toBeGreaterThan(boundary.offset)
    expect(boundary.truncated).toBe(true)

    for (const maxBytes of [1, 2, 3, 9]) {
      let offset = 0
      let assembled = ''
      let guard = 0
      while (offset < size) {
        const chunk = await files.read(project.id, 'unicode.txt', maxBytes, offset)
        expect(chunk.content).not.toContain('\uFFFD')
        expect(chunk.nextOffset).toBeGreaterThan(offset)
        assembled += chunk.content
        offset = chunk.nextOffset
        if (++guard > 100) throw new Error('UTF-8 pagination did not advance')
      }
      expect(assembled).toBe(text)
    }
  })

  it('rejects file move overwrite unless explicitly version-confirmed, preserving existing content', async () => {
    await files.write(project.id, 'source.txt', 'source-content')
    const destination = await files.write(project.id, 'destination.txt', 'destination-content')
    const sourceHash = (await files.hash(project.id, 'source.txt')).sha256

    await expect(files.move(project.id, 'source.txt', 'destination.txt')).rejects.toMatchObject({ code: 'FILE_ALREADY_EXISTS' })
    expect(await readFile(join(project.path, 'destination.txt'), 'utf8')).toBe('destination-content')
    expect(await readFile(join(project.path, 'source.txt'), 'utf8')).toBe('source-content')

    await expect(files.move(project.id, 'source.txt', 'destination.txt', { overwrite: true })).rejects.toMatchObject({ code: 'FILE_CONFLICT_HASH_REQUIRED' })
    await expect(files.move(project.id, 'source.txt', 'destination.txt', { overwrite: true, expectedDestinationSha256: '0'.repeat(64) })).rejects.toMatchObject({ code: 'FILE_VERSION_CONFLICT' })
    expect(await readFile(join(project.path, 'destination.txt'), 'utf8')).toBe('destination-content')

    await expect(files.move(project.id, 'source.txt', 'destination.txt', {
      overwrite: true,
      expectedSourceSha256: sourceHash,
      expectedDestinationSha256: destination.sha256
    })).resolves.toMatchObject({
      path: 'destination.txt',
      overwritten: true,
      beforeSha256: destination.sha256,
      sha256: sourceHash
    })
    expect(await readFile(join(project.path, 'destination.txt'), 'utf8')).toBe('source-content')
    await expect(readFile(join(project.path, 'source.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    await files.createDirectory(project.id, 'source-dir')
    await files.write(project.id, 'source-dir/nested.txt', 'nested')
    await files.createDirectory(project.id, 'destination-dir')
    await files.write(project.id, 'destination-dir/existing.txt', 'existing')
    await expect(files.move(project.id, 'source-dir', 'destination-dir', { overwrite: true })).rejects.toMatchObject({ code: 'FILE_OVERWRITE_UNSUPPORTED' })
  })

  it('excludes dependency/build directories and root .gitignore patterns from search', async () => {
    await files.write(project.id, 'visible.txt', 'needle')
    for (const directory of ['.venv', 'target', 'build', '__pycache__']) {
      await files.write(project.id, `${directory}/hidden.txt`, 'needle')
    }
    await files.write(project.id, 'ignored-by-git/also-hidden.txt', 'needle')
    await files.write(project.id, 'ignored.secret', 'needle')
    await files.write(project.id, '.gitignore', 'ignored-by-git/\n*.secret\n')

    expect((await files.search(project.id, 'needle')).matches).toEqual([
      { path: 'visible.txt', line: 1, column: 1, preview: 'needle' }
    ])
    expect((await files.search(project.id, 'needle', { respectGitignore: false })).matches.map((match) => match.path)).toEqual([
      'ignored-by-git/also-hidden.txt',
      'ignored.secret',
      'visible.txt'
    ])
  })

  it('preserves Chinese, Emoji, accented, and Greek text in default, PowerShell, and CMD output', async () => {
    const expected = '中文🙂 café Ω'
    const defaultTask = await shells.run({ projectId: project.id, command: `node -e "console.log('${expected}')"` })
    expect(defaultTask).toMatchObject({ status: 'completed', exitCode: 0 })
    expect(defaultTask.stdout.trim()).toBe(expected)
    expect(defaultTask.stdout).not.toContain('\uFFFD')

    if (process.platform === 'win32') {
      const powershell = await shells.run({ projectId: project.id, shell: 'powershell', command: `Write-Output '${expected}'` })
      expect(powershell.stdout.trim()).toBe(expected)
      expect(powershell.stdout).not.toContain('\uFFFD')
      const cmd = await shells.run({ projectId: project.id, shell: 'cmd', command: `echo ${expected}` })
      expect(cmd.stdout.trim()).toBe(expected)
      expect(cmd.stdout).not.toContain('\uFFFD')
    } else {
      const bash = await shells.run({ projectId: project.id, shell: 'bash', command: `printf '${expected}'` })
      expect(bash.stdout).toBe(expected)
      expect(bash.stdout).not.toContain('\uFFFD')
    }
  })
})