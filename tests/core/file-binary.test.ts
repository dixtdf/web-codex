import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '../../src/core/config-store'
import { FileService } from '../../src/core/file-service'
import { ProjectService } from '../../src/core/project-service'
import type { Project } from '../../src/shared/types'

let temporaryDirectory: string
let project: Project
let files: FileService

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'web-codex-binary-'))
  const store = new ConfigStore(join(temporaryDirectory, 'config.json'))
  await store.load()
  const projects = new ProjectService(store)
  project = await projects.create({ path: join(temporaryDirectory, 'workspace') })
  files = new FileService(projects)
})

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true })
})

describe('FileService binary transfer', () => {
  it('writes and reads binary chunks with offsets and a stable SHA-256', async () => {
    const first = Buffer.from([0, 255, 1, 2, 3, 254])
    const second = Buffer.from([10, 11, 12, 13])
    const initial = await files.writeBinary(project.id, 'models/bracket.stl', first.toString('base64'))
    expect(initial).toMatchObject({ bytes: 6, size: 6 })

    const appended = await files.writeBinary(project.id, 'models/bracket.stl', second.toString('base64'), { offset: first.length })
    expect(appended.size).toBe(10)
    expect(appended.sha256).toBe(createHash('sha256').update(Buffer.concat([first, second])).digest('hex'))

    const chunk = await files.readBinary(project.id, 'models/bracket.stl', 2, 4)
    expect(chunk.base64).toBe(Buffer.from([1, 2, 3, 254]).toString('base64'))
    expect(chunk).toMatchObject({ offset: 2, nextOffset: 6, size: 10, truncated: true, sha256: appended.sha256 })
    const final = await files.readBinary(project.id, 'models/bracket.stl', chunk.nextOffset, 4)
    expect(final.base64).toBe(second.toString('base64'))
    expect(final).toMatchObject({ nextOffset: 10, truncated: false })
  })

  it('rejects invalid base64, non-sequential chunks, and hash mismatches', async () => {
    await expect(files.writeBinary(project.id, 'bad.bin', 'not-base64')).rejects.toMatchObject({ code: 'FILE_BASE64_INVALID' })
    await files.writeBinary(project.id, 'bad.bin', Buffer.from('abc').toString('base64'))
    await expect(files.writeBinary(project.id, 'bad.bin', Buffer.from('z').toString('base64'), { offset: 99 })).rejects.toMatchObject({ code: 'FILE_OFFSET_MISMATCH' })
    await expect(files.writeBinary(project.id, 'bad.bin', Buffer.from('abc').toString('base64'), { expectedSha256: '0'.repeat(64) })).rejects.toMatchObject({ code: 'FILE_HASH_MISMATCH' })
    await expect(files.readBinary(project.id, 'bad.bin', 99)).rejects.toMatchObject({ code: 'FILE_OFFSET_INVALID' })
  })
})

describe('FileService ZIP transfer', () => {
  it('round-trips STEP, STL, and KiCad files with binary content intact', async () => {
    const stl = Buffer.from([0, 1, 2, 250, 251, 252])
    await mkdir(join(project.path, 'cad', 'board'), { recursive: true })
    await writeFile(join(project.path, 'cad', 'stand.step'), 'ISO-10303-21; STEP;')
    await writeFile(join(project.path, 'cad', 'bracket.stl'), stl)
    await writeFile(join(project.path, 'cad', 'board', 'controller.kicad_pcb'), '(kicad_pcb (version 20240108))')

    const archive = await files.createArchive(project.id, 'cad', 'cad-bundle.zip')
    expect(archive).toMatchObject({ files: 3, size: expect.any(Number) })
    const extracted = await files.extractArchive(project.id, 'cad-bundle.zip', 'imported')
    expect(extracted).toMatchObject({ files: 3, path: 'imported' })
    expect(await readFile(join(project.path, 'imported', 'stand.step'), 'utf8')).toBe('ISO-10303-21; STEP;')
    expect(await readFile(join(project.path, 'imported', 'bracket.stl'))).toEqual(stl)
    expect(await readFile(join(project.path, 'imported', 'board', 'controller.kicad_pcb'), 'utf8')).toContain('kicad_pcb')
  })

  it('stores a single source file at the ZIP root', async () => {
    await writeFile(join(project.path, 'single.step'), 'single-file')
    await files.createArchive(project.id, 'single.step', 'single.zip')
    const zip = new AdmZip(join(project.path, 'single.zip'))
    expect(zip.getEntries().map((entry) => entry.entryName)).toEqual(['single.step'])
  })

  it('rejects Zip Slip entries without writing outside the destination', async () => {
    const zip = new AdmZip()
    zip.addFile('xx/escape.txt', Buffer.from('blocked'))
    const malicious = Buffer.from(zip.toBuffer().toString('latin1').replaceAll('xx/escape.txt', '../escape.txt'), 'latin1')
    await writeFile(join(project.path, 'malicious.zip'), malicious)

    await expect(files.extractArchive(project.id, 'malicious.zip', 'safe')).rejects.toMatchObject({ code: 'ARCHIVE_PATH_OUTSIDE_PROJECT' })
    await expect(readFile(join(project.path, 'escape.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})