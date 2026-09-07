import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import KnowledgeWikiService from '../src/index.ts'

interface ProjectSurface {
  snapshots: { dispose(): void }
  currentRoot: string
  listProjects(): Promise<{ projects: Array<{ path: string }>; current: string }>
  createProject(request: { name: string; path: string }): Promise<{ path: string; error?: string }>
  removeProject(request: { path: string }): Promise<{ projects: Array<{ path: string }>; current: string }>
  pageContent(request: { path: string }): Promise<{ path: string; content: string }>
  computeGraph(): Promise<unknown>
  graphInsights(): Promise<Record<string, unknown[]>>
  list(): Promise<unknown[]>
  lint(): Promise<{ brokenLinks: unknown[]; emptyPages: string[]; totalPages: number }>
  exportProject(): Promise<{ path: string; error?: string }>
}

let root: string
let ctx: Context
let service: ProjectSurface

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wiki-project-edges-'))
  mkdirSync(join(root, 'wiki'), { recursive: true })
  ctx = new Context()
  service = new KnowledgeWikiService(ctx, {
    wikiRoot: join(root, 'wiki'), mainRoot: root,
    credential: 'VISION_API_KEY', llmProvider: 'p', llmModel: 'm',
  }) as unknown as ProjectSurface
})

afterEach(async () => {
  service.snapshots.dispose()
  await ctx.fiber.dispose()
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('workspace registry validation', () => {
  it('accepts missing workspaces fields and rejects every malformed row shape', async () => {
    const parentDefaultContext = new Context()
    const parentDefault = new KnowledgeWikiService(parentDefaultContext, {
      wikiRoot: join(root, 'default-main', 'wiki'), mainRoot: '',
      credential: 'VISION_API_KEY', llmProvider: 'p', llmModel: 'm',
    }) as unknown as ProjectSurface
    expect((await parentDefault.listProjects()).current).toBe(join(root, 'default-main'))
    parentDefault.snapshots.dispose()
    await parentDefaultContext.fiber.dispose()
    const registry = join(root, '.llm-wiki', 'workspaces.json')
    mkdirSync(dirname(registry), { recursive: true })
    writeFileSync(registry, '{}', 'utf8')
    expect((await service.listProjects()).projects).toHaveLength(1)

    for (const value of [
      [null],
      [{}],
      [{ path: '', name: 'n' }],
      [{ path: '/p', name: '' }],
      [{ path: 1, name: 'n' }],
      [{ path: '/p', name: 1 }],
    ]) {
      writeFileSync(registry, JSON.stringify({ workspaces: value }), 'utf8')
      await expect(service.listProjects()).rejects.toThrow('invalid knowledge project registry entry')
    }
  })

  it('validates creation inputs, preserves existing files, dedupes registration, and reports filesystem errors', async () => {
    const emptyName = await service.createProject({ name: ' ', path: '/tmp/x' })
    expect(emptyName.path).toBe('')
    expect(emptyName.error).toBeTruthy()
    const emptyPath = await service.createProject({ name: 'X', path: ' ' })
    expect(emptyPath.path).toBe('')
    expect(emptyPath.error).toBeTruthy()
    expect(await service.createProject({ name: 'Main', path: root + '/' })).toEqual({ path: '', error: '主工作区已存在' })

    const external = mkdtempSync(join(tmpdir(), 'wiki-project-existing-'))
    try {
      mkdirSync(join(external, 'wiki'), { recursive: true })
      writeFileSync(join(external, 'wiki', 'index.md'), 'KEEP INDEX', 'utf8')
      writeFileSync(join(external, 'wiki', 'log.md'), 'KEEP LOG', 'utf8')
      writeFileSync(join(external, 'purpose.md'), 'KEEP PURPOSE', 'utf8')
      writeFileSync(join(external, 'schema.md'), 'KEEP SCHEMA', 'utf8')
      expect(await service.createProject({ name: 'External', path: external + '/' })).toEqual({ path: external })
      expect(await service.createProject({ name: 'Renamed', path: external })).toEqual({ path: external })
      const switcher = service as unknown as {
        setProject(request: { path: string }): Promise<{ current: string }>
        list(): Promise<unknown[]>
      }
      expect((await switcher.setProject({ path: external })).current).toBe(external)
      await switcher.list()
      await switcher.setProject({ path: root })
      expect(readFileSync(join(external, 'wiki', 'index.md'), 'utf8')).toBe('KEEP INDEX')
      expect((await service.listProjects()).projects.map(project => project.path)).toEqual([root, external])
    } finally {
      rmSync(external, { recursive: true, force: true })
    }

    const blocked = join(root, 'blocked-project')
    writeFileSync(blocked, 'file', 'utf8')
    expect((await service.createProject({ name: 'Blocked', path: blocked })).error).toBeTruthy()
  })

  it('leaves state unchanged when removing an unknown workspace', async () => {
    const result = await service.removeProject({ path: '/not/registered/' })
    expect(result.projects.map(project => project.path)).toEqual([root])
    expect(result.current).toBe(root)
  })

  it('does not switch to the already-active main project and removes an inactive registration', async () => {
    expect((await (service as unknown as { setProject(request: { path: string }): Promise<{ current: string }> })
      .setProject({ path: root })).current).toBe(root)
    const external = mkdtempSync(join(tmpdir(), 'wiki-project-inactive-'))
    try {
      expect(await service.createProject({ name: 'External', path: external })).toEqual({ path: external })
      const removed = await service.removeProject({ path: external })
      expect(removed.current).toBe(root)
    } finally {
      rmSync(external, { recursive: true, force: true })
    }
  })
})

describe('path, diagnostics, and export failure edges', () => {
  it('rejects symlink traversal through the page surface', async () => {
    const outside = join(root, 'outside.md')
    writeFileSync(outside, 'secret', 'utf8')
    symlinkSync(outside, join(root, 'wiki', 'linked.md'))
    await expect(service.pageContent({ path: 'linked.md' })).rejects.toThrow('symbolic link is not allowed')
  })

  it('propagates graph insight and lint owner failures', async () => {
    vi.spyOn(service, 'computeGraph').mockRejectedValueOnce(new Error('graph failed'))
    await expect(service.graphInsights()).rejects.toThrow('graph failed')
    vi.spyOn(service, 'list').mockRejectedValueOnce(new Error('list failed'))
    await expect(service.lint()).rejects.toThrow('list failed')
  })

  it('reports export failure from an incomplete current project', async () => {
    service.currentRoot = join(root, 'missing-project')
    const result = await service.exportProject()
    expect(result.path).toBe('')
    expect(result.error).toBeTruthy()
  })
})
