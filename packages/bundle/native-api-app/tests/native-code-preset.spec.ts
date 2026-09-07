/** Real Native Host composition for the shared Code preset and run_code. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { boot, healProfilesModuleFallback, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const basePatch = join(repoRoot, 'packages/bundle/base/cordis.patch.yml')
const nativePatch = join(repoRoot, 'packages/bundle/native-api-app/cordis.patch.yml')
const profilePatch = join(repoRoot, 'integrations/jiuzhang/profile/cordis.patch.yml')
const nativeRunnerAnchor = join(repoRoot, 'packages/boot/native-api-runner/package.json')
const sharedPresetRoot = join(repoRoot, 'packages/boot/profile-runner/config/agent-presets')

describe('Native Code preset composition', () => {
  let context: Context
  let home: string
  let previousHome: string | undefined

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-native-code-preset-'))
    previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    healProfilesModuleFallback(nativeRunnerAnchor, home)
    const profileDir = join(home, 'profiles', 'native-code')
    await mkdir(profileDir, { recursive: true })
    const rootConfig = join(profileDir, 'cordis.yml')
    await writeFile(rootConfig, '[]\n')
    const patches: PatchOptions[] = [
      ...loadOverlayPatches('dsh-native-test', basePatch),
      ...loadOverlayPatches('dsh-native-test', nativePatch),
      ...loadOverlayPatches('dsh-native-test', profilePatch),
      { id: 'settings', config: { path: join(home, 'settings.yaml'), watch: false } },
      { id: 'credentials', config: { mode: 'file' } },
      { id: 'storage-json', config: { root: join(home, 'storages') } },
      {
        id: 'knowledge-wiki',
        config: {
          wikiRoot: join(home, 'knowledge/wiki'),
          mainRoot: join(home, 'knowledge'),
          apiKey: '',
          llmProvider: 'deepseek-official',
          llmModel: 'deepseek-v4-flash',
        },
      },
      {
        id: 'agent-presets',
        config: {
          default: 'standard',
          roots: [{ path: sharedPresetRoot, trust: 'system' }],
          includeUserRoot: false,
        },
      },
      { id: 'webserver', disabled: true },
      { id: 'native-api-runtime', disabled: true },
      { id: 'host-connection', disabled: true },
      { id: 'native-events', disabled: true },
      { id: 'session-telemetry-otel', disabled: true },
    ]
    context = await boot('dsh-native-test', rootConfig, patches, (ctx) => {
      provideCmdline(ctx, { args: ['--port', '0'], exit: () => {} })
    })
  }, 120_000)

  afterAll(async () => {
    await context?.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (home !== undefined) await rm(home, { recursive: true, force: true })
  })

  it('mounts code while a standard Agent remains live without cross-preset Team registration', async () => {
    const standard = await context.agents.create({
      sessionId: SessionId('native-live-standard-before-code'),
      setup: agentCtx => context.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    try {
      const code = await context.agents.create({
        sessionId: SessionId('native-code-beside-live-standard'),
        setup: agentCtx => context.agentPresets.mount(agentCtx, 'code').then(() => undefined),
      })
      try {
        expect((await context.systemPrompt.assemble({ scope: standard.agent })).tools.map(tool => tool.name))
          .toEqual(expect.arrayContaining(['spawn_teammate', 'team_task_create']))
        expect((await context.systemPrompt.assemble({ scope: code.agent })).tools.map(tool => tool.name))
          .toEqual(['run_code'])
      } finally {
        await code.dispose()
      }

      await context.agentPresets.recompose(standard.agent.ctx, 'code')
      context.emit('agent-preset/selected', standard.agent.id, 'code')
      await Promise.resolve()
      expect((await context.systemPrompt.assemble({ scope: standard.agent })).tools.map(tool => tool.name))
        .toEqual(['run_code'])

      await context.agentPresets.recompose(standard.agent.ctx, 'standard')
      context.emit('agent-preset/selected', standard.agent.id, 'standard')
      await Promise.resolve()
      expect((await context.systemPrompt.assemble({ scope: standard.agent })).tools.map(tool => tool.name))
        .toEqual(expect.arrayContaining(['spawn_teammate', 'team_task_create']))
    } finally {
      await standard.dispose()
    }
  })

  it('mounts code without the CLI-only cordis preset and executes run_code', async () => {
    expect((await context.agentPresets.list()).map(preset => preset.id).sort())
      .toEqual(['code', 'minimal', 'standard'])
    const handle = await context.agents.create({
      sessionId: SessionId('native-code-preset'),
      setup: agentCtx => context.agentPresets.mount(agentCtx, 'code').then(() => undefined),
    })
    try {
      const assembly = await context.systemPrompt.assemble({ scope: handle.agent })
      expect(assembly.tools.map(tool => tool.name)).toEqual(['run_code'])
      const result = await context.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('native-code-run-1'),
        name: 'run_code',
        arguments: { code: 'return 7', description: 'Return the constant seven' },
        agent: handle.agent,
      })
      expect(result.error).toBeUndefined()
      expect(JSON.stringify(result.content)).toContain('7')
    } finally {
      await handle.dispose()
    }
  })

  it('keeps standard, minimal, and PTC tool catalogs scoped to their Native agents', async () => {
    const mount = async (sessionId: string, preset: 'standard' | 'minimal' | 'code') => {
      const handle = await context.agents.create({
        sessionId: SessionId(sessionId),
        setup: agentCtx => context.agentPresets.mount(agentCtx, preset).then(() => undefined),
      })
      try {
        return (await context.systemPrompt.assemble({ scope: handle.agent })).tools.map(tool => tool.name)
      } finally {
        await handle.dispose()
      }
    }

    const standard = await mount('native-standard-preset', 'standard')
    const minimal = await mount('native-minimal-preset', 'minimal')
    const code = await mount('native-code-preset', 'code')
    expect(new Set(standard).size).toBe(standard.length)
    expect(new Set(minimal).size).toBe(minimal.length)
    expect(standard).toEqual(expect.arrayContaining([
      'get_goal',
      'create_goal',
      'subagent',
      'subagent_fork',
      'workflow',
      'schedule_create',
      'schedule_list',
      'schedule_delete',
      'spawn_teammate',
      'list_agents',
      'team_task_create',
      'web_search',
      'web_fetch',
    ]))
    expect(minimal).toEqual(expect.arrayContaining(['bash', 'str_replace_editor']))
    for (const unavailable of [
      'get_goal',
      'create_goal',
      'subagent',
      'subagent_fork',
      'workflow',
    ]) {
      expect(minimal).not.toContain(unavailable)
    }
    for (const unavailable of [
      'schedule_create', 'schedule_list', 'schedule_delete',
      'spawn_teammate', 'list_agents', 'team_task_create',
      'web_search', 'web_fetch',
    ]) {
      expect(minimal).not.toContain(unavailable)
    }
    // PTC wraps the same standard-scoped catalog behind run_code; it must not
    // leak a second direct schedule/team surface into the presentation layer.
    expect(code).toEqual(['run_code'])
  })

  it('resolves the shipped standard fork tool as one-shot', async () => {
    const handle = await context.agents.create({
      sessionId: SessionId('native-standard-fork-policy'),
      setup: agentCtx => context.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    try {
      const definition = context.tools.get('subagent_fork', handle.agent)
      expect(definition).toBeDefined()
      expect(definition?.description).toContain('waits for the result by default')
      expect(definition?.description).not.toContain('durable subagent id')
      const parameters = definition?.parameters as {
        properties?: Record<string, { description?: string }>
      }
      expect(parameters.properties?.run_in_background?.description).toContain('Defaults to false')
    } finally {
      await handle.dispose()
    }
  })
})
