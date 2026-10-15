import { expect, it } from 'vitest'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createNativePresetRuntime } from './native-preset-runtime.ts'

const nativePlatform = process.platform === 'win32' ? 'windows' : 'unix'
for (const platform of ['unix', 'windows'] as const) {
  it.skipIf(platform !== nativePlatform)(`projects the shipped Native roster, scoped capabilities and a real run_code result > ${platform}`, async () => {
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
      const shell = platform === 'windows' ? 'pwsh' : 'bash'
      expect(catalogs.minimal).toContain(shell)
      expect(catalogs.standard).toContain(shell)
      expect(catalogs.minimal).not.toContain(shell === 'pwsh' ? 'bash' : 'pwsh')
      expect(catalogs.standard).not.toContain(shell === 'pwsh' ? 'bash' : 'pwsh')
      expect(catalogs.code).toEqual(['run_code'])
      expect({ roster, catalogs, forkDescription, codeResult }).toMatchSnapshot()
    } finally { await runtime.dispose() }
  })
}
