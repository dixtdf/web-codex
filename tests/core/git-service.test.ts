import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '../../src/core/config-store'
import { GitService } from '../../src/core/git-service'
import { ProjectService } from '../../src/core/project-service'
import type { Project } from '../../src/shared/types'

const execFileAsync = promisify(execFile)
let temporaryDirectory: string
let project: Project
let git: GitService

async function runGit(args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd: project.path, encoding: 'utf8', windowsHide: true })).stdout.trim()
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'web-codex-git-'))
  const store = new ConfigStore(join(temporaryDirectory, 'config.json'))
  await store.load()
  const projects = new ProjectService(store)
  project = await projects.create({ path: join(temporaryDirectory, 'repo') })
  git = new GitService(projects)
  await runGit(['init', '-b', 'main'])
  await runGit(['config', 'user.name', 'Web Codex Test'])
  await runGit(['config', 'user.email', 'web-codex@example.test'])
})

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true })
})

describe('GitService status, diff, and history', () => {
  it('handles an empty repository and reports branch changes after a file is created', async () => {
    expect(await git.status(project.id)).toMatchObject({ branch: 'main', upstream: null, ahead: 0, behind: 0, clean: true, changes: [] })

    await writeFile(join(project.path, 'README.md'), '# Project\n')
    const status = await git.status(project.id)
    expect(status).toMatchObject({ branch: 'main', clean: false })
    expect(status.changes).toEqual([{ index: '?', worktree: '?', path: 'README.md' }])
    expect(await git.diff(project.id, { path: 'README.md' })).toEqual({ diff: '', truncated: false })
  })

  it('stages explicit paths, reads diffs, commits, and lists history and branches', async () => {
    await writeFile(join(project.path, 'first.txt'), 'first\n')
    await expect(git.stage(project.id, ['first.txt'])).resolves.toEqual({ staged: ['first.txt'] })
    expect((await git.diff(project.id, { staged: true })).diff).toContain('+first')

    const commit = await git.commit(project.id, 'Add first file')
    expect(commit).toMatchObject({ shortHash: commit.hash.slice(0, 8), subject: 'Add first file' })
    expect(commit.hash).toMatch(/^[a-f0-9]{40}$/)

    await writeFile(join(project.path, 'second.txt'), 'second\n')
    const second = await git.commit(project.id, 'Add second file', ['second.txt'])
    expect(second.subject).toBe('Add second file')
    expect(await git.log(project.id, 1)).toEqual([expect.objectContaining({ hash: second.hash, author: 'Web Codex Test', subject: 'Add second file' })])
    expect(await git.branches(project.id)).toEqual([expect.objectContaining({ name: 'main', current: true, remote: false })])
    expect((await git.diff(project.id, { base: 'HEAD~1' })).diff).toContain('second.txt')

    const worktreePath = join(temporaryDirectory, 'feature-worktree')
    await runGit(['worktree', 'add', worktreePath, '-b', 'feature'])
    const worktrees = await git.worktrees(project.id)
    expect(worktrees).toEqual(expect.arrayContaining([
      expect.objectContaining({ head: second.hash, branch: 'main', bare: false, prunable: false }),
      expect.objectContaining({ branch: 'feature', bare: false, prunable: false })
    ]))
  })

  it('creates and removes only project-contained registered worktrees', async () => {
    await writeFile(join(project.path, 'base.txt'), 'base\n')
    await git.stage(project.id, ['base.txt'])
    await git.commit(project.id, 'Base commit')

    await expect(git.addWorktree(project.id, '.worktrees/feature', 'feature', 'HEAD')).resolves.toEqual({ path: '.worktrees/feature', branch: 'feature', base: 'HEAD' })
    expect(await git.worktrees(project.id)).toEqual(expect.arrayContaining([expect.objectContaining({ branch: 'feature', bare: false })]))
    await expect(git.addWorktree(project.id, '.worktrees/feature', 'other', 'HEAD')).rejects.toMatchObject({ code: 'GIT_WORKTREE_EXISTS' })
    await expect(git.addWorktree(project.id, 'outside/feature', 'outside', 'HEAD')).rejects.toMatchObject({ code: 'GIT_WORKTREE_PATH_INVALID' })
    await expect(git.addWorktree(project.id, '.worktrees/bad', '..bad', 'HEAD')).rejects.toMatchObject({ code: 'GIT_BRANCH_INVALID' })
    await expect(git.removeWorktree(project.id, '.worktrees/missing')).rejects.toMatchObject({ code: 'GIT_WORKTREE_NOT_FOUND' })

    await expect(git.removeWorktree(project.id, '.worktrees/feature')).resolves.toEqual({ removed: '.worktrees/feature' })
    expect((await git.worktrees(project.id)).some((item) => item.branch === 'feature')).toBe(false)
  })

  it('lists and explicitly resolves only unmerged Git conflict paths', async () => {
    await writeFile(join(project.path, 'shared.txt'), 'base\n')
    await git.stage(project.id, ['shared.txt'])
    await git.commit(project.id, 'Base shared file')
    await runGit(['checkout', '-b', 'feature'])
    await writeFile(join(project.path, 'shared.txt'), 'feature\n')
    await git.commit(project.id, 'Feature version', ['shared.txt'])
    await runGit(['checkout', 'main'])
    await writeFile(join(project.path, 'shared.txt'), 'main\n')
    await git.commit(project.id, 'Main version', ['shared.txt'])
    await runGit(['merge', 'feature']).catch(() => undefined)

    expect(await git.conflicts(project.id)).toEqual(['shared.txt'])
    await expect(git.resolveConflicts(project.id, ['other.txt'], 'ours')).rejects.toMatchObject({ code: 'GIT_CONFLICT_NOT_FOUND' })
    await expect(git.resolveConflicts(project.id, ['shared.txt'], 'ours')).resolves.toEqual({ strategy: 'ours', resolved: ['shared.txt'] })
    expect((await readFile(join(project.path, 'shared.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('main\n')
    expect(await git.conflicts(project.id)).toEqual([])
    await runGit(['commit', '-m', 'Resolve shared conflict'])
  })

  it('rejects unsafe paths, invalid revisions, empty messages, and unavailable Git', async () => {
    await expect(git.stage(project.id, ['../outside.txt'])).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' })
    await expect(git.diff(project.id, { base: '--dangerous' })).rejects.toMatchObject({ code: 'GIT_REF_INVALID' })
    await expect(git.commit(project.id, '   ')).rejects.toMatchObject({ code: 'GIT_MESSAGE_INVALID' })

    const originalPath = process.env.PATH
    process.env.PATH = temporaryDirectory
    try {
      await expect(git.status(project.id)).rejects.toMatchObject({ code: 'GIT_UNAVAILABLE' })
    } finally {
      process.env.PATH = originalPath
    }
  })
})