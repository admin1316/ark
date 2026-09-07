/**
 * Build every host workspace package's `lib` bundle, then verify the Host
 * TypeScript project references. Idempotent three-tier orchestration:
 *   1. a package already carrying lib/index.js is accepted as-is (restored
 *      compiled artifacts are the shipped truth);
 *   2. a package with src/index.ts builds itself via its own tsdown config
 *      (or the shared one), keyed by the absolute entry through TSDOWN_ENTRY;
 *   3. otherwise the package's compiled lib is restored from the reference
 *      runtime (the installed application's node_modules).
 * Any package that cannot satisfy a tier fails the run.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const referenceRoot = process.env.TSDOWN_REFERENCE_ROOT ?? ''
if (referenceRoot === '') throw new Error('build-host-bundles: TSDOWN_REFERENCE_ROOT is required (the reference runtime node_modules/@deepseek-ai)')

type Project = { name: string; group: string; directory: string }

function walk(dir: string, depth: number, projects: Project[]): void {
  if (depth < 0) return
  const manifest = join(dir, 'package.json')
  if (existsSync(manifest)) {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }
    if (typeof parsed.name === 'string') {
      const relative = dir.slice(root.length + 1)
      const group = relative.startsWith('vendor/')
        ? `vendor/${relative.slice(7).split('/')[0]}`
        : relative.startsWith('native/')
          ? `native/${relative.slice(7).split('/')[0]}`
          : `dsh/${relative.split('/')[0]}`
      projects.push({ name: parsed.name, group, directory: dir })
    }
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    walk(join(dir, entry.name), depth - 1, projects)
  }
}

const projects: Project[] = []
for (const base of ['packages', 'vendor', 'apps', 'native/landlock-run/packages', 'python/sdk-runtime']) {
  const baseDir = join(root, base)
  if (existsSync(baseDir)) walk(baseDir, 2, projects)
}
projects.sort((left, right) => left.name.localeCompare(right.name))

const total = projects.length
let index = 0
const failed: string[] = []
for (const project of projects) {
  index += 1
  const libEntry = join(project.directory, 'lib', 'index.js')
  if (existsSync(libEntry)) {
    console.log(`build-host-bundles: [${index}/${total}] ${project.name} (${project.group}) already built`)
    continue
  }
  console.log(`build-host-bundles: [${index}/${total}] ${project.name} (${project.group})`)
  const manifest = JSON.parse(readFileSync(join(project.directory, 'package.json'), 'utf8')) as { main?: string }
  const entry = resolve(project.directory, manifest.main ?? 'src/index.ts')
  const hasSource = existsSync(join(project.directory, 'src', 'index.ts'))
  const ownConfig = existsSync(join(project.directory, 'tsdown.config.ts'))

  if (hasSource || ownConfig) {
    const build = spawnSync('npx', ['tsdown', ...(ownConfig ? [] : ['--config', join(root, 'scripts/tsdown-host-package.config.ts')])], {
      cwd: project.directory,
      encoding: 'utf8',
      env: { ...process.env, npm_config_ignore_scripts: 'true', TSDOWN_ENTRY: entry },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (build.status !== 0 || !existsSync(libEntry)) {
      const detail = [build.stdout, build.stderr].filter(Boolean).join('\n').trim()
      console.error(`build-host-bundles: ${project.name} build failed\n${detail.slice(-1500)}`)
      failed.push(project.name)
      continue
    }
    continue
  }

  const referenceLib = join(referenceRoot, project.name.slice('@deepseek-ai/'.length), 'lib')
  if (existsSync(join(referenceLib, 'index.js'))) {
    cpSync(referenceLib, join(project.directory, 'lib'), { recursive: true })
    console.log(`build-host-bundles: [${index}/${total}] ${project.name} (${project.group}) restored from reference runtime`)
    continue
  }
  console.error(`build-host-bundles: ${project.name} has no lib, no src/index.ts, and no reference lib`)
  failed.push(project.name)
}
if (failed.length > 0) {
  throw new Error(`build-host-bundles: ${failed.length} package builds failed: ${failed.join(', ')}`)
}

const typecheck = spawnSync('npx', ['tsc', '--noEmit', '-p', join(root, 'tsconfig.host.json')], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})
if (typecheck.status !== 0) {
  const detail = [typecheck.stdout, typecheck.stderr].filter(Boolean).join('\n').trim()
  console.error(`build-host-bundles: FAIL Host TypeScript project references\n${detail.slice(-4000)}`)
  process.exit(2)
}
console.log('build-host-bundles: PASS Host TypeScript project references')
