import { copyFile, mkdir, lstat, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import AdmZip from 'adm-zip'
import type { FileEntry } from '../shared/types'
import { AppError, assertCondition } from './errors'
import { ProjectService } from './project-service'

export interface FileReadResult {
  path: string
  content: string
  size: number
  truncated: boolean
}

export interface SearchMatch {
  path: string
  line: number
  column: number
  preview: string
}

const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'out', 'release', 'coverage', '.next', '.turbo'])
const binaryExtensions = new Set(['.exe', '.dll', '.so', '.dylib', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.gz', '.7z', '.mp3', '.mp4', '.woff', '.woff2'])
const maxArchiveBytes = 200_000_000

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
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
  constructor(private readonly projects: ProjectService) {}

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
    const handle = await open(target, 'r')
    try {
      const length = Math.max(0, Math.min(maxBytes + 1, info.size - offset))
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, offset)
      const truncated = offset + maxBytes < info.size
      const content = buffer.subarray(0, Math.min(length, maxBytes))
      assertCondition(!content.includes(0), 'Binary files are not supported by this tool', 'FILE_BINARY')
      return {
        path: relative(root, target).split(sep).join('/'),
        content: content.toString('utf8'),
        size: info.size,
        truncated
      }
    } finally {
      await handle.close()
    }
  }

  async write(projectId: string, requestedPath: string, content: string): Promise<{ path: string; bytes: number }> {
    const { root, target } = await this.writablePath(projectId, requestedPath)
    await writeFile(target, content, 'utf8')
    return { path: relative(root, target).split(sep).join('/'), bytes: Buffer.byteLength(content) }
  }

  async patch(projectId: string, requestedPath: string, oldText: string, newText: string, expectedReplacements = 1): Promise<{ path: string; replacements: number }> {
    assertCondition(oldText.length > 0, 'oldText cannot be empty', 'PATCH_EMPTY_SOURCE')
    const { root, target } = await this.existingPath(projectId, requestedPath)
    const content = await readFile(target, 'utf8')
    const replacements = content.split(oldText).length - 1
    if (replacements !== expectedReplacements) {
      throw new AppError(`Expected ${expectedReplacements} replacements, found ${replacements}`, 'PATCH_MATCH_MISMATCH')
    }
    await writeFile(target, content.split(oldText).join(newText), 'utf8')
    return { path: relative(root, target).split(sep).join('/'), replacements }
  }

  async createDirectory(projectId: string, requestedPath: string): Promise<{ path: string }> {
    const { root, target } = await this.writablePath(projectId, requestedPath)
    await mkdir(target, { recursive: true })
    return { path: relative(root, target).split(sep).join('/') }
  }

  async move(projectId: string, sourcePath: string, destinationPath: string): Promise<{ path: string }> {
    const source = await this.existingPath(projectId, sourcePath)
    assertCondition(source.target !== source.root, 'Cannot move the project root', 'PROJECT_ROOT_OPERATION')
    const destination = await this.writablePath(projectId, destinationPath)
    await rename(source.target, destination.target)
    return { path: relative(destination.root, destination.target).split(sep).join('/') }
  }

  async remove(projectId: string, requestedPath: string, recursive = false): Promise<void> {
    const { root, target } = await this.existingPath(projectId, requestedPath)
    assertCondition(target !== root, 'Cannot delete the project root', 'PROJECT_ROOT_OPERATION')
    await rm(target, { recursive, force: false })
  }

  async search(projectId: string, query: string, options: { path?: string; regex?: boolean; caseSensitive?: boolean; maxResults?: number } = {}): Promise<SearchMatch[]> {
    assertCondition(query.length > 0, 'Search query is required', 'SEARCH_QUERY_REQUIRED')
    const { root, target } = await this.existingPath(projectId, options.path ?? '.')
    const flags = options.caseSensitive ? 'g' : 'gi'
    const matcher = options.regex ? new RegExp(query, flags) : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
    const maxResults = Math.min(options.maxResults ?? 100, 1000)
    const results: SearchMatch[] = []
    const visit = async (directory: string): Promise<void> => {
      if (results.length >= maxResults) return
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (results.length >= maxResults) return
        const absolute = join(directory, entry.name)
        if (entry.isDirectory()) {
          if (!ignoredDirectories.has(entry.name)) await visit(absolute)
          continue
        }
        if (!entry.isFile() || binaryExtensions.has(extname(entry.name).toLowerCase())) continue
        const info = await stat(absolute)
        if (info.size > 1_000_000) continue
        const content = await readFile(absolute, 'utf8')
        if (content.includes('\0')) continue
        const lines = content.split(/\r?\n/)
        for (let index = 0; index < lines.length; index += 1) {
          matcher.lastIndex = 0
          const match = matcher.exec(lines[index])
          if (!match) continue
          results.push({
            path: relative(root, absolute).split(sep).join('/'),
            line: index + 1,
            column: match.index + 1,
            preview: lines[index].slice(0, 500)
          })
          if (results.length >= maxResults) return
        }
      }
    }
    const info = await stat(target)
    if (info.isDirectory()) await visit(target)
    else {
      const content = await readFile(target, 'utf8')
      const lines = content.split(/\r?\n/)
      lines.forEach((line, index) => {
        if (results.length >= maxResults) return
        matcher.lastIndex = 0
        const match = matcher.exec(line)
        if (match) results.push({ path: relative(root, target).split(sep).join('/'), line: index + 1, column: match.index + 1, preview: line.slice(0, 500) })
      })
    }
    return results
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
    const handle = await open(target, truncate ? 'w' : 'a')
    try {
      await handle.write(content)
    } finally {
      await handle.close()
    }
    const sha256 = await hashFile(target)
    if (options.expectedSha256 && options.expectedSha256.toLowerCase() !== sha256) {
      throw new AppError('Binary file SHA-256 does not match the expected value', 'FILE_HASH_MISMATCH', { expected: options.expectedSha256.toLowerCase(), actual: sha256 })
    }
    return { path: relative(root, target).split(sep).join('/'), bytes: content.length, size: (await stat(target)).size, sha256 }
  }

  async copyBinary(projectId: string, sourceAbsolutePath: string, destinationPath: string): Promise<{ path: string; bytes: number; sha256: string }> {
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
    await copyFile(sourceAbsolutePath, destination.target)
    return { path: relative(destination.root, destination.target).split(sep).join('/'), bytes: info.size, sha256: await hashFile(destination.target) }
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