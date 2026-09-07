import { describe, expect, it } from 'vitest'
import { sedimentTarget } from '../src/auto-sediment.ts'

describe('sedimentTarget', () => {
  it('returns the workspace wiki for a non-main workspace cwd', () => {
    const target = sedimentTarget('/Users/hui/技能强化', '/Users/hui/ark')
    expect(target).toEqual({ wikiRoot: '/Users/hui/技能强化/wiki', workspaceName: '技能强化' })
  })

  it('skips the main workspace (batch ingest covers it)', () => {
    expect(sedimentTarget('/Users/hui/ark', '/Users/hui/ark')).toBeNull()
  })

  it('skips a session without cwd', () => {
    expect(sedimentTarget(undefined, '/Users/hui/ark')).toBeNull()
  })

  it('skips a cwd nested under the main root (main-library sessions are batch-ingested; would pollute the tree)', () => {
    expect(sedimentTarget('/Users/hui/ark/deepseek-harness', '/Users/hui/ark')).toBeNull()
  })

  it('skips a cwd that merely starts with the same prefix but is not under the main root', () => {
    const target = sedimentTarget('/Users/hui/ark-draft', '/Users/hui/ark')
    expect(target).toEqual({ wikiRoot: '/Users/hui/ark-draft/wiki', workspaceName: 'ark-draft' })
  })
})
