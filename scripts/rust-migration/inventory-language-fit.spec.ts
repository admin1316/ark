import { describe, expect, it } from 'vitest'
import { declaredSurfaces, sourceRole } from './inventory-language-fit.ts'

describe('language census declaration boundaries', () => {
  it('finds aliased and bare Remote decorators while ignoring text and undecorated methods', () => {
    const surfaces = declaredSurfaces('index.ts', `
import { Remote as Rpc } from '@deepseek-ai/dsh-typert-registry'
// @Remote('ghost')
const text = "ctx.tools.register({name: 'ghost'})"
class Service {
  @Rpc('search') run() {}
  @Remote list() {}
  @Rpc({ mode: 'stream' }) events() {}
  @api.Remote('other') qualified() {}
  helper() {}
}
`)
    expect(surfaces.filter(surface => surface.kind === 'remote').map(surface => surface.name)).toEqual([
      'Service.search', 'Service.list', 'Service.events', 'Service.other',
    ])
    expect(surfaces.filter(surface => surface.kind.startsWith('tool'))).toEqual([])
    expect(surfaces.find(surface => surface.name === 'Service.search')?.line).toBe(6)
  })

  it('keeps direct, wrapped, aliased, computed-access and unresolved registration forms visible', () => {
    const surfaces = declaredSurfaces('index.ts', `
import { defineTool as tool } from '@deepseek-ai/dsh-tools'
ctx.tools.register({ name: 'plain' })
ctx.tools.register(tool({ name: 'aliased' }))
ctx['commands']['register']({ name: 'compact' })
ctx.commands.register({ name: config.commandName })
ctx.tools.register(dynamicDefinition)
ctx.tools.register(factory({ name: 'not-resolved' }))
ctx.other.register({ name: 'unrelated' })
`)
    expect(surfaces.filter(surface => surface.kind === 'tool-registration').map(surface => [surface.name, surface.resolution])).toEqual([
      ['plain', 'literal'], ['aliased', 'literal'], ['dynamicDefinition', 'expression'],
      ["factory({ name: 'not-resolved' })", 'expression'],
    ])
    expect(surfaces.filter(surface => surface.kind === 'tool-declaration').map(surface => surface.name)).toEqual(['aliased'])
    expect(surfaces.filter(surface => surface.kind === 'command').map(surface => [surface.name, surface.resolution])).toEqual([
      ['compact', 'literal'], ['config.commandName', 'expression'],
    ])
  })

  it('enumerates nested callable implementations without pretending each is a user feature', () => {
    const surfaces = declaredSurfaces('index.mjs', `
export function outer() { function inner() {} }
const fn = () => 1
class Local { helper() {} }
const object = { method() {} }
`)
    expect(surfaces.map(surface => surface.name)).toEqual(['outer', 'inner', 'fn', 'Local.helper', '<object>.method'])
  })

  it.each([
    ['packages/core/session/src/index.ts', '', 'runtime'],
    ['packages/core/session/src/invariant.ts', '', 'runtime'],
    ['packages/examples/sdk-jsonrpc-demo/src/index.ts', '', 'runtime'],
    ['integrations/jiuzhang/native/Sources/App.swift', '', 'runtime'],
    ['integrations/jiuzhang/native/Sources/JiuzhangShellContractTests/main.swift', '', 'test'],
    ['integrations/jiuzhang/native/Tests/AppTests.swift', '', 'test'],
    ['integrations/jiuzhang/native/Package.swift', '', 'tooling'],
    ['packages/core/session/tests/index.ts', '', 'test'],
    ['apps/cli/tests/fixtures/plugin.ts', '', 'test'],
    ['packages/core/session/src/index.spec.ts', '', 'test'],
    ['packages/extensions/tool-cordis/src/api-catalog.ts', '// GENERATED', 'generated'],
    ['rust/search/target/generated.rs', '', 'generated'],
    ['packages/test-support/llm-replay/src/index.ts', '', 'tooling'],
    ['integrations/jiuzhang/src/runtime-plan.mjs', '', 'tooling'],
    ['website/.vitepress/config.ts', '', 'tooling'],
  ] as const)('retains %s in its explicit coverage role', (file, source, role) => {
    expect(sourceRole(file, source)).toBe(role)
  })
})
