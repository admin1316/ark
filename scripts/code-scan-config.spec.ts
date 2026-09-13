/** Keep source-analysis boundaries independent of stale build output and dynamic Loader imports. */
import { spawnSync } from 'node:child_process'
import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, matchesGlob, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isCordisGroupEntry, loadCordisYaml } from './cordis-yaml.ts'

const root = resolve(import.meta.dirname, '..')
interface WorkspaceScan { entry: string[]; project: string[] }
const knip = JSON.parse(readFileSync(join(root, 'knip.json'), 'utf8')) as {
  workspaces: Record<string, WorkspaceScan>
}

/** Resolve the actual package-specific override, not an imagined merge with the glob default. */
function workspaceScan(owner: string): WorkspaceScan {
  const config = knip.workspaces[owner] ?? knip.workspaces['packages/*/*']
  if (config === undefined) throw new Error(`missing source scan config for ${owner}`)
  return config
}

/** Match a file while respecting explicit negative patterns. */
function included(file: string, patterns: string[]): boolean {
  return patterns.some(pattern => !pattern.startsWith('!') && matchesGlob(file, pattern))
    && !patterns.some(pattern => pattern.startsWith('!') && matchesGlob(file, pattern.slice(1)))
}

/** Collect only executable Loader rows; arbitrary strings inside plugin config are not imports. */
function localPlugins(value: unknown, file: string): string[] {
  if (Array.isArray(value)) return value.flatMap(row => localPlugins(row, file))
  if (typeof value !== 'object' || value === null) return []
  const row = value as Record<string, unknown>
  const paths: string[] = []
  if (typeof row.name === 'string' && row.name.startsWith('.') && /\.[cm]?tsx?$/.test(row.name)) {
    const target = resolve(dirname(file), row.name)
    if (existsSync(target)) paths.push(relative(root, target))
  }
  if (isCordisGroupEntry(row)) paths.push(...localPlugins(row.config, file))
  if (Array.isArray(row.insert)) paths.push(...localPlugins(row.insert, file))
  return paths
}

describe('source analysis boundaries', () => {
  it('includes every live package source and test without treating generated lib as source', () => {
    const sources = globSync('packages/*/*/{src,tests}/**/*.{ts,tsx}', { cwd: root })
    expect(sources.length).toBeGreaterThan(500)
    for (const source of sources) {
      const owner = source.split('/').slice(0, 3).join('/')
      const config = workspaceScan(owner)
      expect(config.project, owner).toBeDefined()
      expect(included(source.slice(owner.length + 1), config.project), source).toBe(true)
      expect(included('lib/types/index.d.ts', config.project), owner).toBe(false)
      expect(included('lib/types/obsolete-client.js', config.project), owner).toBe(false)
    }
    // A hand-owned nested lib directory is still source; only package output is excluded.
    expect(included('src/lib/hand-owned.ts', workspaceScan('packages/core/session').project)).toBe(true)
  })

  it('keeps actual relative YAML fixture imports as Knip entry points', () => {
    const files = globSync(['packages/**/*cordis*.yml', 'apps/**/*cordis*.yml'], {
      cwd: root,
      exclude: ['**/node_modules/**', '**/lib/**'],
    })
    const plugins = new Set(files.flatMap(file => localPlugins(
      loadCordisYaml(readFileSync(join(root, file), 'utf8')), join(root, file),
    )))
    expect(plugins.size).toBeGreaterThan(10)
    for (const plugin of plugins) {
      // Published plugin entry points are already derived from package exports by Knip.
      if (!plugin.includes('/tests/')) continue
      const owner = /^(packages\/[^/]+\/[^/]+|apps\/[^/]+)/.exec(plugin)?.[0]
      if (owner === undefined) continue
      const local = plugin.slice(owner.length + 1)
      expect(included(local, workspaceScan(owner).entry), plugin).toBe(true)
    }
  })

  it('does not promote arbitrary config strings into entry points or evaluate expressions', () => {
    const file = join(root, 'packages/core/session/cordis.yml')
    expect(localPlugins(loadCordisYaml(`- name: ordinary-plugin
  config:
    name: './src/index.ts'
    script: !!js "throw new Error('must remain data')"
`), file)).toEqual([])
  })

  it('ignores generated clones but still rejects identical source and script clones', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'source-scan-contract-'))
    const source = Array.from({ length: 20 }, (_, index) =>
      `export const value${index} = (input: number): number => input * ${index + 1} + ${index + 9}`,
    ).join('\n')
    const write = (file: string): void => {
      const target = join(fixture, file)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, source)
    }
    const run = (): ReturnType<typeof spawnSync> => spawnSync(process.execPath, [
      join(root, 'node_modules/jscpd/run-jscpd.js'), '--config', join(root, '.jscpd.json'), 'packages', 'scripts',
    ], { cwd: fixture, encoding: 'utf8' })
    try {
      mkdirSync(join(fixture, 'scripts'))
      write('packages/group/one/src/original.ts')
      write('packages/group/one/lib/types/generated.d.ts')
      write('packages/group/two/lib/types/generated.d.ts')
      const generated = run()
      expect(generated.error).toBeUndefined()
      expect(generated.status, String(generated.stdout) + String(generated.stderr)).toBe(0)
      write('packages/group/two/src/copy.ts')
      const duplicate = run()
      expect(duplicate.status, String(duplicate.stdout) + String(duplicate.stderr)).toBe(1)
      expect(String(duplicate.stdout)).toContain('src/copy.ts')
      rmSync(join(fixture, 'packages/group/two/src/copy.ts'))
      write('scripts/lib/hand-owned.ts')
      const script = run()
      expect(script.status, String(script.stdout) + String(script.stderr)).toBe(1)
      expect(String(script.stdout)).toContain('hand-owned.ts')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
