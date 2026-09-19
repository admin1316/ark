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
    reason: 'personal agent instructions or local agent state; committed integration inputs remain allowed',
    matches: (path) => {
      const segments = path.split('/')
      return /(?:^|\/)(?:AGENTS|CLAUDE)\.local\.md[^/]*$/u.test(path)
        || (segments.at(-1) ?? '').startsWith('.claude.json')
        || (segments.includes('.claude') && path !== '.claude/skills')
        || (segments.includes('.codex') && path !== '.codex/config.toml')
    },
  },
  {
    reason: 'personal media-tool credentials, cloud account state, identity, or intent history; project assets remain allowed',
    matches: path => path.split('/').includes('.aws')
      || /(?:^|\/)\.config\/gcloud(?:\/|$)/u.test(path)
      || /(?:^|\/)\.heygen\/credentials[^/]*$/u.test(path)
      || /(?:^|\/)\.hyperframes\/(?:config|cloudrun-state)\.json[^/]*$/u.test(path)
      || /(?:^|\/)\.media\/(?:anon-id|misses\.jsonl)[^/]*$/u.test(path),
  },
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
        || /(?:^|\/)raw\/sources\//u.test(path)
        || path.endsWith('.log')
        || ['.dsh', 'Harness', 'profiles', 'projcache', 'workspace-registry', 'runtime-state', '.agent-presets', 'skills', 'logs', 'cache', 'llm-deepseek', 'Knowledge', 'Default Workspace', 'Document References', 'Workbench Drafts', 'sessions', 'storages', 'attachments', 'terminal-sessions'].includes(segments[0] ?? '')
        || (segments[0] ?? '').startsWith('.ark-')
        || ['.anonymous-user-id', 'cordis.patch.yml', 'SETTINGS.md'].includes(path)
        || path.startsWith('settings.yaml')
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
 * Inspect every tree newly reachable from a PR head or pushed main commit.
 * Deleted intermediate files and side-branch commits remain subject to the same
 * path policy as the index. Only commit IDs are accepted; Git failures fail closed.
 * @param root - Repository root with the complete commit range fetched.
 * @param base - Exclusive base commit, or all zeroes for a newly created ref.
 * @param head - Inclusive head commit.
 * @param io - Output sinks; no blob contents are read or printed.
 * @returns `0` when every introduced tree passes, otherwise `1`.
 */
export function verifyTrackingHistory(root: string, base: string, head: string, io: TrackingIo = console): number {
  try {
    if (!/^[0-9a-f]{40}$/u.test(base) || !/^[0-9a-f]{40}$/u.test(head)) {
      throw new Error('history base and head must be full commit IDs')
    }
    const range = /^0{40}$/u.test(base) ? head : `${base}..${head}`
    const commits = runGit(root, ['rev-list', range], 'listing introduced commits')
      .toString('utf8').trim().split('\n').filter(Boolean)
    let violations = 0
    for (const commit of commits) {
      const paths = nulSeparated(runGit(root, ['ls-tree', '-r', '--name-only', '-z', commit], 'listing commit paths'))
      for (const path of paths) {
        const reason = retirementReason(path)
        if (reason === undefined) continue
        if (violations < MAX_REPORTED) io.error(`  ${commit}: ${JSON.stringify(path)}\n    ${reason}`)
        violations++
      }
    }
    if (violations > 0) {
      io.error(`verify-generated-tracking: ${violations} forbidden historical path(s); deleting from the tip is insufficient.`)
      return 1
    }
    io.log(`verify-generated-tracking: ${commits.length} introduced commit tree(s) checked; no forbidden paths.`)
    return 0
  } catch (failure) {
    io.error(`verify-generated-tracking: cannot inspect history: ${failure instanceof Error ? failure.message : String(failure)}`)
    return 1
  }
}

/**
 * Resolve the repository root and verify its index.
 * @param args - CLI arguments: optional `--root <path>` and paired `--history-base <sha>` / `--history-head <sha>`.
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
    const baseIndex = args.indexOf('--history-base')
    const headIndex = args.indexOf('--history-head')
    if (baseIndex >= 0 || headIndex >= 0) {
      const base = baseIndex < 0 ? undefined : args[baseIndex + 1]
      const head = headIndex < 0 ? undefined : args[headIndex + 1]
      if (base === undefined || head === undefined) {
        console.error('verify-generated-tracking: history base and head are both required.')
        return 2
      }
      if (verifyTrackingHistory(resolved, base, head) !== 0) return 1
    }
    return verifyGeneratedTracking(resolved)
  } catch (failure) {
    console.error(`verify-generated-tracking: cannot resolve the repository root: ${failure instanceof Error ? failure.message : String(failure)}`)
    return 1
  }
}

if (import.meta.main) process.exitCode = main()
