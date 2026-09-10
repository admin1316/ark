import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as SessionRemoteOperationsInvariant from '../src/invariant.ts'

describe('session-remote-operations invariant companion', () => {
  it('registers the package-owned installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(SessionRemoteOperationsInvariant)
    await expect(fiber.await()).resolves.toBeDefined()
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
