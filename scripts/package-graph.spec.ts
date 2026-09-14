import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectPackageGraph } from './package-graph.ts'
import { generateModuleGraphs, renderModuleGraphs } from './gen-module-graph.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(packages: Readonly<Record<string, readonly string[]>>): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-package-graph-'))
  roots.push(root)
  for (const [name, dependencies] of Object.entries(packages)) {
    const directory = join(root, 'packages', 'client', name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), `${JSON.stringify({
      name: `@deepseek-ai/dsh-${name}`,
      peerDependencies: Object.fromEntries(dependencies.map(dependency => [
        `@deepseek-ai/dsh-${dependency}`,
        'workspace:^',
      ])),
    }, null, 2)}\n`)
  }
  return root
}

describe('collectPackageGraph', () => {
  it('orders packages after their dependencies', () => {
    const root = fixture({ application: ['feature'], feature: ['foundation'], foundation: [] })

    expect(collectPackageGraph(root, ['client'], 'fixture').map(pkg => pkg.short))
      .toEqual(['foundation', 'feature', 'application'])
  })

  it('keeps a dependency cycle together and before its consumers', () => {
    const root = fixture({ consumer: ['left'], left: ['right'], right: ['left'], foundation: [] })

    expect(collectPackageGraph(root, ['client'], 'fixture').map(pkg => pkg.short))
      .toEqual(['foundation', 'left', 'right', 'consumer'])
  })

  it('rejects a missing in-repo peer', () => {
    const root = fixture({ consumer: ['missing'] })

    expect(() => collectPackageGraph(root, ['client'], 'fixture'))
      .toThrow('fixture: @deepseek-ai/dsh-consumer references missing in-repo peer @deepseek-ai/dsh-missing')
  })
})

describe('bilingual module graph generation', () => {
  it('shares identical nodes, edges, package rows and links across languages', () => {
    const root = fixture({ consumer: ['foundation'], foundation: [] })
    const graph = collectPackageGraph(root, ['client'], 'fixture')
    const documents = renderModuleGraphs(graph)
    const english = documents['docs/module-graph.md']
    const chinese = documents['docs/module-graph.zh.md']
    const mermaid = (text: string): string | undefined => /```mermaid\n([\s\S]*?)```/.exec(text)?.[1]
    const rows = (text: string): string[] => text.split('\n').filter(line => line.startsWith('| [`'))
    expect(mermaid(english)).toContain('pkg_consumer --> pkg_foundation')
    expect(mermaid(chinese)).toBe(mermaid(english))
    expect(rows(chinese)).toEqual(rows(english))
    expect(rows(english)).toHaveLength(2)
    expect(english).toContain('English | [中文](module-graph.zh.md)')
    expect(chinese).toContain('[English](module-graph.md) | 中文')
    expect(chinese).toContain('# 模块依赖关系图')
    expect(chinese).toContain('| 包 | 分组 | 依赖 |')
  })

  it('reports missing/stale Chinese even when English is fresh, without writing during check', () => {
    const root = fixture({ consumer: ['foundation'], foundation: [] })
    mkdirSync(join(root, 'docs'))
    expect(generateModuleGraphs(root, true)).toEqual(['docs/module-graph.md', 'docs/module-graph.zh.md'])
    expect(generateModuleGraphs(root, false)).toEqual([])
    expect(generateModuleGraphs(root, true)).toEqual([])
    const chinese = join(root, 'docs/module-graph.zh.md')
    writeFileSync(chinese, '过期\n')
    expect(generateModuleGraphs(root, true)).toEqual(['docs/module-graph.zh.md'])
    expect(readFileSync(chinese, 'utf8')).toBe('过期\n')
    generateModuleGraphs(root, false)
    expect(generateModuleGraphs(root, true)).toEqual([])
    rmSync(chinese)
    expect(generateModuleGraphs(root, true)).toEqual(['docs/module-graph.zh.md'])
  })

  it('removes retired nodes from both documents using the existing manifest collector', () => {
    const root = fixture({ retained: [], retired: [] })
    mkdirSync(join(root, 'docs'))
    generateModuleGraphs(root, false)
    rmSync(join(root, 'packages', 'client', 'retired'), { recursive: true })
    expect(generateModuleGraphs(root, true)).toEqual(['docs/module-graph.md', 'docs/module-graph.zh.md'])
    generateModuleGraphs(root, false)
    for (const file of ['module-graph.md', 'module-graph.zh.md']) {
      const content = readFileSync(join(root, 'docs', file), 'utf8')
      expect(content).toContain('../packages/client/retained')
      expect(content).not.toContain('retired')
    }
  })
})
