import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '../../src/core/config-store'
import { FileService } from '../../src/core/file-service'
import { ProjectService } from '../../src/core/project-service'
import type { Project } from '../../src/shared/types'

let temporaryDirectory: string
let project: Project
let projects: ProjectService
let files: FileService

function sha(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'web-codex-file-advanced-'))
  const store = new ConfigStore(join(temporaryDirectory, 'config.json'))
  await store.load()
  projects = new ProjectService(store)
  project = await projects.create({ path: join(temporaryDirectory, 'workspace') })
  files = new FileService(projects, { trashDirectory: join(temporaryDirectory, 'trash') })
})

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true })
})

describe('FileService version-aware writes and patches', () => {
  it('detects stale writes and supports hash-verified replacement and dry-run patches', async () => {
    const first = await files.write(project.id, 'versioned.txt', 'one')
    expect(first.sha256).toBe(sha('one'))
    await expect(files.write(project.id, 'versioned.txt', 'two', { expectedSha256: '0'.repeat(64) })).rejects.toMatchObject({ code: 'FILE_VERSION_CONFLICT' })

    const second = await files.write(project.id, 'versioned.txt', 'two', { expectedSha256: first.sha256 })
    expect(second.sha256).toBe(sha('two'))
    const dryRun = await files.patch(project.id, 'versioned.txt', 'two', 'three', 1, { expectedSha256: second.sha256, dryRun: true })
    expect(dryRun).toMatchObject({ changed: true, dryRun: true, beforeSha256: sha('two'), afterSha256: sha('three') })
    expect(await readFile(join(project.path, 'versioned.txt'), 'utf8')).toBe('two')
    await expect(files.patch(project.id, 'versioned.txt', 'two', 'three', 1, { expectedSha256: second.sha256 })).resolves.toMatchObject({ changed: true, dryRun: false })
    expect(await files.hash(project.id, 'versioned.txt')).toMatchObject({ size: 5, sha256: sha('three') })
  })

  it('returns bounded file, directory, and symlink attributes', async () => {
    await files.write(project.id, 'attributes.txt', 'attributes')
    const file = await files.attributes(project.id, 'attributes.txt')
    expect(file).toMatchObject({ path: 'attributes.txt', type: 'file', size: 10, readable: true, mode: expect.stringMatching(/^[0-7]{3}$/) })
    expect(Number.isNaN(Date.parse(file.mtime))).toBe(false)

    await files.createDirectory(project.id, 'attribute-folder')
    expect(await files.attributes(project.id, 'attribute-folder')).toMatchObject({ type: 'directory', path: 'attribute-folder' })

    await files.createDirectory(project.id, 'attribute-target')
    await symlink(join(project.path, 'attribute-target'), join(project.path, 'attributes-link'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await files.attributes(project.id, 'attributes-link')).toMatchObject({ type: 'symlink', path: 'attributes-link' })
    await expect(files.attributes(project.id, '../outside')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' })
  })

  it('copies files and directories while preventing same-path copies', async () => {
    await files.write(project.id, 'source.txt', 'payload')
    const copied = await files.copy(project.id, 'source.txt', 'copied.txt')
    expect(copied).toMatchObject({ path: 'copied.txt', bytes: 7, sha256: sha('payload') })
    await expect(files.copy(project.id, 'source.txt', 'source.txt')).rejects.toMatchObject({ code: 'FILE_COPY_SAME_PATH' })

    await files.write(project.id, 'folder/a.txt', 'a')
    await files.write(project.id, 'folder/nested/b.txt', 'b')
    await expect(files.copy(project.id, 'folder', 'folder-copy')).resolves.toMatchObject({ path: 'folder-copy', bytes: 0, sha256: null })
    expect(await readFile(join(project.path, 'folder-copy', 'nested', 'b.txt'), 'utf8')).toBe('b')
  })
})

describe('FileService deletion planning and trash recovery', () => {
  it('plans deletion impact and restores deleted files from the recoverable trash', async () => {
    await files.write(project.id, 'models/part.step', 'step-content')
    const plan = await files.deletePlan(project.id, 'models')
    expect(plan).toMatchObject({ path: 'models', type: 'directory', files: 1, directories: 1, bytes: 12 })
    expect(plan.samplePaths).toEqual(expect.arrayContaining(['models', 'models/part.step']))

    await expect(files.remove(project.id, 'models')).rejects.toMatchObject({ code: 'DIRECTORY_NOT_EMPTY' })
    const removed = await files.remove(project.id, 'models', true)
    expect(removed).toMatchObject({ type: 'directory', recoverable: true, trashId: expect.any(String) })
    await expect(readFile(join(project.path, 'models', 'part.step'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    expect(await files.trashList()).toEqual([expect.objectContaining({ id: removed.trashId, originalPath: 'models', reason: 'deleted' })])
    await expect(files.restoreTrash(removed.trashId as string)).resolves.toMatchObject({ path: 'models', type: 'directory' })
    expect(await readFile(join(project.path, 'models', 'part.step'), 'utf8')).toBe('step-content')
    expect(await files.trashList()).toEqual([])
  })

  it('previews deletion and rejects stale hashes without modifying the file', async () => {
    const original = await files.write(project.id, 'protected.txt', 'OLD')
    const current = await files.write(project.id, 'protected.txt', 'NEW')

    await expect(files.remove(project.id, 'protected.txt', false, { expectedSha256: original.sha256 })).rejects.toMatchObject({ code: 'FILE_VERSION_CONFLICT' })
    expect(await readFile(join(project.path, 'protected.txt'), 'utf8')).toBe('NEW')
    await expect(files.remove(project.id, 'protected.txt', false, { expectedSha256: current.sha256, dryRun: true })).resolves.toMatchObject({
      path: 'protected.txt', dryRun: true, recoverable: true, trashId: null, sha256: current.sha256
    })
    expect(await readFile(join(project.path, 'protected.txt'), 'utf8')).toBe('NEW')
    expect(await files.trashList()).toEqual([])

    await expect(files.remove(project.id, 'protected.txt', false, { expectedSha256: current.sha256 })).resolves.toMatchObject({ dryRun: false, trashId: expect.any(String) })
    await expect(readFile(join(project.path, 'protected.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('backs up without deleting and requires explicit overwrite on restore conflict', async () => {
    await files.write(project.id, 'important.txt', 'original')
    const backup = await files.backup(project.id, 'important.txt')
    expect(backup).toMatchObject({ originalPath: 'important.txt', reason: 'backup' })
    expect(await readFile(join(project.path, 'important.txt'), 'utf8')).toBe('original')

    await files.write(project.id, 'important.txt', 'modified')
    await expect(files.restoreTrash(backup.id)).rejects.toMatchObject({ code: 'TRASH_DESTINATION_CONFLICT' })
    await expect(files.restoreTrash(backup.id, true)).resolves.toMatchObject({ path: 'important.txt' })
    expect(await readFile(join(project.path, 'important.txt'), 'utf8')).toBe('original')
    await expect(files.restoreTrash('not-a-trash-id')).rejects.toMatchObject({ code: 'TRASH_NOT_FOUND' })
  })

  it('keeps permanent deletion behavior and explicit trash-unavailable errors when unconfigured', async () => {
    const permanent = new FileService(projects)
    await permanent.write(project.id, 'temporary.txt', 'temporary')
    await expect(permanent.backup(project.id, 'temporary.txt')).rejects.toMatchObject({ code: 'TRASH_UNAVAILABLE' })
    await expect(permanent.remove(project.id, 'temporary.txt')).resolves.toMatchObject({ recoverable: false, trashId: null })
    await expect(permanent.trashList()).resolves.toEqual([])
  })
})