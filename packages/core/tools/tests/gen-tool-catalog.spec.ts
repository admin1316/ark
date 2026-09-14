/**
 * Guarantee tests for the tool-schema catalog generator (`scripts/gen-tool-catalog.ts`).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertManifestComplete,
  assertToolsHarvested,
  collectToolCatalog,
  render,
  type ToolCatalog,
  type ToolPackage,
} from '../../../../scripts/gen-tool-catalog.ts'

/** JSON Schema shape enough to reach the values AST extraction can't. */
interface JsonSchema {
  type: string
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  enum?: string[]
  required?: string[]
}

const TEAM_TOOL_NAMES = ['spawn_teammate', 'send_message', 'followup_task', 'list_agents', 'wait_agent',
  'interrupt_agent', 'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update']

describe('gen-tool-catalog collectToolCatalog', () => {
  it('harvests supported and experimental Team schemas from their separate real plugins', async () => {
    const catalog = await collectToolCatalog()
    const supported = catalog.find(entry => entry.pkg === '@deepseek-ai/dsh-tool-agent-team')
    const experimental = catalog.find(entry => entry.pkg === '@deepseek-ai/dsh-experimental-tool-agent-team')
    for (const entry of [supported, experimental]) {
      expect(entry?.schemas.map(schema => schema.name).sort()).toEqual([...TEAM_TOOL_NAMES].sort())
    }
    expect(supported?.sources).toEqual(Object.fromEntries(TEAM_TOOL_NAMES.map(name =>
      [name, 'packages/subagent/tool-agent-team/src/index.ts'])))
    expect(experimental?.sources).toEqual(Object.fromEntries(TEAM_TOOL_NAMES.map(name =>
      [name, 'packages/experimental/tool-agent-team/src/index.ts'])))
    const update = supported?.schemas.find(schema => schema.name === 'team_task_update')?.parameters
    expect(update).toMatchObject({
      required: ['task_id', 'expected_revision', 'action'],
      properties: {
        expected_revision: { type: 'integer' },
        action: { enum: ['claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete'] },
      },
    })
    const list = supported?.schemas.find(schema => schema.name === 'team_task_list')?.parameters
    expect(list).toMatchObject({ properties: { cursor: { type: 'integer' }, limit: { type: 'integer' } } })
  })

  it('boots every shipped tool package and harvests its model-facing schemas', async () => {
    const catalog = await collectToolCatalog()
    const names = catalog.flatMap(entry => entry.schemas.map(s => s.name)).sort()
    expect(names).toEqual([
      'ask_user_question', 'bash', 'bash', 'cordis_define', 'cordis_inspect_list',
      'cordis_inspect_query', 'cordis_inspect_self', 'cordis_run', 'cordis_stop',
      'cordis_undefine', 'create_goal', 'edit', 'exit_plan_mode', 'followup_task', 'get_goal', 'glob', 'grep',
      'interrupt_agent', 'interrupt_agent', 'job_kill', 'job_list', 'job_output',
      'list_agents', 'list_agents', 'list_subagent_models', 'lsp', 'pwsh', 'pwsh', 'ralph',
      'read', 'read_image', 'report', 'run_code', 'schedule_create', 'schedule_delete',
      'schedule_list', 'send_message', 'send_message', 'session_event_read', 'session_event_search',
      'session_event_trace', 'session_search', 'session_trace', 'skill', 'spawn_teammate',
      'str_replace_editor', 'subagent', 'team_task_create',
      'team_task_get', 'team_task_list', 'team_task_update', 'terminal_close', 'terminal_list',
      'terminal_open', 'terminal_read', 'terminal_send', 'terminal_signal', 'todo_write',
      'update_goal', 'wait_agent', 'web_fetch', 'web_search', 'workflow', 'write',
      ...TEAM_TOOL_NAMES,
    ].sort())
    // Every tool carries a JSON-Schema `parameters` object (what the model sees).
    for (const entry of catalog) {
      for (const schema of entry.schemas) {
        expect((schema.parameters as unknown as JsonSchema).type).toBe('object')
      }
    }
  })

  it('resolves a runtime-spread enum to its literal members (the payoff over AST)', async () => {
    const catalog = await collectToolCatalog()
    const todo = catalog
      .flatMap(entry => entry.schemas)
      .find(s => s.name === 'todo_write')
    // `todo-todo` writes `enum: [...STATUSES]` — a source AST would see the
    // spread, not the values. Booting yields the shipped enum literals.
    const status = (((todo?.parameters as unknown as JsonSchema).properties?.todos)?.items)?.properties?.status
    expect(status?.enum).toEqual(['pending', 'in_progress', 'completed'])
  })

  it('attributes each harvested tool with its registering plugin source', async () => {
    const catalog = await collectToolCatalog()
    const bash = catalog.find(entry => entry.pkg === '@deepseek-ai/dsh-tool-bash')
    expect(bash?.sources.bash).toBe('packages/shell/tool-bash/src/index.ts')
    const control = catalog.find(entry => entry.pkg === '@deepseek-ai/dsh-tool-subagent-control')
    expect(control?.sources).toEqual({
      interrupt_agent: 'packages/subagent/tool-subagent-control/src/index.ts',
      list_agents: 'packages/subagent/tool-subagent-control/src/list-agents.ts',
      send_message: 'packages/subagent/tool-subagent-control/src/index.ts',
    })
  })

  it('harvests search tools without depending on the generator process PATH', async () => {
    const oldPath = process.env.PATH
    try {
      process.env.PATH = ''
      const catalog = await collectToolCatalog()
      const search = catalog.find(entry => entry.pkg === '@deepseek-ai/dsh-tool-fs-search')
      expect(search?.schemas.map(s => s.name).sort()).toEqual(['glob', 'grep'])
    } finally {
      if (oldPath === undefined) delete process.env.PATH
      else process.env.PATH = oldPath
    }
  })

  it('records the shipped `subagent_fork` alias in a note (config-driven tool name)', async () => {
    // `tool-subagent`'s registered name is the load-time `toolName` config, so the shipped
    // agents surface this one package as both `subagent` and `subagent_fork`.
    const catalog = await collectToolCatalog()
    const subagent = catalog.find(entry => entry.pkg === '@deepseek-ai/dsh-tool-subagent')
    expect(subagent?.schemas.map(s => s.name)).toEqual(['list_subagent_models', 'subagent'])
    expect(subagent?.note).toMatch(/subagent_fork/)
  })
})

describe('gen-tool-catalog assertManifestComplete', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })
  function fixture(entries: readonly { dir: string; pkg: string }[]): { root: string; packages: ToolPackage[] } {
    const root = mkdtempSync(join(tmpdir(), 'tool-manifest-'))
    roots.push(root)
    for (const entry of entries) {
      const dir = join(root, entry.dir)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: entry.pkg }))
    }
    return { root, packages: entries.map(entry => ({
      ...entry, source: `${entry.dir}/src/index.ts`, requires: [], writes: [], mount: () => Promise.resolve(),
    })) }
  }

  it('requires both same-basename packages and normalizes their complete relative paths', () => {
    const run = fixture([
      { dir: 'packages/experimental/tool-team', pkg: '@fixture/experimental-team' },
      { dir: 'packages/subagent/tool-team', pkg: '@fixture/team' },
    ])
    expect(() => { assertManifestComplete(run.packages.slice(0, 1), run.root) })
      .toThrow(/not in the boot manifest: packages\/subagent\/tool-team/)
    expect(() => { assertManifestComplete(run.packages, run.root) }).not.toThrow()
    expect(() => { assertManifestComplete(run.packages.map(entry => ({
      ...entry, dir: entry.dir.replaceAll('/', '\\'),
    })), run.root) }).not.toThrow()
  })

  it('rejects duplicate directory or package identities even when all disk paths are listed', () => {
    const run = fixture([{ dir: 'packages/a/tool-demo', pkg: '@fixture/demo' }])
    expect(() => { assertManifestComplete([...run.packages, ...run.packages], run.root) })
      .toThrow(/duplicate boot directory 'packages\/a\/tool-demo'/)
    const sameName = fixture([
      { dir: 'packages/a/tool-demo', pkg: '@fixture/demo' },
      { dir: 'packages/b/tool-demo', pkg: '@fixture/demo' },
    ])
    expect(() => { assertManifestComplete(sameName.packages, sameName.root) })
      .toThrow(/duplicate boot package '@fixture\/demo'/)
  })

  it('rejects a catalog identity that disagrees with the real package manifest', () => {
    const run = fixture([{ dir: 'packages/a/tool-demo', pkg: '@fixture/demo' }])
    expect(() => { assertManifestComplete(run.packages.map(entry => ({ ...entry, pkg: '@fixture/wrong' })), run.root) })
      .toThrow(/does not match package.json name '@fixture\/demo'/)
    expect(() => { assertManifestComplete(run.packages.map(entry => ({ ...entry, dir: 'tool-demo' })), run.root) })
      .toThrow(/use its complete packages/)
  })

  it('passes when the manifest lists every on-disk tool package (the default)', () => {
    expect(() => { assertManifestComplete() }).not.toThrow()
  })

  it('throws, naming the omitted package, when a tool package is missing from the manifest', () => {
    // An empty manifest scanned against the real tree: every `tool-*` package
    // is unlisted, so the guard must fire and name them.
    expect(() => { assertManifestComplete([]) }).toThrow(/not in the boot manifest/)
    expect(() => { assertManifestComplete([]) }).toThrow(/tool-bash/)
  })
})

describe('gen-tool-catalog assertToolsHarvested', () => {
  const entry: ToolPackage = {
    pkg: '@deepseek-ai/dsh-tool-demo',
    dir: 'packages/demo/tool-demo',
    source: 'packages/demo/tool-demo/src/index.ts',
    requires: ['ctx.tools', 'ctx.somethingUnmounted'],
    writes: ['tool/result'],
    mount: () => Promise.resolve(),
  }

  it('accepts a boot that registered at least one tool', () => {
    expect(() => { assertToolsHarvested(entry, 1) }).not.toThrow()
  })

  it('throws, naming the package and its requirements, when a boot registers nothing', () => {
    // The failure this guards is silent by construction: the package is in the
    // manifest, its plugin merely stays PENDING on an unmounted service, and the
    // catalog would ship without its tools while every gate stays green.
    expect(() => { assertToolsHarvested(entry, 0) }).toThrow(/@deepseek-ai\/dsh-tool-demo booted without registering a single tool/)
    expect(() => { assertToolsHarvested(entry, 0) }).toThrow(/ctx.somethingUnmounted/)
  })
})

describe('gen-tool-catalog render', () => {
  it('emits a package heading, a tool heading, and a json schema fence', () => {
    const catalog: ToolCatalog = [
      {
        pkg: '@deepseek-ai/dsh-tool-demo',
        sources: { demo: 'packages/demo/tool-demo/src/index.ts' },
        requires: ['ctx.tools'],
        writes: ['tool/result'],
        schemas: [{ name: 'demo', description: 'A demo tool.', parameters: { type: 'object', properties: {} } }],
      },
    ]
    const md = render(catalog)
    expect(md).toContain('| `@deepseek-ai/dsh-tool-demo` | `demo` | `ctx.tools` | `tool/result` |')
    expect(md).toContain('## `@deepseek-ai/dsh-tool-demo`')
    expect(md).toContain('### `demo`')
    expect(md).toContain('A demo tool.')
    expect(md).toContain('```json')
    expect(md).toContain('Source: [`packages/demo/tool-demo/src/index.ts`]')
  })
})
