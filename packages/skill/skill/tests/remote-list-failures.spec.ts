import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import SkillRegistry from '@deepseek-ai/dsh-skill'

function scopedSkills(ctx: Context): SkillRegistry {
  const skills = ctx.get('skills')
  if (skills === undefined) throw new Error('skills service missing')
  return skills
}

function remoteAgent(scope: ReturnType<typeof createScope>): Agent {
  return { id: 'remote-session', session: { header: { cwd: '/workspace' } }, ctx: scope.ctx } as unknown as Agent
}

describe('remoteList failure surfaces', () => {
  it('reports cancellation when the signal aborts while the catalog resolves', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const scope = createScope(ctx, { preset: 'remote' })
    const controller = new AbortController()
    scopedSkills(scope.ctx).registerProvider(() => ({
      name: 'remote-test',
      list: async () => {
        controller.abort()
        return []
      },
      get: async () => { throw new Error('catalog must not read bodies') },
    }))
    await expect(ctx.skills.remoteList(remoteAgent(scope), controller.signal))
      .rejects.toMatchObject({ code: 'cancelled' })
  })

  it('stringifies a non-Error catalog failure into the internal failure', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const scope = createScope(ctx, { preset: 'remote' })
    // A malformed observation (not an array) makes the registry's own
    // validation throw through remoteList's catch.
    scopedSkills(scope.ctx).registerProvider(() => ({
      name: 'remote-test',
      list: async () => ({ nope: true }),
      get: async () => { throw new Error('catalog must not read bodies') },
    }))
    await expect(ctx.skills.remoteList(remoteAgent(scope), new AbortController().signal))
      .rejects.toMatchObject({ code: 'internal', message: /skill listing failed: / })
  })
})
