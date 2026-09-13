import { defineConfig } from 'tsdown'
import { typertPlugin } from './packages/typert/generator/lib/types/tsdown-plugin.js'

/** Bundle verified Host JavaScript after build-host-bundles generates reflection in its own process. */
export default defineConfig(({ env }) => {
  if (env?.DSH_BUILD_FACE !== undefined && env.DSH_BUILD_FACE !== 'host') {
    throw new Error('tsdown: only the Host build face is supported')
  }
  return {
    workspace: ['vendor/*', 'packages/*/*', 'apps/cli'],
    entry: ['lib/types/{index,invariant,startup}.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    plugins: [typertPlugin({ mode: 'transform-only' })],
  }
})
