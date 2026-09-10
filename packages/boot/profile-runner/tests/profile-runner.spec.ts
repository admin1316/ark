import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SHIPPED_PRESET_ROOT } from '../src/index.ts'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

describe('shared profile runner assets', () => {
  it('owns exactly the Native-safe shared preset roster', () => {
    const presets = readdirSync(SHIPPED_PRESET_ROOT, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
    expect(presets).toEqual(['code', 'minimal', 'standard'])
  })

  it('ships the preset root once and carries no browser product or Client edge', () => {
    const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
      files?: string[]
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    expect(manifest.files?.filter(file => file === 'config' || file === 'config/agent-presets')).toEqual(['config'])
    const edges = Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    })
    expect(edges).not.toContain('@deepseek-ai/dsh-web-app')
    expect(edges).not.toContain('@deepseek-ai/dsh-headless')
    expect(edges.filter(name => name.startsWith('@deepseek-ai/dsh-client-'))).toEqual([])
    expect(edges).not.toContain('@deepseek-ai/dsh-tool-cordis')
  })
})
