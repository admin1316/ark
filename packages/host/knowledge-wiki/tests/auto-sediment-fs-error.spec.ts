import { describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: () => { throw new Error('filesystem unavailable') },
  }
})

import { pageExists } from '../src/auto-sediment.ts'

describe('sediment filesystem boundary', () => {
  it('reports existence probing failures instead of presenting a missing page', () => {
    expect(() => pageExists('/wiki', 'page.md')).toThrow('filesystem unavailable')
  })
})
