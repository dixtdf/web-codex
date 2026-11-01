import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Project, ProjectContext, RemoteShellPolicy } from '../shared/types'
import { AppError, assertCondition, errorMessage } from './errors'
import { ConfigStore } from './config-store'
import { normalizeRemoteShellPolicy } from './remote-shell-policy'

export interface ProjectInput {
  name?: string
  path: string
  enabled?: boolean
  remoteShell?: RemoteShellPolicy
  createDirectory?: boolean
}

function sameProjectPath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

export class ProjectService {
  constructor(private readonly store: ConfigStore) {}

  list(): Project[] {
    return this.store.get().projects
      .map((project) => ({ ...project, remoteShell: normalizeRemoteShellPolicy(project.remoteShell) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async listWithHealth(): Promise<Array<Project & { health: { accessible: boolean; status: 'ready' | 'unavailable'; error: string | null } }>> {
    return Promise.all(this.list().map(async (project) => {
      try {
        const canonicalPath = await realpath(project.path)
        const info = await stat(canonicalPath)
        assertCondition(info.isDirectory(), 'Project path is no longer a directory', 'PROJECT_NOT_DIRECTORY')
        return { ...project, health: { accessible: true, status: 'ready' as const, error: null } }
      } catch (error) {
        return { ...project, health: { accessible: false, status: 'unavailable' as const, error: errorMessage(error) } }
      }
    }))
  }

  get(id: string): Project {
    const project = this.store.get().projects.find((item) => item.id === id)
    if (!project) {
      throw new AppError(`Project not found: ${id}`, 'PROJECT_NOT_FOUND')
    }
    return { ...project, remoteShell: normalizeRemoteShellPolicy(project.remoteShell) }
  }

  async create(input: ProjectInput): Promise<Project> {
    assertCondition(input.path.trim().length > 0, 'Project folder is required', 'PROJECT_PATH_REQUIRED')
    const requestedPath = resolve(input.path.trim())
    if (input.createDirectory !== false) {
      await mkdir(requestedPath, { recursive: true })
    }
    const info = await stat(requestedPath)
    assertCondition(info.isDirectory(), 'Project path must be a directory', 'PROJECT_NOT_DIRECTORY')
    const canonicalPath = await realpath(requestedPath)
    const config = this.store.get()
    assertCondition(
      !config.projects.some((item) => sameProjectPath(item.path, canonicalPath)),
      'This folder is already registered',
      'PROJECT_ALREADY_EXISTS'
    )
    const now = new Date().toISOString()
    const project: Project = {
      id: randomUUID(),
      name: input.name?.trim() || basename(canonicalPath),
      path: canonicalPath,
      enabled: input.enabled ?? true,
      remoteShell: normalizeRemoteShellPolicy(input.remoteShell),
      createdAt: now,
      updatedAt: now
    }
    this.store.update({ projects: [...config.projects, project] })
    await this.store.flush()
    return project
  }

  async update(id: string, patch: Partial<ProjectInput>): Promise<Project> {
    const current = this.get(id)
    let nextPath = current.path
    if (patch.path && resolve(patch.path) !== current.path) {
      const info = await stat(resolve(patch.path))
      assertCondition(info.isDirectory(), 'Project path must be a directory', 'PROJECT_NOT_DIRECTORY')
      nextPath = await realpath(resolve(patch.path))
    }
    const updated: Project = {
      ...current,
      name: patch.name?.trim() || current.name,
      path: nextPath,
      enabled: patch.enabled ?? current.enabled,
      remoteShell: patch.remoteShell === undefined ? current.remoteShell : normalizeRemoteShellPolicy(patch.remoteShell),
      updatedAt: new Date().toISOString()
    }
    const config = this.store.get()
    assertCondition(
      !config.projects.some((item) => item.id !== id && sameProjectPath(item.path, nextPath)),
      'This folder is already registered',
      'PROJECT_ALREADY_EXISTS'
    )
    this.store.update({ projects: config.projects.map((item) => item.id === id ? updated : item) })
    await this.store.flush()
    return updated
  }

  async remove(id: string): Promise<void> {
    this.get(id)
    const config = this.store.get()
    this.store.update({ projects: config.projects.filter((item) => item.id !== id) })
    await this.store.flush()
  }

  async root(id: string): Promise<string> {
    const project = this.get(id)
    assertCondition(project.enabled, 'Project is disabled', 'PROJECT_DISABLED')
    const root = await realpath(project.path)
    const info = await stat(root)
    assertCondition(info.isDirectory(), 'Project path is no longer a directory', 'PROJECT_NOT_DIRECTORY')
    return root
  }

  private async instructionPath(project: Project, filename: string): Promise<string> {
    const root = await this.root(project.id)
    const target = resolve(root, filename)
    const assertInside = (candidate: string): void => {
      const pathFromRoot = relative(root, candidate)
      assertCondition(pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot)), 'Instruction file leaves the project folder', 'PATH_OUTSIDE_PROJECT')
    }
    assertInside(await realpath(dirname(target)))
    try {
      assertInside(await realpath(target))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return target
  }

  async context(id: string): Promise<ProjectContext> {
    const project = this.get(id)
    for (const filename of ['AGENTS.md', 'agent.md']) {
      const target = await this.instructionPath(project, filename)
      try {
        const instructions = await readFile(target, 'utf8')
        return { project, instructions, instructionFile: filename }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
    }
    return { project, instructions: '', instructionFile: null }
  }

  async saveInstructions(id: string, content: string): Promise<ProjectContext> {
    const project = this.get(id)
    const context = await this.context(id)
    const filename = context.instructionFile ?? 'AGENTS.md'
    const target = await this.instructionPath(project, filename)
    await writeFile(target, content, 'utf8')
    return { project, instructions: content, instructionFile: filename }
  }
}