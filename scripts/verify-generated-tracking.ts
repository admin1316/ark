/**
 * Git-index gate: retired generated artifacts must never re-enter version
 * control.
 *
 * The retirements are commit-backed — `8fc73e52` untracked the host `lib/`
 * outputs and `*.tsbuildinfo`, `723b6e4e` untracked the Swift module cache,
 * `87af9104` removed the root knowledge-project init copies — and this gate is
 * their anti-reflow check. It inspects INDEX paths (staged or committed), never
 * the working tree, so an ordinary build that leaves ignored files on disk
 * passes while `git add -f` of a retired artifact fails.
 *
 * Retained build inputs stay out of scope by path shape, and the companion spec
 * pins that: the vendored `lib/` trees under `vendor/`, hand-written `.agents`
 * source merely NAMED `lib`, tsconfig files, and native/test inputs.
 *
 * @module scripts/verify-generated-tracking
 */

import { runGit } from './translation-pairing-git.ts'

/** Maximum violation rows printed before the report is abbreviated. */
const MAX_REPORTED = 20

/** One tracked path that must not be in version control, with its ownership reason. */
export interface TrackingViolation {
  /** Repository-relative path exactly as the Git index stores it. */
  path: string
  /** Why this artifact class is retired from tracking. */
  reason: string
}

/** A retired artifact class and the ownership reason its paths carry. */
interface ForbiddenClass {
  reason: string
  matches: (path: string) => boolean
}

/**
 * The audited retired classes. Path SHAPE, not a suffix or substring, decides
 * ownership: `packages/<group>/<package>/lib/...` and `apps/<app>/lib/...` are
 * the exact segments the host build writes and `.gitignore` retires, so a
 * sibling `library/` directory or a tracked file merely NAMED `lib` is
 * untouched.
 */
const FORBIDDEN_CLASSES: readonly ForbiddenClass[] = [
  {
    reason: 'machine-owned credentials or environment configuration; only named examples may be shipped',
    matches: (path) => {
      const name = path.split('/').at(-1) ?? ''
      return name.startsWith('.credentials.yaml')
        || ((name === '.env' || name.startsWith('.env.'))
          && !['.env.example', '.env.template', '.env.sample'].includes(name))
    },
  },
  {
    reason: 'local conversation, knowledge, or Harness state; not a distribution input',
    matches: (path) => {
      const segments = path.split('/')
      return segments.includes('.sessions') || segments.includes('.llm-wiki') || segments.includes('wiki')
        || ['.dsh', 'Harness', 'profiles', '.agent-presets', 'skills', 'logs', 'cache', 'llm-deepseek', 'Knowledge', 'Default Workspace', 'Document References', 'Workbench Drafts', 'sessions', 'storages', 'attachments', 'terminal-sessions'].includes(segments[0] ?? '')
        || (segments[0] ?? '').startsWith('.ark-')
        || ['.anonymous-user-id', 'cordis.patch.yml', 'SETTINGS.md'].includes(path)
        || /^settings\.yaml(?:\.|$)/u.test(path)
    },
  },
  {
    reason: 'generated host build output (retired in 8fc73e52; .gitignore packages/*/*/lib/)',
    matches: (path) => {
      const segments = path.split('/')
      return segments.length >= 5 && segments[0] === 'packages' && segments[3] === 'lib'
    },
  },
  {
    reason: 'generated host build output (retired in 8fc73e52; .gitignore apps/*/lib/)',
    matches: (path) => {
      const segments = path.split('/')
      return segments.length >= 4 && segments[0] === 'apps' && segments[2] === 'lib'
    },
  },
  {
    reason: 'TypeScript incremental build metadata (retired in 8fc73e52; .gitignore *.tsbuildinfo)',
    matches: path => path.endsWith('.tsbuildinfo'),
  },
  {
    reason: 'Swift compiler module cache (retired in 723b6e4e; .gitignore .tmp-swift-module-cache-*/)',
    matches: path => (path.split('/')[0] ?? '').startsWith('.tmp-swift-module-cache-'),
  },
  {
    reason: 'workspace-init copy at the repository root (retired in 87af9104)',
    matches: path => path === 'purpose.md' || path === 'schema.md',
  },
]

/** Aggregate result of one index scan. */
export interface TrackingScan {
  /** Number of indexed paths inspected. */
  trackedCount: number
  /** Retired artifacts found in the index; empty is the passing state. */
  violations: TrackingViolation[]
}

/** Sinks for the report, injectable so the spec reads exact output. */
export interface TrackingIo {
  log: (message: string) => void
  error: (message: string) => void
}

/**
 * Split a NUL-terminated Git listing into its non-empty entries.
 * @param output - Raw stdout of a `git ... -z` listing.
 * @returns The entries in listing order.
 */
function nulSeparated(output: Buffer): string[] {
  return output.toString('utf8').split('\0').filter(entry => entry.length > 0)
}

/**
 * Decide whether one indexed path belongs to a retired artifact class.
 * @param path - Repository-relative path as Git reports it.
 * @returns The ownership reason, or `undefined` when the path is allowed.
 */
export function retirementReason(path: string): string | undefined {
  return FORBIDDEN_CLASSES.find(forbidden => forbidden.matches(path))?.reason
}

/**
 * Scan the Git index for retired generated artifacts.
 *
 * Inspection failures are never a pass: a directory Git cannot read, an
 * unresolved merge state, or a malformed listing throws instead of reporting
 * zero violations.
 * @param root - Repository root; Git runs through `git -C`.
 * @returns The indexed path count and every retired artifact found.
 * @throws When Git cannot list the index, the index is unmerged, or a listing entry is malformed.
 */
export function scanTrackedGeneratedPaths(root: string): TrackingScan {
  const unmerged = nulSeparated(runGit(root, ['ls-files', '--unmerged', '-z'], 'listing unmerged index entries'))
  if (unmerged.length > 0) {
    const paths = [...new Set(unmerged.map((entry) => {
      const tab = entry.indexOf('\t')
      if (tab < 0) throw new Error('git ls-files --unmerged returned a malformed entry')
      return entry.slice(tab + 1)
    }))].sort()
    throw new Error(`git index has unresolved merge entries: ${paths.join(', ')}`)
  }
  const tracked = nulSeparated(runGit(root, ['ls-files', '--cached', '-z'], 'listing tracked index paths'))
  const violations = tracked
    .map(path => ({ path, reason: retirementReason(path) }))
    .filter((entry): entry is TrackingViolation => entry.reason !== undefined)
    .sort((left, right) => left.path.localeCompare(right.path))
  return { trackedCount: tracked.length, violations }
}

/**
 * Report one index scan.
 * @param root - Repository root.
 * @param io - Output sinks; defaults to the process console.
 * @returns `0` for a clean index, `1` for violations or an inspection failure.
 */
export function verifyGeneratedTracking(root: string, io: TrackingIo = console): number {
  try {
    const scan = scanTrackedGeneratedPaths(root)
    if (scan.violations.length === 0) {
      io.log(`verify-generated-tracking: ${scan.trackedCount} indexed path(s) checked; no retired generated artifacts.`)
      return 0
    }
    io.error(`verify-generated-tracking: ${scan.violations.length} tracked generated artifact(s) must leave the index:`)
    for (const violation of scan.violations.slice(0, MAX_REPORTED)) {
      io.error(`  ${violation.path}\n    ${violation.reason}`)
    }
    if (scan.violations.length > MAX_REPORTED) {
      io.error(`  ... and ${scan.violations.length - MAX_REPORTED} more`)
    }
    io.error('Untrack each path with git rm --cached; the matching ignore rules live in .gitignore.')
    return 1
  } catch (failure) {
    io.error(`verify-generated-tracking: cannot inspect the Git index: ${failure instanceof Error ? failure.message : String(failure)}`)
    return 1
  }
}

/**
 * Resolve the repository root and verify its index.
 * @param args - CLI arguments; `--root <path>` overrides discovery from the cwd.
 * @returns The process exit code.
 */
export function main(args: readonly string[] = process.argv.slice(2)): number {
  const rootIndex = args.indexOf('--root')
  const candidate = rootIndex < 0 ? process.cwd() : args[rootIndex + 1]
  if (candidate === undefined) {
    console.error('verify-generated-tracking: --root needs a directory path.')
    return 2
  }
  try {
    const resolved = runGit(candidate, ['rev-parse', '--show-toplevel'], 'resolving the repository root')
      .toString('utf8')
      .trim()
    if (resolved.length === 0) {
      console.error('verify-generated-tracking: git rev-parse --show-toplevel returned no path.')
      return 1
    }
    return verifyGeneratedTracking(resolved)
  } catch (failure) {
    console.error(`verify-generated-tracking: cannot resolve the repository root: ${failure instanceof Error ? failure.message : String(failure)}`)
    return 1
  }
}

if (import.meta.main) process.exitCode = main()
