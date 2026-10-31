import { mkdir, lstat, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
}