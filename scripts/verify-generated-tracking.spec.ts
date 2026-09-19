/**
 * Gate coverage for the retired-artifact index check. Every scenario runs
 * against a throwaway Git repository under the OS temp dir — never this
 * checkout — and the fixture only writes outside the repository's own index.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  main,
  retirementReason,
  scanTrackedGeneratedPaths,
  verifyGeneratedTracking,
  type TrackingIo,
} from './verify-generated-tracking.ts'

const fixtureRoots: string[] = []

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Run one Git command inside a fixture; a non-zero exit throws. */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

/** Write one fixture file, creating parent directories. */
function write(root: string, path: string, content = 'fixture\n'): void {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

/** Collect report lines so a test can assert the exact violation output. */
function recorder(): { io: TrackingIo; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return {
    io: {
      log: (message) => { out.push(message) },
      error: (message) => { err.push(message) },
    },
    out,
    err,
  }
}

/** A committed fixture repository whose retired classes are ignored. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-generated-tracking-'))
  fixtureRoots.push(root)
  git(root, ['init', '--initial-branch=main'])
  git(root, ['config', 'user.email', 'generated-tracking@example.com'])
  git(root, ['config', 'user.name', 'Generated Tracking Tests'])
  writeFileSync(join(root, '.gitignore'), [
    'packages/*/*/lib/',
    'apps/*/lib/',
    '*.tsbuildinfo',
    '.tmp-swift-module-cache-*/',
    '/purpose.md',
    '/schema.md',
    '',
  ].join('\n'))
  // Ordinary source plus every retained build input the gate must not touch.
  write(root, 'packages/sdk/client/src/api.ts')
  write(root, 'vendor/cordis/lib/index.js')
  write(root, '.agents/skills/media-production-studio/lib/helper.mjs')
  write(root, 'tsconfig.base.json')
  write(root, 'native/addon/src/entry.cpp')
  write(root, 'python/sdk/tests/conftest.py')
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', 'baseline'])
  return root
}

describe('verify-generated-tracking', () => {
  it('rejects forced personal-state additions without rejecting examples or recorded test scenarios', () => {
    const root = fixture()
    const forbidden = [
      '.env', 'nested/.env.production', '.env.local.bak',
      '.credentials.yaml', 'nested/.credentials.yaml.bak',
      '.sessions/session-query.db', 'workspace/.llm-wiki/review.json',
      'wiki/private.md', 'Knowledge/wiki/private.md', 'nested/wiki/private.md',
      'Knowledge/raw/sources/private.txt', 'Default Workspace/private.txt',
      'Document References/private.json', 'Workbench Drafts/private.md',
      '.dsh/settings.yaml', 'Harness/profiles/cordis.yml',
      'sessions/workspace/session.jsonl.zstd', 'storages/workspace.json',
      'attachments/private.png', 'terminal-sessions/state.json', 'settings.yaml.bak',
    ]
    const retained = [
      '.env.example', 'nested/.env.template', '.env.sample',
      'snapshots/session/example/session.jsonl',
      'snapshots/session/skill-load/workspace/.dsh/skills/example/SKILL.md',
      'packages/session/session/tests/fixtures/settings.yaml',
    ]
    for (const path of [...forbidden, ...retained]) write(root, path)
    git(root, ['add', '-f', '--', ...forbidden, ...retained])
    expect(new Set(scanTrackedGeneratedPaths(root).violations.map(entry => entry.path))).toEqual(new Set(forbidden))
    expect(verifyGeneratedTracking(root, recorder().io)).toBe(1)
    git(root, ['rm', '--cached', '-q', '--', ...forbidden])
    expect(verifyGeneratedTracking(root, recorder().io)).toBe(0)
  })

  it('passes with source, retained vendor/.agents libs, tsconfig and native inputs tracked', () => {
    const root = fixture()
    const { io, out, err } = recorder()

    expect(verifyGeneratedTracking(root, io)).toBe(0)
    expect(err).toEqual([])
    expect(out.join('\n')).toContain('no retired generated artifacts')
  })

  it('ignores ignored build output that exists only on disk', () => {
    const root = fixture()
    write(root, 'packages/sdk/client/lib/index.js')
    write(root, 'apps/cli/lib/bin.js')
    write(root, 'tsconfig.host.tsbuildinfo')

    // The files are present but untracked, so the index — not the disk — decides.
    expect(existsSync(join(root, 'packages/sdk/client/lib/index.js'))).toBe(true)
    expect(scanTrackedGeneratedPaths(root).violations).toEqual([])
    expect(verifyGeneratedTracking(root, recorder().io)).toBe(0)
  })

  it('fails when a retired artifact is force-added, naming path and ownership', () => {
    const root = fixture()
    write(root, 'packages/sdk/client/lib/index.js')
    git(root, ['add', '-f', 'packages/sdk/client/lib/index.js'])
    const { io, err } = recorder()

    expect(verifyGeneratedTracking(root, io)).toBe(1)
    expect(err.join('\n')).toContain('packages/sdk/client/lib/index.js')
    expect(err.join('\n')).toContain('generated host build output')
    const [violation] = scanTrackedGeneratedPaths(root).violations
    expect(violation?.path).toBe('packages/sdk/client/lib/index.js')
    expect(violation?.reason).toContain('8fc73e52')
  })

  it('passes again once the artifact leaves the index but stays on disk', () => {
    const root = fixture()
    write(root, 'apps/cli/lib/bin.js')
    git(root, ['add', '-f', 'apps/cli/lib/bin.js'])
    expect(verifyGeneratedTracking(root, recorder().io)).toBe(1)

    git(root, ['rm', '--cached', '-q', 'apps/cli/lib/bin.js'])

    expect(existsSync(join(root, 'apps/cli/lib/bin.js'))).toBe(true)
    expect(verifyGeneratedTracking(root, recorder().io)).toBe(0)
  })

  it('flags every retired class, including spaced and non-ASCII names', () => {
    const root = fixture()
    const paths = [
      'apps/cli/lib/bin.js',
      'packages/sdk/client/lib/types/localized 名称.d.ts',
      'packages/sdk/client/lib/tsconfig.tsbuildinfo',
      'tsconfig.host.tsbuildinfo',
      '.tmp-swift-module-cache-20260822/module.pcm',
      'purpose.md',
      'schema.md',
    ]
    for (const path of paths) write(root, path)
    git(root, ['add', '-f', '--', ...paths])

    const scan = scanTrackedGeneratedPaths(root)

    expect(new Set(scan.violations.map(entry => entry.path))).toEqual(new Set(paths))
    for (const violation of scan.violations) expect(violation.reason.length).toBeGreaterThan(0)
  })

  it('leaves similarly named paths alone', () => {
    const root = fixture()
    const allowed = [
      'packages/sdk/client/library/index.js',
      'packages/sdk/client/libx/index.js',
      'packages/sdk/lib/index.js',
      'apps/cli/library/bin.js',
      'apps/cli/libx/bin.js',
      'packages/sdk/client/src/lib.ts',
      'src/schema.md',
      'notes.tsbuildinfo.bak',
    ]
    for (const path of allowed) write(root, path)
    git(root, ['add', '--', ...allowed])

    for (const path of allowed) expect(retirementReason(path)).toBeUndefined()
    expect(scanTrackedGeneratedPaths(root).violations).toEqual([])
    expect(verifyGeneratedTracking(root, recorder().io)).toBe(0)
  })

  it('fails when the index has unresolved merge entries', () => {
    const root = fixture()
    git(root, ['checkout', '-q', '-b', 'side'])
    write(root, 'packages/sdk/client/src/api.ts', 'side\n')
    git(root, ['commit', '-qam', 'side change'])
    git(root, ['checkout', '-q', 'main'])
    write(root, 'packages/sdk/client/src/api.ts', 'main\n')
    git(root, ['commit', '-qam', 'main change'])
    expect(() => git(root, ['merge', 'side'])).toThrow()

    expect(() => scanTrackedGeneratedPaths(root)).toThrow(/unresolved merge entries/)
    expect(verifyGeneratedTracking(root, recorder().io)).toBe(1)
  })

  it('fails instead of passing when Git cannot read the target', () => {
    const plain = mkdtempSync(join(tmpdir(), 'dsh-generated-tracking-norepo-'))
    fixtureRoots.push(plain)
    const { io, err } = recorder()

    expect(verifyGeneratedTracking(plain, io)).toBe(1)
    expect(err.join('\n')).toContain('cannot inspect the Git index')

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(main(['--root', plain])).toBe(1)
      expect(main(['--root'])).toBe(2)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('passes on this checkout', () => {
    const { io, out } = recorder()
    expect(verifyGeneratedTracking(process.cwd(), io)).toBe(0)
    expect(out.join('\n')).toContain('no retired generated artifacts')
  })
})
