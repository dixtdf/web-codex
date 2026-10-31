import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '../../src/core/config-store'
import { FileService } from '../../src/core/file-service'
import { ProjectService } from '../../src/core/project-service'
import type { Project } from '../../src/shared/types'

let temporaryDirectory: string
let projectRoot: string
let project: Project
let projects: ProjectService
let files: FileService

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'web-codex-files-'))
  projectRoot = join(temporaryDirectory, 'workspace')
  await mkdir(projectRoot)
  const store = new ConfigStore(join(temporaryDirectory, 'config.json'))
  await store.load()
  projects = new ProjectService(store)
  project = await projects.create({ path: projectRoot })
  files = new FileService(projects)
})

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true })
})

describe('FileService project boundaries', () => {
  it('rejects disabled projects and paths outside the canonical root', async () => {
    await projects.update(project.id, { enabled: false })
    await expect(files.list(project.id)).rejects.toMatchObject({ code: 'PROJECT_DISABLED' })

    await projects.update(project.id, { enabled: true })
    await expect(files.read(project.id, '../outside.txt')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' })
    await expect(files.write(project.id, '../outside.txt', 'blocked')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' })
  })

  it('rejects symbolic links whose targets leave the project', async () => {
    const outside = join(temporaryDirectory, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(outside, join(projectRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(files.read(project.id, 'linked/secret.txt')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' })
    await expect(files.write(project.id, 'linked/new.txt', 'blocked')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' })
  })

  it('does not allow moving or deleting the project root', async () => {
    await expect(files.move(project.id, '.', 'copy')).rejects.toMatchObject({ code: 'PROJECT_ROOT_OPERATION' })
    await expect(files.remove(project.id, '.')).rejects.toMatchObject({ code: 'PROJECT_ROOT_OPERATION' })
  })
})

describe('FileService reads and writes', () => {
  it('creates parent folders, writes UTF-8, and lists files with stable metadata', async () => {
    await expect(files.write(project.id, 'docs/nested/hello.txt', '你好，Codex')).resolves.toEqual({
      path: 'docs/nested/hello.txt',
      bytes: Buffer.byteLength('你好，Codex')
    })
    await files.createDirectory(project.id, 'empty')

    const entries = await files.list(project.id)
    expect(entries.map((entry) => [entry.name, entry.type])).toEqual([
      ['docs', 'directory'],
      ['empty', 'directory']
    ])
    const nested = await files.list(project.id, 'docs/nested')
    expect(nested[0]).toMatchObject({ name: 'hello.txt', path: 'docs/nested/hello.txt', type: 'file', size: Buffer.byteLength('你好，Codex') })
    expect(Number.isNaN(Date.parse(nested[0].modifiedAt))).toBe(false)
  })

  it('reads bounded chunks using byte offsets and reports truncation accurately', async () => {
    await files.write(project.id, 'large.txt', 'abcdef')

    await expect(files.read(project.id, 'large.txt', 3, 1)).resolves.toEqual({
      path: 'large.txt',
      content: 'bcd',
      size: 6,
      truncated: true
    })
    await expect(files.read(project.id, 'large.txt', 10, 4)).resolves.toEqual({
      path: 'large.txt',
      content: 'ef',
      size: 6,
      truncated: false
    })
    await expect(files.read(project.id, 'large.txt', 10, 20)).resolves.toMatchObject({ content: '', truncated: false })
  })

  it('rejects directories and binary content when reading text', async () => {
    await files.createDirectory(project.id, 'folder')
    await expect(files.read(project.id, 'folder')).rejects.toMatchObject({ code: 'FILE_NOT_FILE' })

    await writeFile(join(projectRoot, 'binary.dat'), Buffer.from([0, 1, 2]))
    await expect(files.read(project.id, 'binary.dat')).rejects.toMatchObject({ code: 'FILE_BINARY' })
  })

  it('patches exact text and enforces the expected replacement count', async () => {
    await files.write(project.id, 'patch.txt', 'alpha beta alpha')

    await expect(files.patch(project.id, 'patch.txt', 'beta', 'gamma')).resolves.toEqual({ path: 'patch.txt', replacements: 1 })
    expect(await readFile(join(projectRoot, 'patch.txt'), 'utf8')).toBe('alpha gamma alpha')
    await expect(files.patch(project.id, 'patch.txt', 'alpha', 'x', 2)).resolves.toEqual({ path: 'patch.txt', replacements: 2 })
    await expect(files.patch(project.id, 'patch.txt', 'missing', 'x')).rejects.toMatchObject({ code: 'PATCH_MATCH_MISMATCH' })
    await expect(files.patch(project.id, 'patch.txt', '', 'x')).rejects.toMatchObject({ code: 'PATCH_EMPTY_SOURCE' })
  })

  it('moves and removes files without changing content', async () => {
    await files.write(project.id, 'source.txt', 'payload')
    await expect(files.move(project.id, 'source.txt', 'archive/renamed.txt')).resolves.toEqual({ path: 'archive/renamed.txt' })
    await expect(files.read(project.id, 'archive/renamed.txt')).resolves.toMatchObject({ content: 'payload' })

    await files.remove(project.id, 'archive/renamed.txt')
    await expect(files.read(project.id, 'archive/renamed.txt')).rejects.toMatchObject({ code: 'ENOENT' })
    await files.remove(project.id, 'archive', true)
    expect(await files.list(project.id)).toEqual([])
  })
})

describe('FileService search', () => {
  it('searches recursively with literal, regex, case, and result-limit options', async () => {
    await files.write(project.id, 'src/a.txt', 'Alpha beta\nsecond Alpha')
    await files.write(project.id, 'src/b.md', 'alpha only')
    await files.write(project.id, 'node_modules/ignored.txt', 'Alpha')
    await writeFile(join(projectRoot, 'src', 'image.png'), Buffer.from([0, 1]))

    expect(await files.search(project.id, 'alpha')).toEqual([
      { path: 'src/a.txt', line: 1, column: 1, preview: 'Alpha beta' },
      { path: 'src/a.txt', line: 2, column: 8, preview: 'second Alpha' },
      { path: 'src/b.md', line: 1, column: 1, preview: 'alpha only' }
    ])
    expect(await files.search(project.id, 'alpha', { caseSensitive: true })).toEqual([
      { path: 'src/b.md', line: 1, column: 1, preview: 'alpha only' }
    ])
    expect(await files.search(project.id, 'A[a-z]+a', { regex: true, maxResults: 1 })).toHaveLength(1)
    expect(await files.search(project.id, 'second', { path: 'src/a.txt' })).toEqual([
      { path: 'src/a.txt', line: 2, column: 1, preview: 'second Alpha' }
    ])
  })

  it('skips binary and oversized files and validates search input', async () => {
    await files.write(project.id, 'small.txt', 'needle')
    await writeFile(join(projectRoot, 'large.txt'), `needle${'x'.repeat(1_000_001)}`)
    await writeFile(join(projectRoot, 'nul.txt'), Buffer.from('needle\0hidden'))

    expect(await files.search(project.id, 'needle')).toEqual([
      { path: 'small.txt', line: 1, column: 1, preview: 'needle' }
    ])
    await expect(files.search(project.id, '')).rejects.toMatchObject({ code: 'SEARCH_QUERY_REQUIRED' })
    await expect(files.search(project.id, '[', { regex: true })).rejects.toThrow(SyntaxError)
  })
})