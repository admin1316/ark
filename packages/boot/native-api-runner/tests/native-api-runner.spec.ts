import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ARK_NATIVE_API_PROFILE } from '../src/index.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('Ark native API runner', () => {
  it('has one fixed profile and no generic or browser dispatch', () => {
    const source = readFileSync(resolve(root, 'src/index.ts'), 'utf8')
    const bin = readFileSync(resolve(root, 'src/bin.ts'), 'utf8')
    expect(ARK_NATIVE_API_PROFILE).toBe('jiuzhang')
    expect(source).toContain('watchLiveConfig: false')
    expect(source).toContain('patchFiles: []')
    expect(source).toContain("profilePatchMode: 'managed'")
    expect(source).toContain("homePatchMode: 'none'")
    expect(source).not.toMatch(/dsh-web-app|dsh-headless|parseDshArgs|runPlugin|runDumpConfig/)
    expect(bin).not.toMatch(/Commander|parseDshArgs|switch\s*\(/)
  })

  it('declares no generic CLI, browser product, headless, or Client package edge', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Record<string, unknown>
    const edgeTables = ['dependencies', 'optionalDependencies', 'peerDependencies']
    const edges = edgeTables.flatMap(key => Object.keys(
      (manifest[key] as Record<string, string> | undefined) ?? {},
    ))
    expect(edges).not.toContain('@deepseek-ai/dsh')
    expect(edges).not.toContain('@deepseek-ai/dsh-web-app')
    expect(edges).not.toContain('@deepseek-ai/dsh-headless')
    expect(edges.filter(name => name.startsWith('@deepseek-ai/dsh-client-'))).toEqual([])
  })
})
