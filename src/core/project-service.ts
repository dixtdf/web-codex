import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { Project, ProjectContext, RemoteShellPolicy } from '../shared/types'
import { AppError, assertCondition } from './errors'
import { ConfigStore } from './config-store'
import { normalizeRemoteShellPolicy } from './remote-shell-policy'

export interface ProjectInput {
  name?: string
  path: string
  enabled?: boolean
  remoteShell?: RemoteShellPolicy
  createDirectory?: boolean
}

export class ProjectService {
  constructor(private readonly store: ConfigStore) {}

  list(): Project[] {
    return this.store.get().projects
      .map((project) => ({ ...project, remoteShell: normalizeRemoteShellPolicy(project.remoteShell) }))
      .sort((a, b) => a.name.localeCompare(b.name))
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
      !config.projects.some((item) => item.path.toLowerCase() === canonicalPath.toLowerCase()),
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
      !config.projects.some((item) => item.id !== id && item.path.toLowerCase() === nextPath.toLowerCase()),
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
    return realpath(project.path)
  }

  async context(id: string): Promise<ProjectContext> {
    const project = this.get(id)
    for (const filename of ['AGENTS.md', 'agent.md']) {
      try {
        const instructions = await readFile(resolve(project.path, filename), 'utf8')
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
    const { writeFile } = await import('node:fs/promises')
    await writeFile(resolve(project.path, filename), content, 'utf8')
    return { project, instructions: content, instructionFile: filename }
  }
}