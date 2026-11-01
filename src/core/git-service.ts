import { execFile } from 'node:child_process'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ProjectService } from './project-service'
import { AppError, assertCondition } from './errors'

const execFileAsync = promisify(execFile)
const maxGitOutput = 2_000_000

interface GitChange {
  index: string
  worktree: string
  path: string
}

export interface GitStatusResult {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  clean: boolean
  changes: GitChange[]
  raw: string
}

export interface GitCommitResult {
  hash: string
  shortHash: string
  subject: string
}

export class GitService {
  constructor(private readonly projects: ProjectService) {}

  async status(projectId: string): Promise<GitStatusResult> {
    const root = await this.projects.root(projectId)
    const raw = await this.git(root, ['status', '--porcelain=v1', '--branch', '--untracked-files=all'])
    const lines = raw.split(/\r?\n/).filter(Boolean)
    const header = lines.find((line) => line.startsWith('## ')) ?? ''
    const branchPart = header.slice(3)
    const branch = branchPart.startsWith('No commits yet on ')
      ? branchPart.slice('No commits yet on '.length)
      : branchPart.split('...')[0]?.split(' ')[0] || null
    const upstream = branchPart.match(/\.\.\.([^\s[]+)/)?.[1] ?? null
    const ahead = Number.parseInt(branchPart.match(/ahead (\d+)/)?.[1] ?? '0', 10)
    const behind = Number.parseInt(branchPart.match(/behind (\d+)/)?.[1] ?? '0', 10)
    const changes = lines.filter((line) => !line.startsWith('## ')).map((line) => ({
      index: line[0] ?? ' ',
      worktree: line[1] ?? ' ',
      path: line.slice(3).replace(/^"|"$/g, '')
    }))
    return { branch, upstream, ahead, behind, clean: changes.length === 0, changes, raw }
  }

  async diff(projectId: string, options: { staged?: boolean; base?: string; path?: string } = {}): Promise<{ diff: string; truncated: boolean }> {
    const root = await this.projects.root(projectId)
    const args = ['diff', '--no-ext-diff', '--no-color']
    if (options.staged) args.push('--cached')
    if (options.base) {
      await this.assertGitRef(root, options.base)
      args.push(options.base)
    }
    if (options.path) args.push('--', await this.safeRelative(root, options.path))
    const output = await this.git(root, args, true)
    return { diff: output.slice(0, maxGitOutput), truncated: output.length > maxGitOutput }
  }

  async log(projectId: string, limit = 20): Promise<Array<{ hash: string; shortHash: string; author: string; date: string; subject: string }>> {
    const root = await this.projects.root(projectId)
    const count = Math.max(1, Math.min(limit, 100))
    const output = await this.git(root, ['log', `-${count}`, '--pretty=format:%H%x09%an%x09%aI%x09%s'])
    return output.split(/\r?\n/).filter(Boolean).map((line) => {
      const [hash = '', author = '', date = '', ...subjectParts] = line.split('\t')
      return { hash, shortHash: hash.slice(0, 8), author, date, subject: subjectParts.join('\t') }
    })
  }

  async branches(projectId: string): Promise<Array<{ name: string; hash: string; current: boolean; remote: boolean }>> {
    const root = await this.projects.root(projectId)
    const output = await this.git(root, ['for-each-ref', '--format=%(refname:short)%09%(objectname:short)%09%(HEAD)%09%(refname)', 'refs/heads', 'refs/remotes'])
    return output.split(/\r?\n/).filter(Boolean).map((line) => {
      const [name = '', hash = '', marker = '', ref = ''] = line.split('\t')
      return { name, hash, current: marker === '*', remote: ref.startsWith('refs/remotes/') }
    })
  }

  async worktrees(projectId: string): Promise<Array<{ path: string; head: string | null; branch: string | null; bare: boolean; prunable: boolean }>> {
    const root = await this.projects.root(projectId)
    const output = await this.git(root, ['worktree', 'list', '--porcelain'])
    return output.split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
      const values = new Map<string, string>()
      for (const line of block.split(/\r?\n/)) {
        const separator = line.indexOf(' ')
        values.set(separator < 0 ? line : line.slice(0, separator), separator < 0 ? '' : line.slice(separator + 1))
      }
      return {
        path: values.get('worktree') ?? '',
        head: values.get('HEAD') || null,
        branch: values.get('branch')?.replace(/^refs\/heads\//, '') ?? null,
        bare: values.has('bare'),
        prunable: values.has('prunable')
      }
    })
  }

  async addWorktree(projectId: string, path: string, branch: string, base = 'HEAD'): Promise<{ path: string; branch: string; base: string }> {
    assertCondition(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) && !branch.includes('..') && !branch.endsWith('/'), 'Invalid Git branch name', 'GIT_BRANCH_INVALID')
    const root = await this.projects.root(projectId)
    const relativePath = await this.safeRelative(root, path)
    const segments = relativePath.split('/')
    assertCondition(segments[0] === '.worktrees' && segments.length > 1, 'Worktree path must be below .worktrees/', 'GIT_WORKTREE_PATH_INVALID')
    const destination = resolve(root, relativePath)
    await this.secureWorktreeParent(root, destination)
    try {
      await stat(destination)
      throw new AppError('Worktree destination already exists', 'GIT_WORKTREE_EXISTS')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await this.assertGitRef(root, base)
    await this.git(root, ['worktree', 'add', '-b', branch, destination, base])
    return { path: relativePath, branch, base }
  }

  async removeWorktree(projectId: string, path: string, force = false): Promise<{ removed: string }> {
    const root = await this.projects.root(projectId)
    const relativePath = await this.safeRelative(root, path)
    const segments = relativePath.split('/')
    assertCondition(segments[0] === '.worktrees' && segments.length > 1, 'Worktree path must be below .worktrees/', 'GIT_WORKTREE_PATH_INVALID')
    const destination = resolve(root, relativePath)
    const registered = (await this.worktrees(projectId)).some((item) => resolve(item.path) === destination)
    assertCondition(registered, 'Worktree path is not registered for this project', 'GIT_WORKTREE_NOT_FOUND')
    await this.git(root, ['worktree', 'remove', ...(force ? ['--force'] : []), destination])
    return { removed: relativePath }
  }

  async conflicts(projectId: string): Promise<string[]> {
    const root = await this.projects.root(projectId)
    return (await this.git(root, ['diff', '--name-only', '--diff-filter=U', '--no-color'])).split(/\r?\n/).filter(Boolean)
  }

  async resolveConflicts(projectId: string, paths: string[], strategy: 'ours' | 'theirs'): Promise<{ strategy: 'ours' | 'theirs'; resolved: string[] }> {
    assertCondition(paths.length > 0 && paths.length <= 200, 'Provide between 1 and 200 conflicted paths', 'GIT_PATHS_REQUIRED')
    assertCondition(strategy === 'ours' || strategy === 'theirs', 'Conflict strategy must be ours or theirs', 'GIT_CONFLICT_STRATEGY_INVALID')
    const root = await this.projects.root(projectId)
    const safe = await Promise.all(paths.map((path) => this.safeRelative(root, path)))
    const conflicted = new Set(await this.conflicts(projectId))
    assertCondition(safe.every((path) => conflicted.has(path)), 'One or more paths are not currently conflicted', 'GIT_CONFLICT_NOT_FOUND')
    await this.git(root, ['checkout', `--${strategy}`, '--', ...safe])
    await this.git(root, ['add', '--', ...safe])
    return { strategy, resolved: safe }
  }

  async stage(projectId: string, paths: string[]): Promise<{ staged: string[] }> {
    assertCondition(paths.length > 0 && paths.length <= 200, 'Provide between 1 and 200 paths', 'GIT_PATHS_REQUIRED')
    const root = await this.projects.root(projectId)
    const safe = await Promise.all(paths.map((path) => this.safeRelative(root, path)))
    await this.git(root, ['add', '--', ...safe])
    return { staged: safe }
  }

  async commit(projectId: string, message: string, paths?: string[]): Promise<GitCommitResult> {
    const trimmed = message.trim()
    assertCondition(trimmed.length > 0 && trimmed.length <= 4000, 'Commit message is required and must be at most 4000 characters', 'GIT_MESSAGE_INVALID')
    const root = await this.projects.root(projectId)
    const args = ['commit', '-m', trimmed]
    if (paths && paths.length > 0) {
      assertCondition(paths.length <= 200, 'At most 200 paths can be committed', 'GIT_PATHS_REQUIRED')
      const safe = await Promise.all(paths.map((path) => this.safeRelative(root, path)))
      await this.git(root, ['add', '--', ...safe])
      args.push('--', ...safe)
    }
    const output = await this.git(root, args)
    const hash = await this.git(root, ['rev-parse', 'HEAD'])
    const subject = (await this.git(root, ['log', '-1', '--pretty=format:%s'])).trim()
    return { hash, shortHash: hash.slice(0, 8), subject: subject || output.split(/\r?\n/)[0] || '' }
  }

  private async secureWorktreeParent(root: string, destination: string): Promise<void> {
    const parent = dirname(destination)
    let ancestor = parent
    while (true) {
      try {
        const canonicalAncestor = await realpath(ancestor)
        this.assertInside(root, canonicalAncestor, 'Worktree parent folder leaves the project')
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const upper = dirname(ancestor)
        if (upper === ancestor) throw error
        ancestor = upper
      }
    }
    await mkdir(parent, { recursive: true })
    const canonicalParent = await realpath(parent)
    this.assertInside(root, canonicalParent, 'Worktree parent folder leaves the project')
  }

  private assertInside(root: string, target: string, message: string): void {
    const pathFromRoot = relative(root, target)
    assertCondition(pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot)), message, 'PATH_OUTSIDE_PROJECT')
  }

  private async safeRelative(root: string, requested: string): Promise<string> {
    const candidate = resolve(root, requested)
    const pathFromRoot = relative(root, candidate)
    assertCondition(pathFromRoot !== '' && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot), 'Git path leaves the project folder', 'PATH_OUTSIDE_PROJECT')
    return pathFromRoot.split(sep).join('/')
  }

  private async assertGitRef(root: string, ref: string): Promise<void> {
    assertCondition(/^[A-Za-z0-9._~^/@{}:-]+$/.test(ref) && !ref.startsWith('-'), 'Invalid Git base revision', 'GIT_REF_INVALID')
    await this.git(root, ['rev-parse', '--verify', `${ref}^{commit}`])
  }

  private async git(root: string, args: string[], allowEmpty = false): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', args, { cwd: root, windowsHide: true, timeout: 20_000, maxBuffer: maxGitOutput * 2, encoding: 'utf8' })
      return stdout.trimEnd()
    } catch (error) {
      const candidate = error as Error & { stderr?: string; code?: string | number }
      if (candidate.code === 'ENOENT') throw new AppError('Git executable was not found', 'GIT_UNAVAILABLE')
      if (allowEmpty && typeof candidate.stderr === 'string') return candidate.stderr.trimEnd()
      throw new AppError(candidate.stderr?.trim() || candidate.message || 'Git command failed', 'GIT_COMMAND_FAILED', { args })
    }
  }
}