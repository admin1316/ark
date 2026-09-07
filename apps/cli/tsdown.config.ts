import { defineConfig } from 'tsdown'

/**
 * The dsh CLI ships its generic `bin`. The root tsdown builds only
 * `lib/types/index.js`, so this override names the executable input.
 * Declarations come from `tsc -b` (dts: false), matching every package.
 */
export default defineConfig({
  entry: ['lib/types/bin.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
