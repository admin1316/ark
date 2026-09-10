import { existsSync, globSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

interface Manifest {
  name: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

it('includes every native runtime workspace in the Host compiler aggregate', () => {
  const root = resolve(import.meta.dirname, '..')
  const packages = new Map<string, { directory: string; manifest: Manifest }>()
  for (const file of globSync('packages/*/*/package.json', { cwd: root })) {
    const manifest = JSON.parse(readFileSync(join(root, file), 'utf8')) as Manifest
    packages.set(manifest.name, { directory: dirname(file), manifest })
  }
  const profile = JSON.parse(readFileSync(join(root, 'integrations/jiuzhang/profile/package.json'), 'utf8')) as {
    dsh: { profile: { bundles: string[] } }
  }
  const pending = ['@deepseek-ai/dsh-native-api-runner', ...profile.dsh.profile.bundles]
  const reachable = new Set<string>()
  while (pending.length > 0) {
    const name = pending.pop()!
    if (reachable.has(name)) continue
    reachable.add(name)
    const entry = packages.get(name)
    expect(entry, `missing native runtime workspace ${name}`).toBeDefined()
    if (entry === undefined) continue
    for (const dependency of Object.keys({
      ...entry.manifest.dependencies, ...entry.manifest.peerDependencies, ...entry.manifest.optionalDependencies,
    })) {
      if (packages.has(dependency)) pending.push(dependency)
    }
  }
  const parsed = ts.parseConfigFileTextToJson('tsconfig.host.json', readFileSync(join(root, 'tsconfig.host.json'), 'utf8'))
  expect(parsed.error).toBeUndefined()
  const config = parsed.config as { references: { path: string }[] }
  const references = new Set(config.references.map(reference =>
    resolve(root, reference.path).replace(/\/tsconfig[^/]*\.json$/, '')))
  const missingSources: string[] = []
  for (const name of reachable) {
    const directory = resolve(root, packages.get(name)!.directory)
    if (!existsSync(join(directory, 'tsconfig.json')) || !existsSync(join(directory, 'src/index.ts'))) missingSources.push(name)
    expect(references.has(directory), `native workspace missing from Host build: ${name}`).toBe(true)
  }
  expect(missingSources, 'native runtime packages need source and compiler projects, not just retained lib files').toEqual([])
})
