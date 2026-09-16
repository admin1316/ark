/** Coverage exclusions shared by Vitest and the live-pattern consistency gate. */

import { spawnSync } from 'node:child_process'
import { resolvePwshPath } from '../packages/shell/pwsh-local/src/resolve.ts'

/** POSIX-only package lanes; the test and coverage configurations share this list. */
export const windowsUnsupportedPackages = [
  // Bash-requiring suites (a real POSIX shell is unavailable on Windows).
  // The pwsh-requiring suites (pwsh-local, tool-pwsh) deliberately stay
  // INCLUDED: PowerShell ships with Windows, so they run natively here.
  // This explicit list (not a 'packages/shell/*' glob) keeps
  // packages/shell/shell — the Service Definition package — running on Windows.
  'packages/shell/bash-local',
  'packages/shell/bash-sandbox',
  'packages/shell/tool-bash',
  'packages/hooks/*',
  'packages/terminal/terminal-bash',
  'packages/sandbox/sandbox-local',
]

/**
 * Compute the existing coverage lanes without changing their exemption scope.
 * @param platform - Host platform used by the corresponding test lanes.
 * @param hasPwsh - Whether the executor's own PowerShell resolution probe succeeds.
 * @returns Patterns excluded by coverage on this host.
 */
export function coverageExclusionsFor(platform: NodeJS.Platform, hasPwsh: boolean): string[] {
  return [
    'packages/*/*/src/types.ts',
    'packages/*/*/src/bin.ts',
    'packages/*/*/src/worker.ts',
    // A killed executable lint-contract test can leave a non-product source probe behind.
    'packages/*/*/src/oxlint-contract-*.ts',
    'packages/host/webserver/src/*',
    // Inspector execution adapters run in a Node Worker, the Host native
    // inspector session, or a browser realm, outside attributable parent
    // Vitest coverage.
    'packages/experimental/inspector/src/host/bridge/**',
    'packages/experimental/inspector/src/host/cdp/**',
    'packages/experimental/inspector/src/worker/bridge/**',
    'packages/experimental/inspector/src/worker/cdp/**',
    'packages/experimental/inspector/src/worker/realms/**',
    'packages/experimental/inspector/src/worker/{entry,server}.ts',
    // Keep already-complete Inspector modules under the per-file gate and
    // enumerate the remaining direct-test debt instead of exempting src/**.
    // TODO(inspector): close these branch gaps and remove the entries.
    'packages/experimental/inspector/src/host/plugin.ts',
    'packages/experimental/inspector/src/shared/bridge/{control-codec,rpc}.ts',
    'packages/experimental/inspector/src/shared/bridge/messages/observation.ts',
    'packages/experimental/inspector/src/shared/bridge/messages/query/codec.ts',
    'packages/experimental/inspector/src/shared/bridge/messages/runtime/{command-codec,console-frames,frames,value-codec}.ts',
    'packages/experimental/inspector/src/shared/bridge/messages/sources/{codec,frames}.ts',
    'packages/experimental/inspector/src/worker/inspection/{cordis-store,query-router,realm-store}.ts',
    // This assembly imports generated Host-for-Client code that exists
    // only in lib; the post-build built-bin smoke executes both entries.
    'packages/api/remotes/src/index.ts',
    'packages/extensions/*/src/**/*.ts',
    // Typert generator: correctness is pinned by its fixture suites and
    // the byte-for-byte catalog reproduction test; per-file coverage
    // would put whole-workspace compiler analysis under v8
    // instrumentation — the coverage lane's longest tail.
    'packages/typert/generator/src/*.ts',
    // Projection/command round: executor lifecycle branches and the
    // registry's drive tails need the same maturing lanes. TODO(gui):
    // cover and remove with the client test lane above.
    'packages/interaction/commands/src/index.ts',
    'packages/interaction/commands/src/invariant.ts',
    'packages/session/session-projection/src/index.ts',
    ...(platform === 'win32'
      ? [...windowsUnsupportedPackages, 'packages/subprocess/*'].map(path => `${path}/src/**/*.ts`)
      : [
        // Win32 libraries cannot execute on the non-Windows coverage host.
        'packages/sandbox/sandbox-windows-acl/src/**/*.ts',
        'packages/subprocess/subprocess-local/src/windows-inspector.ts',
      ]),
    // The confinement entry is exercised in a real child, outside parent v8 coverage.
    ...(platform === 'win32' ? ['packages/sandbox/sandbox-windows-acl/src/runner.ts'] : []),
    // Mirror the executor suites' real-PowerShell admission on every platform.
    ...(hasPwsh ? [] : [
      'packages/shell/pwsh-local/src/index.ts',
      'packages/shell/pwsh-sandbox/src/**/*.ts',
    ]),
  ]
}

/** The full active list; both consumers import this exact array. */
export const coverageExcludeEntries = coverageExclusionsFor(process.platform,
  spawnSync(resolvePwshPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'], {
    encoding: 'utf8',
  }).status === 0,
)
