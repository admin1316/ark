/**
 * Shared per-package tsdown configuration for host workspace bundles:
 * ESM single entry from src/index.ts, dts under lib/types/, `.js` output
 * extensions, workspace sources bundled, dependencies external.
 */
import { defineConfig } from 'tsdown'
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
  main?: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}
const external = [
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
]

// The orchestrator resolves each package's entry (its `main`, or
// src/index.ts for source packages) to an absolute path and passes it via
// TSDOWN_ENTRY — path anchoring never depends on the config location.
const entry = process.env.TSDOWN_ENTRY
if (entry === undefined || !existsSync(entry)) throw new Error('TSDOWN_ENTRY must name an existing source entry')
const packageRoot = process.cwd()

export default defineConfig({
  cwd: packageRoot,
  entry: [entry],
  outDir: resolve(packageRoot, 'lib'),
  clean: false,
  format: 'esm',
  dts: true,
  sourcemap: false,
  external,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  onSuccess: () => {
    // The exports map points declarations at lib/types/: relocate the
    // generated dts entry (index.d.ts -> types/index.d.ts).
    const generated = join('lib', 'index.d.ts')
    if (existsSync(generated)) {
      mkdirSync(join('lib', 'types'), { recursive: true })
      cpSync(generated, join('lib', 'types', 'index.d.ts'))
    }
  },
})
