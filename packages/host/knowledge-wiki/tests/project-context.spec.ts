import { describe, expect, it } from 'vitest'
import { createProjectExecutionContext } from '../src/project-context.ts'

describe('ProjectExecutionContext', () => {
  it('freezes main and external workspace identities at task start', () => {
    const main = createProjectExecutionContext('/ark', '/ark', '/ark/wiki-main', 4)
    const external = createProjectExecutionContext('/skills', '/ark', '/ark/wiki-main', 5)

    expect(main).toMatchObject({ projectRoot: '/ark', wikiRoot: '/ark/wiki-main', generation: 4 })
    expect(external).toMatchObject({ projectRoot: '/skills', wikiRoot: '/skills/wiki', generation: 5 })
    expect(Object.isFrozen(main)).toBe(true)
    expect(Object.isFrozen(external)).toBe(true)
  })
})
