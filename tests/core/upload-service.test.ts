import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '../../src/core/config-store'
import { FileService } from '../../src/core/file-service'
import { ProjectService } from '../../src/core/project-service'
import { UploadService } from '../../src/core/upload-service'
import type { Project } from '../../src/shared/types'

let temporaryDirectory: string
let project: Project
let uploads: UploadService

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'web-codex-uploads-'))
  const store = new ConfigStore(join(temporaryDirectory, 'config.json'))
  await store.load()
  const projects = new ProjectService(store)
  project = await projects.create({ path: join(temporaryDirectory, 'workspace') })
  uploads = new UploadService(join(temporaryDirectory, 'inbox'), new FileService(projects))
  await uploads.initialize()
})

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true })
})

describe('UploadService attachment inbox', () => {
  it('copies a real binary attachment into a project without base64', async () => {
    const content = Buffer.from([0, 255, 1, 2, 3, 254])
    const source = join(temporaryDirectory, 'bracket.stl')
    await writeFile(source, content)

    const [item] = await uploads.add([source])
    expect(item).toMatchObject({ originalName: 'bracket.stl', size: content.length, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(await uploads.list()).toEqual([item])

    const copied = await uploads.copyToProject(item.id, project.id, 'models')
    expect(copied).toMatchObject({ path: 'models/bracket.stl', bytes: content.length, sha256: item.sha256 })
    expect(await readFile(join(project.path, 'models', 'bracket.stl'))).toEqual(content)

    await uploads.remove(item.id)
    expect(await uploads.list()).toEqual([])
    await expect(uploads.copyToProject(item.id, project.id, 'models')).rejects.toMatchObject({ code: 'UPLOAD_NOT_FOUND' })
  })

  it('extracts an uploaded ZIP with KiCad and STEP files', async () => {
    const zip = new AdmZip()
    zip.addFile('project/stand.step', Buffer.from('STEP DATA'))
    zip.addFile('project/board.kicad_pcb', Buffer.from('(kicad_pcb)'))
    const source = join(temporaryDirectory, 'bundle.zip')
    await writeFile(source, zip.toBuffer())
    const [item] = await uploads.add([source])

    const extracted = await uploads.extractToProject(item.id, project.id, 'imported')
    expect(extracted).toMatchObject({ files: 2, path: 'imported' })
    expect(await readFile(join(project.path, 'imported', 'project', 'stand.step'), 'utf8')).toBe('STEP DATA')
    expect(await readFile(join(project.path, 'imported', 'project', 'board.kicad_pcb'), 'utf8')).toBe('(kicad_pcb)')
  })

  it('validates IDs, ZIP types, and file selection', async () => {
    await expect(uploads.add([])).rejects.toMatchObject({ code: 'UPLOAD_COUNT_INVALID' })
    await expect(uploads.copyToProject('../escape', project.id, '.')).rejects.toMatchObject({ code: 'UPLOAD_NOT_FOUND' })

    const source = join(temporaryDirectory, 'notes.txt')
    await writeFile(source, 'text')
    const [item] = await uploads.add([source])
    await expect(uploads.extractToProject(item.id, project.id, '.')).rejects.toMatchObject({ code: 'UPLOAD_NOT_ZIP' })
  })
})