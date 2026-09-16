/** Reject coverage exclusions that no longer select a regular repository file. */

import { globSync, lstatSync } from 'node:fs'
import { resolve } from 'node:path'
import { coverageExcludeEntries } from './coverage-exclude.ts'

// A killed oxlint contract can leave temporary source probes behind; successful
// runs remove them in finally. No other dead exclusion is intentional.
const temporaryProbeGuard = 'packages/*/*/src/oxlint-contract-*.ts'

/**
 * Find stale exclusion patterns without importing the Vitest configuration.
 * @param root - Repository (or fixture) directory to inspect.
 * @param entries - The complete exclusion list to validate.
 * @returns Every non-guard pattern with no regular-file match.
 */
export function deadCoverageExclusions(root: string, entries: readonly string[]): string[] {
  return entries.map(pattern => pattern.replaceAll('\\', '/')).filter((pattern) => {
    if (pattern === temporaryProbeGuard) return false
    return !globSync(pattern, { cwd: root }).some(path => lstatSync(resolve(root, path)).isFile())
  })
}

/** Run the same list consumed by coverage and report each stale pattern. */
function main(): void {
  const dead = deadCoverageExclusions(resolve(import.meta.dirname, '..'), coverageExcludeEntries)
  if (dead.length > 0) {
    console.error(`verify-coverage-exclude: ${String(dead.length)} pattern(s) match no regular file:`)
    for (const pattern of dead) console.error(`  ${pattern}`)
    process.exitCode = 1
    return
  }
  console.log(`verify-coverage-exclude: ${String(coverageExcludeEntries.length)} active patterns verified (one exact temporary-probe guard allowed).`)
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) main()
