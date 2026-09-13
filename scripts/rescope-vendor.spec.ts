/**
 * Acceptance-path coverage for the rescope codemod's exact-edit classifier: a
 * duplicated insertion — what a non-idempotent apply produces — must be
 * rejected rather than applied again.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { exactEditState, rescopeText } from './rescope-vendor.ts'

const ANCHOR = '\n## Sync procedure'
const INSERTED = `\n15. **rescope**: one log entry.\n${ANCHOR}`

const runtimeOwners = [
  'apps/cli/config/agent-presets/cordis/agent.cordis.yml',
  'integrations/jiuzhang/tests/profile.test.mjs',
  'packages/examples/acp-demo/tests/built-bin.e2e.ts',
  'packages/experimental/inspector/src/shared/bridge/messages/cordis.ts',
  'packages/experimental/inspector/tests/cordis-query.host.spec.ts',
  'packages/experimental/inspector/tests/cordis-tree.host.spec.ts',
  'packages/experimental/inspector/lib/index.js',
  'packages/experimental/inspector/lib/worker.js',
  'packages/experimental/inspector/lib/types/shared/bridge/messages/cordis.js',
  'packages/experimental/inspector/lib/types/shared/bridge/messages/cordis.d.ts',
  'packages/extensions/tool-cordis/lib/index.js',
  'packages/extensions/tool-cordis/lib/types/providers.js',
  'vendor/schemastery/lib/index.cjs',
  'vendor/schemastery/lib/index.mjs',
  'vendor/schemastery/lib/types/index.js',
]

describe('runtime identifiers are not npm specifiers', () => {
  it.each(runtimeOwners)('preserves %s but still checks real dependencies in the same file', (file) => {
    const text = readFileSync(resolve(import.meta.dirname, '..', file), 'utf8')
    expect(rescopeText(text, file)).toEqual({ text, lines: 0 })
    const old = [
      "import 'cordis'", "export { Context } from 'cordis/tree'", "require('schemastery')",
      "import('cosmokit')", 'name: cordis', 'name: @cordisjs/plugin-loader',
    ].join('\n')
    const scoped = [
      "import '@deepseek-ai/cordis'", "export { Context } from '@deepseek-ai/cordis/tree'",
      "require('@deepseek-ai/schemastery')", "import('@deepseek-ai/cosmokit')",
      'name: @deepseek-ai/cordis', 'name: @deepseek-ai/cordis-plugin-loader',
    ].join('\n')
    const result = rescopeText(`${text}\n${old}`, file)
    expect(result.text).toBe(`${text}\n${scoped}`)
    expect(result.lines).toBe(6)
    expect(rescopeText(result.text, file)).toEqual({ text: result.text, lines: 0 })
  })

  it.each([
    ['packages/experimental/inspector/lib/worker.js', 'const CORDIS_TREE_TOPIC = "cordis/tree";'],
    ['packages/experimental/inspector/tests/cordis-tree.host.spec.ts', "const row = { topic: 'cordis/tree' };"],
    ['packages/extensions/tool-cordis/lib/index.js', 'event.name.startsWith("cordis/");'],
    ['vendor/schemastery/lib/index.cjs', 'const k = Symbol.for("schemastery"); const s = { vendor: "schemastery" };'],
  ])('checks adjacent same-line imports for %s', (file, expression) => {
    const original = `${expression} require('cordis/tree'); require('schemastery');`
    const scoped = `${expression} require('@deepseek-ai/cordis/tree'); require('@deepseek-ai/schemastery');`
    expect(rescopeText(original, file).text).toBe(scoped)
    expect(rescopeText(scoped, file, true).text).toBe(original)
  })

  it('does not preserve the same spelling outside the documented owner/context', () => {
    expect(rescopeText("const topic = 'cordis/tree'", 'packages/other/src/index.ts').text)
      .toBe("const topic = '@deepseek-ai/cordis/tree'")
    expect(rescopeText("const other = 'cordis/tree'", runtimeOwners[3] ?? '').text)
      .toBe("const other = '@deepseek-ai/cordis/tree'")
  })
})

describe('exactEditState', () => {
  it('classifies an insertion by its target form, so a duplicate is invalid', () => {
    expect(exactEditState(`log\n${ANCHOR}\n`, ANCHOR, INSERTED, 1)).toBe('pending')
    expect(exactEditState(`log${INSERTED}\n`, ANCHOR, INSERTED, 1)).toBe('applied')
    // The anchor survives an insertion, so counting the source form would have
    // called this pending and inserted the entry a second time.
    expect(exactEditState(`log${INSERTED}${INSERTED}\n`, ANCHOR, INSERTED, 1)).toBe('invalid')
    expect(exactEditState('log\n', ANCHOR, INSERTED, 1)).toBe('invalid')
  })

  it('classifies a deletion by its source form, and requires its remainder to survive', () => {
    const remainder = 'exclude:\n'
    const withEntries = 'exclude:\n  - cordis@4\n'
    expect(exactEditState(withEntries, withEntries, remainder, 1)).toBe('pending')
    expect(exactEditState(remainder, withEntries, remainder, 1)).toBe('applied')
    // Upstream dropped the whole field: the source form is gone, but so is the
    // remainder, so this is a moved site rather than a completed deletion.
    expect(exactEditState('unrelated:\n', withEntries, remainder, 1)).toBe('invalid')
  })

  it('requires a replacement to leave no source form and the exact target count', () => {
    expect(exactEditState('a = 1\n', 'a = 1', 'b = 2', 1)).toBe('pending')
    expect(exactEditState('b = 2\n', 'a = 1', 'b = 2', 1)).toBe('applied')
    expect(exactEditState('b = 2\nb = 2\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
    // A moved or partially applied site: neither state is complete.
    expect(exactEditState('a = 1\nb = 2\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
    expect(exactEditState('x\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
  })
})
