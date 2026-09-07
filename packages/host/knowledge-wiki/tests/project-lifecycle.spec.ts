import { Context } from '@deepseek-ai/cordis'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import KnowledgeWikiService from '../src/index.ts'
import type { IngestQueueSnapshot, IngestQueueTask } from '../src/types.ts'

interface ProjectLifecycleService {
  createProject(request: { name: string; path: string }): Promise<{ path: string; error?: string }>
  listProjects(): Promise<{
    projects: Array<{ path: string; name: string; main?: boolean }>
    current: string
  }>
  setProject(request: { path: string }): Promise<{ current: string }>
  removeProject(request: { path: string }): Promise<{
    projects: Array<{ path: string; name: string; main?: boolean }>
    current: string
  }>
  enqueueIngest(input: string, force?: boolean): boolean
  ingestQueueStatus(): Promise<IngestQueueSnapshot>
  queue: IngestQueueTask[]
}

let root: string
let external: string
let ctx: Context
let service: ProjectLifecycleService

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kw-project-main-'))
  external = mkdtempSync(join(tmpdir(), 'kw-project-external-'))
  mkdirSync(join(root, 'wiki'), { recursive: true })
  writeFileSync(join(root, 'wiki', 'index.md'), '# Main Wiki\n')
  writeFileSync(join(external, 'keep.txt'), 'KEEP_LOCAL_FILE')
  ctx = new Context()
  service = new KnowledgeWikiService(ctx, {
    wikiRoot: join(root, 'wiki'),
    mainRoot: root,
    credential: 'VISION_API_KEY',
    llmProvider: 'p',
    llmModel: 'm',
  }) as unknown as ProjectLifecycleService
})

afterEach(async () => {
  await ctx.fiber.dispose()
  rmSync(root, { recursive: true, force: true })
  rmSync(external, { recursive: true, force: true })
})

describe('knowledge project lifecycle', () => {
  it('unregisters an external project, cancels pending work, and preserves every local file', async () => {
    const created = await service.createProject({ name: 'External', path: external })
    expect(created).toEqual({ path: external })
    expect(existsSync(join(external, 'wiki', 'index.md'))).toBe(true)
    expect(existsSync(join(external, 'purpose.md'))).toBe(true)

    await service.setProject({ path: external })
    writeFileSync(join(external, 'raw', 'sources', 'pending.md'), 'PENDING_SOURCE')
    expect(service.enqueueIngest('pending.md')).toBe(true)

    const removed = await service.removeProject({ path: external })
    expect(removed.current).toBe(root)
    expect(removed.projects.map(project => project.path)).toEqual([root])
    expect(service.queue.filter(task => task.projectRoot === external))
      .toEqual([expect.objectContaining({ input: 'pending.md', status: 'cancelled' })])

    expect(readFileSync(join(external, 'keep.txt'), 'utf8')).toBe('KEEP_LOCAL_FILE')
    expect(readFileSync(join(external, 'raw', 'sources', 'pending.md'), 'utf8')).toBe('PENDING_SOURCE')
    expect(existsSync(join(external, 'wiki', 'index.md'))).toBe(true)

    // A stale client cannot resurrect an unregistered project merely because
    // its preserved wiki directory still exists.
    expect(await service.setProject({ path: external })).toEqual({ current: root })
    expect((await service.listProjects()).projects.map(project => project.path)).toEqual([root])

    const registry = join(root, '.llm-wiki', 'workspaces.json')
    expect(JSON.parse(readFileSync(registry, 'utf8'))).toEqual({ workspaces: [] })
    expect(statSync(registry).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(root, '.llm-wiki')).some(name => name.includes('.ark-save-'))).toBe(false)
  })

  it('keeps the main project non-removable', async () => {
    const result = await service.removeProject({ path: root })
    expect(result.current).toBe(root)
    expect(result.projects).toEqual([{ path: root, name: '万相织鉴', main: true }])
    expect(existsSync(join(root, 'wiki', 'index.md'))).toBe(true)
  })

  it('fails closed instead of overwriting a malformed registry', async () => {
    const registry = join(root, '.llm-wiki', 'workspaces.json')
    mkdirSync(join(registry, '..'), { recursive: true })
    writeFileSync(registry, '{"workspaces":"broken"}', 'utf8')

    await expect(service.listProjects()).rejects.toThrow('invalid knowledge project registry')
    const created = await service.createProject({ name: 'External', path: external })
    expect(created.error).toContain('invalid knowledge project registry')
    expect(readFileSync(registry, 'utf8')).toBe('{"workspaces":"broken"}')
    expect(existsSync(join(external, 'wiki'))).toBe(false)
  })
})
