import { readdir, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

async function sourceFiles(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: URL[] = []
  for (const entry of entries) {
    const url = new URL(entry.name, directory)
    if (entry.isDirectory()) files.push(...await sourceFiles(new URL(`${entry.name}/`, directory)))
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(url)
  }
  return files
}

describe('Host Connection ownership', () => {
  it('has no ApiProxy source, type, context, or package dependency', async () => {
    const root = new URL('../', import.meta.url)
    const files = await sourceFiles(new URL('src/', root))
    const source = (await Promise.all(files.map(file => readFile(file, 'utf8')))).join('\n')
    const buildGraph = await readFile(new URL('tsconfig.json', root), 'utf8')
    const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    expect(`${source}\n${buildGraph}`)
      .not.toMatch(/\b(?:apiProxy|ApiProxy|toFetchHandler)\b|dsh-host-apiproxy/)
    expect({
      ...manifest.dependencies,
      ...manifest.peerDependencies,
      ...manifest.devDependencies,
    }).not.toHaveProperty('@deepseek-ai/dsh-host-apiproxy')
  })
})
