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
    await expect(files.write(project.id, 'docs/nested/hello.txt', '你好，Codex')).resolves.toMatchObject({
      path: 'docs/nested/hello.txt',
      bytes: Buffer.byteLength('你好，Codex'),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
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

    await expect(files.read(project.id, 'large.txt', 3, 1)).resolves.toMatchObject({
      path: 'large.txt',
      content: 'bcd',
      size: 6,
      truncated: true,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    await expect(files.read(project.id, 'large.txt', 10, 4)).resolves.toMatchObject({
      path: 'large.txt',
      content: 'ef',
      size: 6,
      truncated: false,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
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

    await expect(files.patch(project.id, 'patch.txt', 'beta', 'gamma')).resolves.toMatchObject({ path: 'patch.txt', replacements: 1, changed: true, dryRun: false, beforeSha256: expect.stringMatching(/^[a-f0-9]{64}$/), afterSha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(await readFile(join(projectRoot, 'patch.txt'), 'utf8')).toBe('alpha gamma alpha')
    await expect(files.patch(project.id, 'patch.txt', 'alpha', 'x', 2)).resolves.toMatchObject({ path: 'patch.txt', replacements: 2, changed: true, dryRun: false })
    await expect(files.patch(project.id, 'patch.txt', 'missing', 'x')).rejects.toMatchObject({ code: 'PATCH_MATCH_MISMATCH' })
    await expect(files.patch(project.id, 'patch.txt', '', 'x')).rejects.toMatchObject({ code: 'PATCH_EMPTY_SOURCE' })
  })

  it('moves and removes files without changing content', async () => {
    await files.write(project.id, 'source.txt', 'payload')
    await expect(files.move(project.id, 'source.txt', 'archive/renamed.txt')).resolves.toMatchObject({ path: 'archive/renamed.txt', overwritten: false, beforeSha256: null })
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

    expect((await files.search(project.id, 'alpha')).matches).toEqual([
      { path: 'src/a.txt', line: 1, column: 1, preview: 'Alpha beta' },
      { path: 'src/a.txt', line: 2, column: 8, preview: 'second Alpha' },
      { path: 'src/b.md', line: 1, column: 1, preview: 'alpha only' }
    ])
    expect((await files.search(project.id, 'alpha', { caseSensitive: true })).matches).toEqual([
      { path: 'src/b.md', line: 1, column: 1, preview: 'alpha only' }
    ])
    const limited = await files.search(project.id, 'A[a-z]+a', { regex: true, maxResults: 1 })
    expect(limited.matches).toHaveLength(1)
    expect(limited.nextCursor).toBe('1')
    expect((await files.search(project.id, 'second', { path: 'src/a.txt' })).matches).toEqual([
      { path: 'src/a.txt', line: 2, column: 1, preview: 'second Alpha' }
    ])
  })

  it('paginates stable search results and rejects invalid cursors', async () => {
    await files.write(project.id, 'a.txt', 'needle')
    await files.write(project.id, 'b.txt', 'needle')
    await files.write(project.id, 'c.txt', 'needle')

    const first = await files.search(project.id, 'needle', { maxResults: 1 })
    expect(first).toEqual({ matches: [{ path: 'a.txt', line: 1, column: 1, preview: 'needle' }], nextCursor: '1' })
    const second = await files.search(project.id, 'needle', { maxResults: 1, cursor: first.nextCursor as string })
    expect(second).toEqual({ matches: [{ path: 'b.txt', line: 1, column: 1, preview: 'needle' }], nextCursor: '2' })
    const third = await files.search(project.id, 'needle', { maxResults: 1, cursor: second.nextCursor as string })
    expect(third).toEqual({ matches: [{ path: 'c.txt', line: 1, column: 1, preview: 'needle' }], nextCursor: null })
    await expect(files.search(project.id, 'needle', { cursor: 'invalid' })).rejects.toMatchObject({ code: 'SEARCH_CURSOR_INVALID' })
  })

  it('filters searches with include and exclude globs', async () => {
    await files.write(project.id, 'src/keep.ts', 'needle')
    await files.write(project.id, 'src/keep.test.ts', 'needle')
    await files.write(project.id, 'src/skip.js', 'needle')
    await files.write(project.id, 'docs/skip.md', 'needle')
    await files.write(project.id, 'src/generated/skip.ts', 'needle')

    const included = await files.search(project.id, 'needle', { includeGlobs: ['src/**/*.ts'] })
    expect(included.matches.map((match) => match.path)).toHaveLength(3)
    expect(included.matches.map((match) => match.path)).toEqual(expect.arrayContaining(['src/keep.ts', 'src/keep.test.ts', 'src/generated/skip.ts']))
    const excluded = await files.search(project.id, 'needle', { includeGlobs: ['src/**/*.ts'], excludeGlobs: ['**/*.test.ts', 'src/generated/'] })
    expect(excluded).toEqual({ matches: [{ path: 'src/keep.ts', line: 1, column: 1, preview: 'needle' }], nextCursor: null })
    await expect(files.search(project.id, 'needle', { includeGlobs: [''] })).rejects.toMatchObject({ code: 'SEARCH_GLOB_INVALID' })
  })

  it('skips binary and oversized files and validates search input', async () => {
    await files.write(project.id, 'small.txt', 'needle')
    await writeFile(join(projectRoot, 'large.txt'), `needle${'x'.repeat(1_000_001)}`)
    await writeFile(join(projectRoot, 'nul.txt'), Buffer.from('needle\0hidden'))

    expect((await files.search(project.id, 'needle')).matches).toEqual([
      { path: 'small.txt', line: 1, column: 1, preview: 'needle' }
    ])
    await expect(files.search(project.id, '')).rejects.toMatchObject({ code: 'SEARCH_QUERY_REQUIRED' })
    await expect(files.search(project.id, '[', { regex: true })).rejects.toThrow(SyntaxError)
  })
})