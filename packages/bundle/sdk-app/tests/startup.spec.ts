import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { apply, Config, SDK_APP_STARTUP_SERVICE } from '../src/index.ts'

interface StdinBoundary {
  readonly readableEnded: boolean
  once(event: 'end', listener: () => void): unknown
  off(event: 'end', listener: () => void): unknown
}

function fakeStdin(): StdinBoundary {
  return {
    readableEnded: false,
    once: () => undefined,
    off: () => undefined,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

function mockProcessStdin(input: StdinBoundary): void {
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as typeof process.stdin)
}

function mockProcessOutput(output: { write(chunk: string): unknown }): void {
  vi.spyOn(process, 'stdout', 'get').mockReturnValue(output as typeof process.stdout)
  vi.spyOn(process, 'stderr', 'get').mockReturnValue(output as typeof process.stderr)
}

describe('SDK app startup', () => {
  it('accepts its zero-option command, publishes readiness, and binds stdin to bounded shutdown', async () => {
    const ctx = new Context()
    const exits: number[] = []
    mockProcessStdin(fakeStdin())
    provideCmdline(ctx, { args: [], exit: (code) => { exits.push(code) } })

    apply(ctx)

    expect(ctx.get(SDK_APP_STARTUP_SERVICE)).toEqual({ accepted: true })
    expect(exits).toEqual([])
    await ctx.fiber.dispose()
  })

  it('renders the selected profile in help and does not claim stdio readiness', async () => {
    const ctx = new Context()
    const exits: number[] = []
    let out = ''
    mockProcessStdin(fakeStdin())
    mockProcessOutput({ write: (text: string) => { out += text; return true } })
    provideCmdline(ctx, { args: ['--help'], exit: (code) => { exits.push(code) } })

    apply(ctx, { profile: 'custom-sdk' })

    expect(out).toContain('dsh --profile custom-sdk')
    expect(ctx.get(SDK_APP_STARTUP_SERVICE)).toBeUndefined()
    expect(exits).toEqual([0])
    await ctx.fiber.dispose()
  })

  it('rejects unknown options without exposing a partially started SDK service', async () => {
    const ctx = new Context()
    const exits: number[] = []
    mockProcessStdin(fakeStdin())
    mockProcessOutput({ write: () => true })
    provideCmdline(ctx, { args: ['--not-an-option'], exit: (code) => { exits.push(code) } })

    apply(ctx)

    expect(ctx.get(SDK_APP_STARTUP_SERVICE)).toBeUndefined()
    expect(exits).toEqual([1])
    await ctx.fiber.dispose()
  })

  it('validates and defaults its profile configuration', () => {
    expect(new Config({})).toEqual({ profile: 'sdk' })
    expect(new Config({ profile: 'named-sdk' })).toEqual({ profile: 'named-sdk' })
  })
})
