/**
 * Compile the Host project graph before bundling its emitted JavaScript.
 * Existing bundles never substitute for missing or invalid TypeScript source.
 */
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const stages = [
  [join(root, 'node_modules/typescript/bin/tsc'), '-b', 'tsconfig.host.json', '--stopBuildOnErrors'],
  [join(root, 'node_modules/tsdown/dist/run.mjs'), '--config', 'tsdown.config.ts', '--env.DSH_BUILD_FACE=host'],
]
for (const [index, args] of stages.entries()) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' })
  if (result.error !== undefined || result.signal !== null || result.status !== 0) {
    console.error(`build-host-bundles: stage ${index + 1} failed: ${result.error?.message ?? result.signal ?? result.status}`)
    process.exit(result.status !== null && result.status !== 0 ? result.status : 1)
  }
}
console.log('build-host-bundles: current-source Host bundles built')
