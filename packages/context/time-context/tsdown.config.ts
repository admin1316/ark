import { defineConfig } from 'tsdown'
import type { UserConfig } from 'tsdown'

const shared: UserConfig = {
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}

/** Build the root and invariant separately; keep the LLM barrel external so
 * its decorated Remote services are loaded from their already-built package. */
export default defineConfig([
  { ...shared, entry: ['lib/types/index.js'] },
  {
    ...shared,
    entry: ['lib/types/invariant.js'],
    deps: { neverBundle: ['@deepseek-ai/dsh-llm'] },
  },
])
