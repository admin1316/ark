import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import * as AcpApp from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

function mockProcessOutput(output: { write(chunk: string): unknown }): void {
  vi.spyOn(process, 'stdout', 'get').mockReturnValue(output as typeof process.stdout)
  vi.spyOn(process, 'stderr', 'get').mockReturnValue(output as typeof process.stderr)
}

describe('ACP app startup', () => {
  it('publishes readiness and owns the stdin EOF listener for a serving invocation', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const exits: number[] = []
    provideCmdline(ctx, { args: [], exit: code => void exits.push(code) })
    const before = process.stdin.listenerCount('end')

    const fiber = await ctx.plugin(AcpApp)
    expect(ctx.get(AcpApp.ACP_APP_STARTUP_SERVICE)).toEqual({ accepted: true })
    expect(process.stdin.listenerCount('end')).toBe(before + 1)
    expect(exits).toEqual([])

    await fiber.dispose()
    expect(ctx.get(AcpApp.ACP_APP_STARTUP_SERVICE)).toBeUndefined()
    expect(process.stdin.listenerCount('end')).toBe(before)
  })

  it('prints help and exits without publishing startup or claiming stdin', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const exits: number[] = []
    let output = ''
    const sink = { write: (chunk: string) => { output += chunk; return true } }
    mockProcessOutput(sink)
    provideCmdline(ctx, { args: ['--help'], exit: code => void exits.push(code) })
    const before = process.stdin.listenerCount('end')

    await ctx.plugin(AcpApp)
    expect(output).toContain('Usage: dsh --profile acp')
    expect(output).toContain('serve ACP until the client disconnects')
    expect(exits).toEqual([0])
    expect(ctx.get(AcpApp.ACP_APP_STARTUP_SERVICE)).toBeUndefined()
    expect(process.stdin.listenerCount('end')).toBe(before)
  })
})
