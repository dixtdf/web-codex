import { randomUUID, createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { basename, join } from 'node:path'
import type { UploadItem } from '../shared/types'
import { AppError, assertCondition } from './errors'
import { FileService } from './file-service'
import type { ActivityLogger } from './activity-logger'

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export class UploadService {
  constructor(public readonly directory: string, private readonly files: FileService, private readonly logger?: ActivityLogger) {}

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
  }

  async list(): Promise<UploadItem[]> {
    const entries = await readdir(this.directory, { withFileTypes: true })
    const items: UploadItem[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/i.test(entry.name)) continue
      try {
        const item = JSON.parse(await readFile(join(this.directory, entry.name, 'metadata.json'), 'utf8')) as UploadItem
        const info = await stat(join(this.directory, entry.name, item.originalName))
        if (info.isFile() && info.size === item.size) items.push(item)
      } catch {
        continue
      }
    }
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async add(sourcePaths: string[]): Promise<UploadItem[]> {
    assertCondition(sourcePaths.length > 0 && sourcePaths.length <= 20, 'Select between 1 and 20 files', 'UPLOAD_COUNT_INVALID')
    const added: UploadItem[] = []
    const createdDirectories: string[] = []
    try {
      for (const sourcePath of sourcePaths) {
        const info = await stat(sourcePath)
        assertCondition(info.isFile(), 'Only regular files can be uploaded', 'UPLOAD_NOT_FILE')
        assertCondition(info.size <= 200_000_000, 'Each upload must be 200 MB or smaller', 'UPLOAD_LIMIT_EXCEEDED')
        const originalName = basename(sourcePath).replace(/[\x00-\x1f]/g, '_') || 'upload.bin'
        const id = randomUUID()
        const directory = join(this.directory, id)
        await mkdir(directory, { recursive: true })
        createdDirectories.push(directory)
        const destination = join(directory, originalName)
        await copyFile(sourcePath, destination)
        const item: UploadItem = { id, originalName, size: info.size, createdAt: new Date().toISOString(), sha256: await hashFile(destination) }
        await writeFile(join(directory, 'metadata.json'), JSON.stringify(item, null, 2), { mode: 0o600 })
        added.push(item)
      }
    } catch (error) {
      await Promise.allSettled(createdDirectories.map((directory) => rm(directory, { recursive: true, force: true })))
      throw error
    }
    for (const item of added) {
      this.logger?.info({ category: 'file', action: 'upload.added', message: `Attachment uploaded: ${item.originalName}`, data: { uploadId: item.id, originalName: item.originalName, size: item.size, sha256: item.sha256 } })
    }
    return added
  }

  async remove(id: string): Promise<void> {
    const item = await this.get(id)
    await rm(join(this.directory, item.id), { recursive: true, force: false })
    this.logger?.info({ category: 'file', action: 'upload.removed', message: `Attachment removed: ${item.originalName}`, data: { uploadId: id, originalName: item.originalName } })
  }

  async copyToProject(id: string, projectId: string, destinationPath: string, onConflict: 'fail' | 'overwrite' | 'rename' = 'fail'): Promise<{ path: string; bytes: number; sha256: string; conflict: 'none' | 'overwritten' | 'renamed' }> {
    const item = await this.get(id)
    const result = await this.files.copyBinary(projectId, join(this.directory, id, item.originalName), destinationPath, onConflict)
    this.logger?.info({ category: 'file', action: 'upload.copied', message: `Attachment copied to project: ${item.originalName}`, projectId, data: { uploadId: id, originalName: item.originalName, destination: result.path, sha256: result.sha256, conflict: result.conflict } })
    return result
  }

  async extractToProject(id: string, projectId: string, destinationPath: string): Promise<{ path: string; files: number; bytes: number }> {
    const item = await this.get(id)
    assertCondition(/\.zip$/i.test(item.originalName), 'Only ZIP uploads can be extracted', 'UPLOAD_NOT_ZIP')
    const result = await this.files.extractArchiveFile(projectId, join(this.directory, id, item.originalName), destinationPath)
    this.logger?.info({ category: 'file', action: 'upload.extracted', message: `Attachment extracted to project: ${item.originalName}`, projectId, data: { uploadId: id, originalName: item.originalName, destination: result.path, files: result.files, bytes: result.bytes } })
    return result
  }

  private async get(id: string): Promise<UploadItem> {
    assertCondition(/^[a-f0-9-]{36}$/i.test(id), 'Invalid upload ID', 'UPLOAD_NOT_FOUND')
    try {
      const item = JSON.parse(await readFile(join(this.directory, id, 'metadata.json'), 'utf8')) as UploadItem
      assertCondition(item.id === id && basename(item.originalName) === item.originalName && item.size >= 0, 'Invalid upload metadata', 'UPLOAD_NOT_FOUND')
      await stat(join(this.directory, id, item.originalName))
      return item
    } catch {
      throw new AppError(`Upload not found: ${id}`, 'UPLOAD_NOT_FOUND')
    }
  }
}