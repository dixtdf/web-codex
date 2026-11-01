import { copyFile, cp, mkdir, lstat, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import AdmZip from 'adm-zip'
import ignore from 'ignore'
import type { FileEntry } from '../shared/types'
import { AppError, assertCondition } from './errors'
import { ProjectService } from './project-service'

export interface FileReadResult {
  path: string
  content: string
  offset: number
  actualOffset: number
  requestedOffset: number
  nextOffset: number
  bytes: number
  size: number
  truncated: boolean
  sha256: string
}

export interface FileHashResult {
  path: string
  size: number
  modifiedAt: string
  sha256: string
}

export interface FileDeletePlan {
  path: string
  type: 'file' | 'directory' | 'symlink'
  files: number
  directories: number
  bytes: number
  samplePaths: string[]
}

export interface TrashRecord {
  id: string
  projectId: string
  originalPath: string
  deletedAt: string
  type: 'file' | 'directory' | 'symlink'
  bytes: number
  reason: 'deleted' | 'backup'
}

interface FileServiceOptions {
  trashDirectory?: string
}

export interface SearchMatch {
  path: string
  line: number
  column: number
  preview: string
}

const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'out', 'release', 'release-local', 'coverage', '.next', '.turbo', '.venv', 'venv', '__pycache__', 'build', 'target', '.tox', '.mypy_cache', '.pytest_cache', '.gradle', '.idea'])
const binaryExtensions = new Set(['.exe', '.dll', '.so', '.dylib', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.gz', '.7z', '.mp3', '.mp4', '.woff', '.woff2'])
const maxArchiveBytes = 200_000_000

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function atomicWrite(target: string, data: string | Buffer): Promise<void> {
  const temporary = join(dirname(target), `.${randomUUID()}.web-codex.tmp`)
  try {
    let mode = 0o644
    try {
      mode = (await stat(target)).mode & 0o777
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await writeFile(temporary, data, { mode })
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

function throwUnlessMoveOverwrite(overwrite: boolean | undefined, regularFiles: boolean): void {
  if (!overwrite) throw new AppError('Destination already exists; set overwrite=true with a destination hash to replace it', 'FILE_ALREADY_EXISTS')
  assertCondition(regularFiles, 'Only regular files can be overwritten by a move', 'FILE_OVERWRITE_UNSUPPORTED')
}

function decodeBase64(value: string): Buffer {
  const normalized = value.replace(/\s/g, '')
  assertCondition(normalized.length > 0 && normalized.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(normalized), 'Invalid base64 content', 'FILE_BASE64_INVALID')
  const buffer = Buffer.from(normalized, 'base64')
  assertCondition(buffer.length > 0 && buffer.length <= 4_000_000 && buffer.toString('base64') === normalized, 'Invalid base64 content or chunk exceeds 4 MB', 'FILE_BASE64_INVALID')
  return buffer
}

function inside(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target)
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))
}

export class FileService {
  private readonly trashDirectory?: string

  constructor(private readonly projects: ProjectService, options: FileServiceOptions = {}) {
    this.trashDirectory = options.trashDirectory
  }

  private async existingPath(projectId: string, requestedPath = '.'): Promise<{ root: string; target: string }> {
    const root = await this.projects.root(projectId)
    const candidate = resolve(root, requestedPath)
    assertCondition(inside(root, candidate), 'Path leaves the project folder', 'PATH_OUTSIDE_PROJECT')
    const target = await realpath(candidate)
    assertCondition(inside(root, target), 'Symbolic link leaves the project folder', 'PATH_OUTSIDE_PROJECT')
    return { root, target }
  }

  private async writablePath(projectId: string, requestedPath: string): Promise<{ root: string; target: string }> {
    const root = await this.projects.root(projectId)
    const target = resolve(root, requestedPath)
    assertCondition(inside(root, target) && target !== root, 'Invalid path inside the project folder', 'PATH_OUTSIDE_PROJECT')
    let ancestor = dirname(target)
    while (true) {
      try {
        const canonicalAncestor = await realpath(ancestor)
        assertCondition(inside(root, canonicalAncestor), 'Parent folder leaves the project folder', 'PATH_OUTSIDE_PROJECT')
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
        const parent = dirname(ancestor)
        if (parent === ancestor) {
          throw error
        }
        ancestor = parent
      }
    }
    await mkdir(dirname(target), { recursive: true })
    const parent = await realpath(dirname(target))
    assertCondition(inside(root, parent), 'Parent folder leaves the project folder', 'PATH_OUTSIDE_PROJECT')
    try {
      const existing = await realpath(target)
      assertCondition(inside(root, existing), 'Symbolic link leaves the project folder', 'PATH_OUTSIDE_PROJECT')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
    return { root, target }
  }

  async list(projectId: string, requestedPath = '.'): Promise<FileEntry[]> {
    const { root, target } = await this.existingPath(projectId, requestedPath)
    const entries = await readdir(target, { withFileTypes: true })
    const result = await Promise.all(entries.map(async (entry): Promise<FileEntry> => {
      const absolute = join(target, entry.name)
      const info = await lstat(absolute)
      return {
        name: entry.name,
        path: relative(root, absolute).split(sep).join('/'),
        type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file',
        size: info.size,
        modifiedAt: info.mtime.toISOString()
      }
    }))
    return result.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1)
  }

  async read(projectId: string, requestedPath: string, maxBytes = 200_000, offset = 0): Promise<FileReadResult> {
    const { root, target } = await this.existingPath(projectId, requestedPath)
    const info = await stat(target)
    assertCondition(info.isFile(), 'Path is not a file', 'FILE_NOT_FILE')
    assertCondition(Number.isSafeInteger(offset) && offset >= 0, 'Invalid text read offset', 'FILE_OFFSET_INVALID')
    assertCondition(Number.isSafeInteger(maxBytes) && maxBytes > 0, 'maxBytes must be positive', 'FILE_LIMIT_INVALID')
    if (offset > info.size) {
      return { path: relative(root, target).split(sep).join('/'), content: '', offset, actualOffset: offset, requestedOffset: offset, nextOffset: offset, bytes: 0, size: info.size, truncated: false, sha256: await hashFile(target) }
    }
    const readStart = Math.max(0, offset - 3)
    const length = Math.max(0, Math.min(maxBytes + 7, info.size - readStart))
    const buffer = Buffer.alloc(length)
    const handle = await open(target, 'r')
    try {
      await handle.read(buffer, 0, length, readStart)
    } finally {
      await handle.close()
    }
    const relativeOffset = offset - readStart
    let start = relativeOffset
    while (start > 0 && start < buffer.length && (buffer[start] & 0xc0) === 0x80) start -= 1
    let end = Math.min(start + maxBytes, buffer.length)
    while (end < buffer.length && end > start && (buffer[end] & 0xc0) === 0x80) end -= 1
    if (end === start && start < buffer.length) {
      end = start + 1
      while (end < buffer.length && (buffer[end] & 0xc0) === 0x80) end += 1
    }
    const content = buffer.subarray(start, end)
    assertCondition(!content.includes(0), 'Binary files are not supported by this tool', 'FILE_BINARY')
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(content)
    } catch {
      throw new AppError('File is not valid UTF-8; use file_read_binary for byte-accurate access', 'FILE_NOT_UTF8')
    }
    const actualOffset = readStart + start
    const nextOffset = readStart + end
    return {
      path: relative(root, target).split(sep).join('/'),
      content: text,
      offset: actualOffset,
      actualOffset,
      requestedOffset: offset,
      nextOffset,
      bytes: content.length,
      size: info.size,
      truncated: nextOffset < info.size,
      sha256: await hashFile(target)
    }
  }

  async attributes(projectId: string, requestedPath: string): Promise<{ path: string; type: 'file' | 'directory' | 'symlink'; size: number; mode: string; uid: number; gid: number; readable: boolean; writable: boolean; executable: boolean; atime: string; mtime: string; ctime: string; birthtime: string }> {
    const root = await this.projects.root(projectId)
    const target = resolve(root, requestedPath)
    assertCondition(inside(root, target), 'Path leaves the project folder', 'PATH_OUTSIDE_PROJECT')
    const canonicalParent = await realpath(dirname(target))
    assertCondition(inside(root, canonicalParent), 'Parent folder leaves the project folder', 'PATH_OUTSIDE_PROJECT')
    const info = await lstat(target)
    const mode = info.mode & 0o777
    return {
      path: relative(root, target).split(sep).join('/'),
      type: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file',
      size: info.size,
      mode: mode.toString(8).padStart(3, '0'),
      uid: info.uid,
      gid: info.gid,
      readable: Boolean(mode & 0o444),
      writable: Boolean(mode & 0o222),
      executable: Boolean(mode & 0o111),
      atime: info.atime.toISOString(),
      mtime: info.mtime.toISOString(),
      ctime: info.ctime.toISOString(),
      birthtime: info.birthtime.toISOString()
    }
  }

  async absolutePath(projectId: string, requestedPath: string): Promise<{ path: string; absolutePath: string; size: number; modifiedAt: string }> {
    const { root, target } = await this.existingPath(projectId, requestedPath)
    const info = await stat(target)
    assertCondition(info.isFile(), 'Path is not a file', 'FILE_NOT_FILE')
    return { path: relative(root, target).split(sep).join('/'), absolutePath: target, size: info.size, modifiedAt: info.mtime.toISOString() }
  }

  async hash(projectId: string, requestedPath: string): Promise<FileHashResult> {
    const { root, target } = await this.existingPath(projectId, requestedPath)
    const info = await stat(target)
    assertCondition(info.isFile(), 'Path is not a file', 'FILE_NOT_FILE')
    return { path: relative(root, target).split(sep).join('/'), size: info.size, modifiedAt: info.mtime.toISOString(), sha256: await hashFile(target) }
  }

  async write(projectId: string, requestedPath: string, content: string, options: { expectedSha256?: string; atomic?: boolean } = {}): Promise<{ path: string; bytes: number; sha256: string }> {
    const { root, target } = await this.writablePath(projectId, requestedPath)
    if (options.expectedSha256) {
      let currentHash = ''
      try {
        currentHash = await hashFile(target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (currentHash !== options.expectedSha256.toLowerCase()) {
        throw new AppError('File SHA-256 does not match the expected version', 'FILE_VERSION_CONFLICT', { expected: options.expectedSha256.toLowerCase(), actual: currentHash || null })
      }
    }
    if (options.atomic === false) await writeFile(target, content, 'utf8')
    else await atomicWrite(target, content)
    return { path: relative(root, target).split(sep).join('/'), bytes: Buffer.byteLength(content), sha256: await hashFile(target) }
  }

  async patch(projectId: string, requestedPath: string, oldText: string, newText: string, expectedReplacements = 1, options: { expectedSha256?: string; dryRun?: boolean } = {}): Promise<{ path: string; replacements: number; beforeSha256: string; afterSha256: string; changed: boolean; dryRun: boolean }> {
    assertCondition(oldText.length > 0, 'oldText cannot be empty', 'PATCH_EMPTY_SOURCE')
    const { root, target } = await this.existingPath(projectId, requestedPath)
    const beforeSha256 = await hashFile(target)
    if (options.expectedSha256 && beforeSha256 !== options.expectedSha256.toLowerCase()) {
      throw new AppError('File SHA-256 does not match the expected version', 'FILE_VERSION_CONFLICT', { expected: options.expectedSha256.toLowerCase(), actual: beforeSha256 })
    }
    const content = await readFile(target, 'utf8')
    const replacements = content.split(oldText).length - 1
    if (replacements !== expectedReplacements) {
      throw new AppError(`Expected ${expectedReplacements} replacements, found ${replacements}`, 'PATCH_MATCH_MISMATCH')
    }
    const next = content.split(oldText).join(newText)
    const afterSha256 = createHash('sha256').update(next).digest('hex')
    if (!options.dryRun) await atomicWrite(target, next)
    return { path: relative(root, target).split(sep).join('/'), replacements, beforeSha256, afterSha256, changed: next !== content, dryRun: Boolean(options.dryRun) }
  }

  async createDirectory(projectId: string, requestedPath: string): Promise<{ path: string }> {
    const { root, target } = await this.writablePath(projectId, requestedPath)
    await mkdir(target, { recursive: true })
    return { path: relative(root, target).split(sep).join('/') }
  }

  async move(projectId: string, sourcePath: string, destinationPath: string, options: { overwrite?: boolean; expectedSourceSha256?: string; expectedDestinationSha256?: string } = {}): Promise<{ path: string; overwritten: boolean; beforeSha256: string | null; sha256: string | null }> {
    const source = await this.existingPath(projectId, sourcePath)
    assertCondition(source.target !== source.root, 'Cannot move the project root', 'PROJECT_ROOT_OPERATION')
    const destination = await this.writablePath(projectId, destinationPath)
    assertCondition(source.target !== destination.target, 'Move source and destination must differ', 'FILE_MOVE_SAME_PATH')
    const sourceInfo = await lstat(source.target)
    const sourceHash = sourceInfo.isFile() ? await hashFile(source.target) : null
    if (options.expectedSourceSha256 && sourceHash !== options.expectedSourceSha256.toLowerCase()) {
      throw new AppError('Source SHA-256 does not match the expected version', 'FILE_VERSION_CONFLICT', { expected: options.expectedSourceSha256.toLowerCase(), actual: sourceHash })
    }
    let destinationInfo
    try {
      destinationInfo = await lstat(destination.target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      destinationInfo = undefined
    }
    let beforeSha256: string | null = null
    if (destinationInfo) {
      throwUnlessMoveOverwrite(options.overwrite, destinationInfo.isFile() && sourceInfo.isFile())
      if (!options.expectedDestinationSha256) {
        throw new AppError('Overwriting an existing file requires expectedDestinationSha256', 'FILE_CONFLICT_HASH_REQUIRED')
      }
      beforeSha256 = await hashFile(destination.target)
      if (beforeSha256 !== options.expectedDestinationSha256.toLowerCase()) {
        throw new AppError('Destination SHA-256 does not match the expected version', 'FILE_VERSION_CONFLICT', { expected: options.expectedDestinationSha256.toLowerCase(), actual: beforeSha256 })
      }
    }
    await rename(source.target, destination.target)
    return {
      path: relative(destination.root, destination.target).split(sep).join('/'),
      overwritten: Boolean(destinationInfo),
      beforeSha256,
      sha256: sourceHash
    }
  }

  async copy(projectId: string, sourcePath: string, destinationPath: string, onConflict: 'fail' | 'overwrite' | 'rename' = 'fail'): Promise<{ path: string; bytes: number; sha256: string | null; conflict: 'none' | 'overwritten' | 'renamed' }> {
    const source = await this.existingPath(projectId, sourcePath)
    assertCondition(source.target !== source.root, 'Cannot copy the project root', 'PROJECT_ROOT_OPERATION')
    const destination = await this.writablePath(projectId, destinationPath)
    assertCondition(source.target !== destination.target, 'Copy source and destination must differ', 'FILE_COPY_SAME_PATH')
    const resolved = await this.resolveConflict(destination.root, destination.target, onConflict)
    const info = await stat(source.target)
    await cp(source.target, resolved.target, { recursive: true, preserveTimestamps: true, force: onConflict === 'overwrite' })
    return { path: relative(destination.root, resolved.target).split(sep).join('/'), bytes: info.isFile() ? info.size : 0, sha256: info.isFile() ? await hashFile(resolved.target) : null, conflict: resolved.conflict }
  }

  async deletePlan(projectId: string, requestedPath: string): Promise<FileDeletePlan> {
    const { root, target } = await this.existingPath(projectId, requestedPath)
    assertCondition(target !== root, 'Cannot delete the project root', 'PROJECT_ROOT_OPERATION')
    const info = await lstat(target)
    const type = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file'
    let files = type === 'file' ? 1 : 0
    let directories = type === 'directory' ? 1 : 0
    let bytes = type === 'file' ? info.size : 0
    const samplePaths: string[] = [relative(root, target).split(sep).join('/')]
    if (type === 'directory') {
      const visit = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const absolute = join(directory, entry.name)
          if (samplePaths.length < 20) samplePaths.push(relative(root, absolute).split(sep).join('/'))
          if (entry.isDirectory()) {
            directories += 1
            await visit(absolute)
          } else {
            files += 1
            bytes += (await lstat(absolute)).size
          }
        }
      }
      await visit(target)
    }
    return { path: relative(root, target).split(sep).join('/'), type, files, directories, bytes, samplePaths }
  }

  async remove(projectId: string, requestedPath: string, recursive = false, options: { expectedSha256?: string; dryRun?: boolean } = {}): Promise<{ path: string; type: 'file' | 'directory' | 'symlink'; bytes: number; recoverable: boolean; trashId: string | null; dryRun: boolean; sha256: string | null }> {
    const { root, target } = await this.existingPath(projectId, requestedPath)
    assertCondition(target !== root, 'Cannot delete the project root', 'PROJECT_ROOT_OPERATION')
    const info = await lstat(target)
    const type = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file'
    if (type === 'directory' && !recursive && (await readdir(target)).length > 0) {
      throw new AppError('Directory is not empty; set recursive=true after reviewing file_delete_plan', 'DIRECTORY_NOT_EMPTY')
    }
    assertCondition(type === 'file' || !options.expectedSha256, 'SHA-256 deletion checks are only supported for regular files', 'FILE_HASH_UNSUPPORTED')
    const sha256 = type === 'file' ? await hashFile(target) : null
    if (options.expectedSha256 && sha256 !== options.expectedSha256.toLowerCase()) {
      throw new AppError('File SHA-256 does not match the expected version', 'FILE_VERSION_CONFLICT', { expected: options.expectedSha256.toLowerCase(), actual: sha256 })
    }
    const plan = await this.deletePlan(projectId, requestedPath)
    const relativePath = relative(root, target).split(sep).join('/')
    if (options.dryRun) {
      return { path: relativePath, type, bytes: plan.bytes, recoverable: Boolean(this.trashDirectory), trashId: null, dryRun: true, sha256 }
    }
    if (this.trashDirectory) {
      const record = await this.createTrashRecord(target, projectId, relativePath, type, plan.bytes, 'deleted')
      return { path: relativePath, type, bytes: plan.bytes, recoverable: true, trashId: record.id, dryRun: false, sha256 }
    }
    await rm(target, { recursive, force: false })
    return { path: relativePath, type, bytes: plan.bytes, recoverable: false, trashId: null, dryRun: false, sha256 }
  }

  async backup(projectId: string, requestedPath: string): Promise<TrashRecord> {
    if (!this.trashDirectory) throw new AppError('Trash storage is not configured', 'TRASH_UNAVAILABLE')
    const { root, target } = await this.existingPath(projectId, requestedPath)
    const info = await lstat(target)
    const type = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file'
    const plan = await this.deletePlan(projectId, requestedPath)
    return this.createTrashRecord(target, projectId, relative(root, target).split(sep).join('/'), type, plan.bytes, 'backup')
  }

  async trashList(): Promise<TrashRecord[]> {
    if (!this.trashDirectory) return []
    try {
      const entries = await readdir(this.trashDirectory, { withFileTypes: true })
      const records: TrashRecord[] = []
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/i.test(entry.name)) continue
        try {
          records.push(JSON.parse(await readFile(join(this.trashDirectory, entry.name, 'metadata.json'), 'utf8')) as TrashRecord)
        } catch {
          continue
        }
      }
      return records.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async restoreTrash(id: string, overwrite = false): Promise<{ path: string; type: TrashRecord['type']; bytes: number }> {
    if (!this.trashDirectory) throw new AppError('Trash storage is not configured', 'TRASH_UNAVAILABLE')
    assertCondition(/^[a-f0-9-]{36}$/i.test(id), 'Invalid trash ID', 'TRASH_NOT_FOUND')
    const directory = join(this.trashDirectory, id)
    const record = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8')) as TrashRecord
    assertCondition(record.id === id, 'Invalid trash metadata', 'TRASH_NOT_FOUND')
    const destination = await this.writablePath(record.projectId, record.originalPath)
    let exists = false
    try {
      await lstat(destination.target)
      exists = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (exists && !overwrite) throw new AppError('Original destination already exists; set overwrite=true to restore', 'TRASH_DESTINATION_CONFLICT')
    if (exists) await rm(destination.target, { recursive: true, force: true })
    const payload = join(directory, 'payload')
    try {
      await rename(payload, destination.target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      await cp(payload, destination.target, { recursive: true, preserveTimestamps: true })
      await rm(payload, { recursive: true, force: true })
    }
    await rm(directory, { recursive: true, force: true })
    return { path: record.originalPath, type: record.type, bytes: record.bytes }
  }

  private async createTrashRecord(target: string, projectId: string, originalPath: string, type: TrashRecord['type'], bytes: number, reason: TrashRecord['reason']): Promise<TrashRecord> {
    const directory = join(this.trashDirectory as string, randomUUID())
    const payload = join(directory, 'payload')
    await mkdir(directory, { recursive: true })
    if (reason === 'deleted') {
      try {
        await rename(target, payload)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
        await cp(target, payload, { recursive: true, preserveTimestamps: true })
        await rm(target, { recursive: true, force: true })
      }
    } else {
      await cp(target, payload, { recursive: true, preserveTimestamps: true })
    }
    const record: TrashRecord = { id: basename(directory), projectId, originalPath, deletedAt: new Date().toISOString(), type, bytes, reason }
    await writeFile(join(directory, 'metadata.json'), JSON.stringify(record, null, 2), { mode: 0o600 })
    return record
  }

  async search(projectId: string, query: string, options: { path?: string; regex?: boolean; caseSensitive?: boolean; maxResults?: number; respectGitignore?: boolean; cursor?: string; includeGlobs?: string[]; excludeGlobs?: string[] } = {}): Promise<{ matches: SearchMatch[]; nextCursor: string | null }> {
    assertCondition(query.length > 0, 'Search query is required', 'SEARCH_QUERY_REQUIRED')
    const { root, target } = await this.existingPath(projectId, options.path ?? '.')
    const flags = options.caseSensitive ? 'g' : 'gi'
    const matcher = options.regex ? new RegExp(query, flags) : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
    const maxResults = options.maxResults ?? 100
    assertCondition(Number.isInteger(maxResults) && maxResults > 0 && maxResults <= 1000, 'maxResults must be between 1 and 1000', 'SEARCH_LIMIT_INVALID')
    const cursor = options.cursor ?? '0'
    assertCondition(/^(0|[1-9]\d*)$/.test(cursor) && Number.isSafeInteger(Number(cursor)), 'Invalid search cursor', 'SEARCH_CURSOR_INVALID')
    const offset = Number(cursor)
    const matches: SearchMatch[] = []
    let position = 0
    let hasMore = false
    const ignoreRules = ignore().add([...ignoredDirectories].map((name) => `${name}/`))
    if (options.respectGitignore !== false) {
      try {
        ignoreRules.add(await readFile(join(root, '.gitignore'), 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const includeGlobs = options.includeGlobs ?? []
    const excludeGlobs = options.excludeGlobs ?? []
    assertCondition(includeGlobs.length <= 100 && excludeGlobs.length <= 100 && [...includeGlobs, ...excludeGlobs].every((pattern) => pattern.trim().length > 0), 'Search glob lists must contain at most 100 non-empty patterns', 'SEARCH_GLOB_INVALID')
    const includeRules = includeGlobs.length > 0 ? ignore().add(includeGlobs) : null
    const excludeRules = ignore().add(excludeGlobs)
    const relativePath = (absolute: string): string => relative(root, absolute).split(sep).join('/')
    const addMatch = (match: SearchMatch): void => {
      if (position >= offset && matches.length < maxResults) matches.push(match)
      else if (position >= offset) hasMore = true
      position += 1
    }
    const searchFile = async (absolute: string, applyIgnore: boolean): Promise<void> => {
      const path = relativePath(absolute)
      if (hasMore || (applyIgnore && ignoreRules.ignores(path)) || excludeRules.ignores(path) || (includeRules && !includeRules.ignores(path)) || binaryExtensions.has(extname(absolute).toLowerCase())) return
      const info = await stat(absolute)
      if (info.size > 1_000_000) return
      const content = await readFile(absolute, 'utf8')
      if (content.includes('\0')) return
      const lines = content.split(/\r?\n/)
      for (let index = 0; index < lines.length && !hasMore; index += 1) {
        matcher.lastIndex = 0
        const match = matcher.exec(lines[index])
        if (!match) continue
        addMatch({ path, line: index + 1, column: match.index + 1, preview: lines[index].slice(0, 500) })
      }
    }
    const visit = async (directory: string): Promise<void> => {
      if (hasMore) return
      const entries = await readdir(directory, { withFileTypes: true })
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        if (hasMore) return
        const absolute = join(directory, entry.name)
        const relativeEntry = relativePath(absolute)
        if (entry.isDirectory()) {
          if (!ignoredDirectories.has(entry.name) && !ignoreRules.ignores(`${relativeEntry}/`) && !excludeRules.ignores(`${relativeEntry}/`)) await visit(absolute)
        } else if (entry.isFile()) {
          await searchFile(absolute, true)
        }
      }
    }
    const info = await stat(target)
    if (info.isDirectory()) await visit(target)
    else if (info.isFile()) await searchFile(target, false)
    return { matches, nextCursor: hasMore ? String(offset + matches.length) : null }
  }

  async readBinary(projectId: string, requestedPath: string, offset = 0, maxBytes = 1_000_000): Promise<{ path: string; base64: string; offset: number; nextOffset: number; size: number; truncated: boolean; sha256: string }> {
    const { root, target } = await this.existingPath(projectId, requestedPath)
    const info = await stat(target)
    assertCondition(info.isFile(), 'Path is not a file', 'FILE_NOT_FILE')
    assertCondition(Number.isSafeInteger(offset) && offset >= 0 && offset <= info.size, 'Invalid binary read offset', 'FILE_OFFSET_INVALID')
    const length = Math.max(0, Math.min(Math.min(maxBytes, 4_000_000), info.size - offset))
    const handle = await open(target, 'r')
    let buffer: Buffer
    try {
      buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, offset)
    } finally {
      await handle.close()
    }
    return {
      path: relative(root, target).split(sep).join('/'),
      base64: buffer.toString('base64'),
      offset,
      nextOffset: offset + length,
      size: info.size,
      truncated: offset + length < info.size,
      sha256: await hashFile(target)
    }
  }

  async writeBinary(projectId: string, requestedPath: string, base64: string, options: { offset?: number; truncate?: boolean; expectedSha256?: string } = {}): Promise<{ path: string; bytes: number; size: number; sha256: string }> {
    const content = decodeBase64(base64)
    const offset = options.offset ?? 0
    const truncate = options.truncate ?? offset === 0
    const { root, target } = await this.writablePath(projectId, requestedPath)
    let currentSize = 0
    try {
      currentSize = (await stat(target)).size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (truncate) currentSize = 0
    assertCondition(Number.isSafeInteger(offset) && offset >= 0 && offset === currentSize, 'Binary chunk offset does not match the current file size', 'FILE_OFFSET_MISMATCH')
    let destination = target
    let verificationTemp: string | undefined
    if (options.expectedSha256) {
      verificationTemp = join(dirname(target), `.${randomUUID()}.verify.tmp`)
      if (truncate) await writeFile(verificationTemp, Buffer.alloc(0))
      else await copyFile(target, verificationTemp)
      destination = verificationTemp
    }
    try {
      const handle = await open(destination, truncate ? 'w' : 'a')
      try {
        await handle.write(content)
      } finally {
        await handle.close()
      }
      const sha256 = await hashFile(destination)
      if (options.expectedSha256 && options.expectedSha256.toLowerCase() !== sha256) {
        throw new AppError('Binary file SHA-256 does not match the expected value', 'FILE_HASH_MISMATCH', { expected: options.expectedSha256.toLowerCase(), actual: sha256 })
      }
      if (verificationTemp) await rename(verificationTemp, target)
      return { path: relative(root, target).split(sep).join('/'), bytes: content.length, size: (await stat(target)).size, sha256 }
    } catch (error) {
      if (verificationTemp) await rm(verificationTemp, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async copyBinary(projectId: string, sourceAbsolutePath: string, destinationPath: string, onConflict: 'fail' | 'overwrite' | 'rename' = 'fail'): Promise<{ path: string; bytes: number; sha256: string; conflict: 'none' | 'overwritten' | 'renamed' }> {
    const info = await stat(sourceAbsolutePath)
    assertCondition(info.isFile() && info.size <= maxArchiveBytes, 'Source is not a file or exceeds 200 MB', 'FILE_LIMIT_EXCEEDED')
    const requestedDirectory = destinationPath.trim() || '.'
    try {
      const existing = await this.existingPath(projectId, requestedDirectory)
      assertCondition((await stat(existing.target)).isDirectory(), 'Attachment destination is not a directory', 'FILE_NOT_DIRECTORY')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const destination = await this.writablePath(projectId, join(requestedDirectory, basename(sourceAbsolutePath)))
    const resolved = await this.resolveConflict(destination.root, destination.target, onConflict)
    await copyFile(sourceAbsolutePath, resolved.target)
    return { path: relative(destination.root, resolved.target).split(sep).join('/'), bytes: info.size, sha256: await hashFile(resolved.target), conflict: resolved.conflict }
  }

  private async resolveConflict(root: string, target: string, onConflict: 'fail' | 'overwrite' | 'rename'): Promise<{ target: string; conflict: 'none' | 'overwritten' | 'renamed' }> {
    let exists = false
    try {
      await lstat(target)
      exists = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (!exists) return { target, conflict: 'none' }
    if (onConflict === 'fail') throw new AppError('Destination already exists', 'FILE_EXISTS')
    if (onConflict === 'overwrite') return { target, conflict: 'overwritten' }
    const extension = extname(target)
    const stem = basename(target, extension)
    const directory = dirname(target)
    for (let index = 1; index <= 10_000; index += 1) {
      const candidate = join(directory, `${stem} (${index})${extension}`)
      assertCondition(inside(root, candidate) && candidate !== root, 'Renamed destination leaves the project folder', 'PATH_OUTSIDE_PROJECT')
      try {
        await lstat(candidate)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return { target: candidate, conflict: 'renamed' }
      }
    }
    throw new AppError('Could not find an available destination filename', 'FILE_RENAME_EXHAUSTED')
  }

  async createArchive(projectId: string, sourcePath: string, destinationPath: string): Promise<{ path: string; files: number; bytes: number; size: number; sha256: string }> {
    const source = await this.existingPath(projectId, sourcePath)
    const destination = await this.writablePath(projectId, destinationPath)
    assertCondition(source.target !== destination.target, 'Archive destination cannot equal its source', 'ARCHIVE_SOURCE_INVALID')
    const zip = new AdmZip()
    let files = 0
    let bytes = 0
    const visit = async (absolute: string): Promise<void> => {
      const entries = await readdir(absolute, { withFileTypes: true })
      for (const entry of entries) {
        const entryPath = join(absolute, entry.name)
        if (entryPath === destination.target) continue
        if (entry.isDirectory()) {
          if (!ignoredDirectories.has(entry.name)) await visit(entryPath)
          continue
        }
        if (!entry.isFile()) continue
        const info = await stat(entryPath)
        bytes += info.size
        files += 1
        assertCondition(files <= 10_000 && bytes <= maxArchiveBytes, 'Archive exceeds the 10000-file or 200 MB limit', 'ARCHIVE_LIMIT_EXCEEDED')
        zip.addFile(relative(source.target, entryPath).split(sep).join('/'), await readFile(entryPath))
      }
    }
    const info = await stat(source.target)
    if (info.isDirectory()) await visit(source.target)
    else {
      bytes = info.size
      files = 1
      assertCondition(bytes <= maxArchiveBytes, 'Archive exceeds the 200 MB limit', 'ARCHIVE_LIMIT_EXCEEDED')
      zip.addFile(basename(source.target), await readFile(source.target))
    }
    zip.writeZip(destination.target)
    return { path: relative(destination.root, destination.target).split(sep).join('/'), files, bytes, size: (await stat(destination.target)).size, sha256: await hashFile(destination.target) }
  }

  async extractArchive(projectId: string, archivePath: string, destinationPath: string): Promise<{ path: string; files: number; bytes: number }> {
    const archive = await this.existingPath(projectId, archivePath)
    return this.extractArchiveFile(projectId, archive.target, destinationPath)
  }

  async extractArchiveFile(projectId: string, absoluteArchivePath: string, destinationPath: string): Promise<{ path: string; files: number; bytes: number }> {
    const archiveInfo = await stat(absoluteArchivePath)
    assertCondition(archiveInfo.isFile() && archiveInfo.size <= maxArchiveBytes, 'Archive is not a file or exceeds 200 MB', 'ARCHIVE_LIMIT_EXCEEDED')
    const projectRoot = await this.projects.root(projectId)
    const destination = destinationPath === '.' || destinationPath === '' ? { root: projectRoot, target: projectRoot } : await this.writablePath(projectId, destinationPath)
    const zip = new AdmZip(absoluteArchivePath)
    const entries = zip.getEntries()
    assertCondition(entries.length <= 2000, 'Archive contains more than 2000 entries', 'ARCHIVE_LIMIT_EXCEEDED')
    let files = 0
    let bytes = 0
    for (const entry of entries) {
      const normalized = entry.entryName.replace(/\\/g, '/')
      const segments = normalized.split('/')
      assertCondition(!normalized.startsWith('/') && !/^[a-zA-Z]:/.test(normalized) && !segments.includes('..'), 'Archive entry leaves the destination folder', 'ARCHIVE_PATH_OUTSIDE_PROJECT')
      if (entry.isDirectory) continue
      bytes += entry.header.size
      files += 1
      assertCondition(entry.header.size <= 50_000_000 && bytes <= maxArchiveBytes, 'Archive entry or total uncompressed size exceeds the limit', 'ARCHIVE_LIMIT_EXCEEDED')
      const relativeDestination = relative(projectRoot, resolve(destination.target, normalized))
      const output = await this.writablePath(projectId, relativeDestination)
      assertCondition(inside(destination.target, output.target), 'Archive entry leaves the destination folder', 'ARCHIVE_PATH_OUTSIDE_PROJECT')
      await writeFile(output.target, entry.getData())
    }
    return { path: relative(projectRoot, destination.target).split(sep).join('/') || '.', files, bytes }
  }
}