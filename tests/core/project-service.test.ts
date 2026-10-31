import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '../../src/core/config-store'
import { ProjectService } from '../../src/core/project-service'

let temporaryDirectory: string
let store: ConfigStore
let projects: ProjectService

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'web-codex-projects-'))
  store = new ConfigStore(join(temporaryDirectory, 'config.json'))
  await store.load()
  projects = new ProjectService(store)
})

afterEach(async () => {
  await store.flush()
  await rm(temporaryDirectory, { recursive: true, force: true })
})

describe('ProjectService registration', () => {
  it('creates missing folders, trims names, and returns sorted project copies', async () => {
    const bravoPath = join(temporaryDirectory, 'bravo')
    const alphaPath = join(temporaryDirectory, 'alpha')
    const bravo = await projects.create({ name: '  Bravo  ', path: `${bravoPath}${requireSeparator()}nested`, enabled: false })
    const alpha = await projects.create({ path: alphaPath })

    expect(bravo).toMatchObject({ name: 'Bravo', enabled: false, path: bravo.path, remoteShell: { mode: 'allow', allowedPrefixes: [] } })
    expect(bravo.createdAt).toBe(bravo.updatedAt)
    expect(alpha.name).toBe(basename(alpha.path))
    expect(alpha.enabled).toBe(true)
    expect(projects.list().map((item) => item.name)).toEqual(['alpha', 'Bravo'])

    const listed = projects.list()
    listed[0].name = 'mutated'
    expect(projects.get(alpha.id).name).toBe('alpha')
    await expect(projects.root(bravo.id)).rejects.toMatchObject({ code: 'PROJECT_DISABLED' })
    await expect(projects.root(alpha.id)).resolves.toBe(alpha.path)
  })

  it('validates empty, duplicate, non-directory, and unknown projects', async () => {
    await expect(projects.create({ path: '  ' })).rejects.toMatchObject({ code: 'PROJECT_PATH_REQUIRED' })
    expect(() => projects.get('missing')).toThrowError(expect.objectContaining({ code: 'PROJECT_NOT_FOUND' }))

    const filePath = join(temporaryDirectory, 'file.txt')
    await writeFile(filePath, 'not a directory')
    await expect(projects.create({ path: filePath })).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(projects.create({ path: filePath, createDirectory: false })).rejects.toMatchObject({ code: 'PROJECT_NOT_DIRECTORY' })

    const project = await projects.create({ path: join(temporaryDirectory, 'unique') })
    const duplicatePath = process.platform === 'win32' ? project.path.toUpperCase() : project.path
    await expect(projects.create({ path: duplicatePath })).rejects.toMatchObject({ code: 'PROJECT_ALREADY_EXISTS' })
    await expect(projects.create({ path: join(temporaryDirectory, 'absent'), createDirectory: false })).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('updates project metadata and canonical paths while preserving registration history', async () => {
    const original = await projects.create({ path: join(temporaryDirectory, 'original') })
    const replacementPath = join(temporaryDirectory, 'replacement')
    await mkdir(replacementPath)
    await new Promise((resolve) => setTimeout(resolve, 5))

    const updated = await projects.update(original.id, {
      name: ' Renamed ',
      path: replacementPath,
      enabled: false,
      remoteShell: { mode: 'allowlist', allowedPrefixes: [' npm   test ', 'git status'] }
    })
    expect(updated).toMatchObject({
      id: original.id,
      name: 'Renamed',
      enabled: false,
      remoteShell: { mode: 'allowlist', allowedPrefixes: ['npm test', 'git status'] },
      createdAt: original.createdAt
    })
    expect(updated.path).not.toBe(original.path)
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(original.updatedAt))

    const unchanged = await projects.update(original.id, { path: replacementPath })
    expect(unchanged.name).toBe('Renamed')
    await expect(projects.update('missing', { name: 'x' })).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })

    const invalidFile = join(temporaryDirectory, 'invalid.txt')
    await writeFile(invalidFile, 'x')
    await expect(projects.update(original.id, { path: invalidFile })).rejects.toMatchObject({ code: 'PROJECT_NOT_DIRECTORY' })
  })

  it('removes only the registration and leaves the folder intact', async () => {
    const project = await projects.create({ path: join(temporaryDirectory, 'retained') })
    await projects.remove(project.id)

    expect(() => projects.get(project.id)).toThrowError(expect.objectContaining({ code: 'PROJECT_NOT_FOUND' }))
    await expect(readFile(join(store.filePath), 'utf8')).resolves.not.toContain(project.id)
    await expect(projects.remove(project.id)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })
  })

  it('applies the default remote shell policy to legacy project records', async () => {
    const project = await projects.create({ path: join(temporaryDirectory, 'legacy') })
    const legacy = { ...project }
    delete legacy.remoteShell
    store.update({ projects: [legacy] })

    expect(projects.get(project.id).remoteShell).toEqual({ mode: 'allow', allowedPrefixes: [] })
    expect(projects.list()[0].remoteShell).toEqual({ mode: 'allow', allowedPrefixes: [] })
  })
})

describe('ProjectService agent instructions', () => {
  it('prefers AGENTS.md, falls back to agent.md, and handles projects without instructions', async () => {
    const project = await projects.create({ path: join(temporaryDirectory, 'context') })
    await expect(projects.context(project.id)).resolves.toMatchObject({ instructions: '', instructionFile: null })

    await writeFile(join(project.path, 'agent.md'), 'fallback')
    await expect(projects.context(project.id)).resolves.toMatchObject({ instructions: 'fallback', instructionFile: 'agent.md' })

    await writeFile(join(project.path, 'AGENTS.md'), 'primary')
    await expect(projects.context(project.id)).resolves.toMatchObject({ instructions: 'primary', instructionFile: 'AGENTS.md' })
  })

  it('creates AGENTS.md or updates the existing instruction file', async () => {
    const first = await projects.create({ path: join(temporaryDirectory, 'new-instructions') })
    await expect(projects.saveInstructions(first.id, 'use npm test')).resolves.toMatchObject({ instructions: 'use npm test', instructionFile: 'AGENTS.md' })
    await expect(readFile(join(first.path, 'AGENTS.md'), 'utf8')).resolves.toBe('use npm test')

    const second = await projects.create({ path: join(temporaryDirectory, 'existing-instructions') })
    await writeFile(join(second.path, 'agent.md'), 'old')
    await projects.saveInstructions(second.id, 'new')
    await expect(readFile(join(second.path, 'agent.md'), 'utf8')).resolves.toBe('new')
    await expect(readFile(join(second.path, 'AGENTS.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

function requireSeparator(): string {
  return process.platform === 'win32' ? '\\' : '/'
}