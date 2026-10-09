import { expect, it } from 'vitest'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createNativePresetRuntime } from './native-preset-runtime.ts'

it('projects the shipped Native roster, scoped capabilities and a real run_code result', async () => {
  const runtime = await createNativePresetRuntime()
  const ctx = runtime.context
  try {
    const roster = (await ctx.agentPresets.list()).map(preset => preset.id).sort()
    const catalogs: Record<string, string[]> = {}
    let codeResult: unknown
    let forkDescription: string | undefined
    for (const preset of ['standard', 'minimal', 'code']) {
      const handle = await ctx.agents.create({ sessionId: SessionId(`native-preset-snapshot-${preset}`),
        setup: agentCtx => ctx.agentPresets.mount(agentCtx, preset).then(() => undefined) })
      try {
        catalogs[preset] = (await ctx.systemPrompt.assemble({ scope: handle.agent })).tools.map(tool => tool.name).sort()
        if (preset === 'standard') forkDescription = ctx.tools.get('subagent_fork', handle.agent)?.description
        if (preset === 'code') {
          const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: CallId('native-preset-snapshot-code'),
            name: 'run_code', arguments: { code: 'return 7', description: 'Return seven' }, agent: handle.agent })
          codeResult = { content: result.content, error: result.error }
          expect(result.error).toBeUndefined()
        }
      } finally { await handle.dispose() }
    }
    const expectedShell = process.platform === 'win32' ? 'pwsh' : 'bash'
    expect(catalogs.minimal).toContain(expectedShell)
    expect(catalogs.standard).toContain(expectedShell)
    const snapshotCatalogs = Object.fromEntries(Object.entries(catalogs).map(([preset, tools]) => [
      preset, tools.map(tool => tool === 'bash' || tool === 'pwsh' ? 'local-shell' : tool),
    ]))
    expect({ roster, catalogs: snapshotCatalogs, forkDescription, codeResult }).toMatchSnapshot()
  } finally { await runtime.dispose() }
})
