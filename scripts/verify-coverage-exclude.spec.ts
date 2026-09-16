/** The exclusion gate validates live files, not merely matching directories. */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { coverageExcludeEntries, coverageExclusionsFor, windowsUnsupportedPackages } from './coverage-exclude.ts'
import { deadCoverageExclusions } from './verify-coverage-exclude.ts'

const root = resolve(import.meta.dirname, '..')
const fixtures: string[] = []
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }) })

function fixture(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-coverage-exclude-'))
  fixtures.push(path)
  return path
}

describe('coverage exclusion consistency', () => {
  it('validates the full active production list', () => {
    expect(coverageExcludeEntries.length).toBeGreaterThan(0)
    expect(deadCoverageExclusions(root, coverageExcludeEntries)).toEqual([])
  })

  it.each(['darwin', 'linux', 'win32'] as const)('validates all existing %s lanes with and without PowerShell', (platform) => {
    for (const hasPwsh of [true, false]) {
      expect(deadCoverageExclusions(root, coverageExclusionsFor(platform, hasPwsh))).toEqual([])
    }
  })

  it('preserves platform and executor admission instead of expanding exclusions', () => {
    const windows = coverageExclusionsFor('win32', true)
    const linux = coverageExclusionsFor('linux', true)
    for (const path of windowsUnsupportedPackages) {
      expect(windows).toContain(`${path}/src/**/*.ts`)
      expect(linux).not.toContain(`${path}/src/**/*.ts`)
    }
    expect(windows).toContain('packages/sandbox/sandbox-windows-acl/src/runner.ts')
    expect(windows).not.toContain('packages/sandbox/sandbox-windows-acl/src/**/*.ts')
    expect(linux).toContain('packages/sandbox/sandbox-windows-acl/src/**/*.ts')
    expect(coverageExclusionsFor('linux', false)).toEqual([
      ...linux, 'packages/shell/pwsh-local/src/index.ts', 'packages/shell/pwsh-sandbox/src/**/*.ts',
    ])
  })

  it('accepts ordinary and brace file globs but rejects dead and directory-only patterns', () => {
    const path = fixture()
    mkdirSync(join(path, 'src'))
    mkdirSync(join(path, 'src', 'directory.ts'))
    writeFileSync(join(path, 'src', 'live.ts'), '')
    expect(deadCoverageExclusions(path, ['src/*.ts', 'src/*.{ts,tsx}', 'src/missing.ts', 'src/directory.ts']))
      .toEqual(['src/missing.ts', 'src/directory.ts'])
    expect(deadCoverageExclusions(path, ['src\\live.ts'])).toEqual([])
  })

  it('does not count a symlink as a regular source file', () => {
    const path = fixture()
    // Directory junctions need no Windows symlink privilege and still are not regular files.
    mkdirSync(join(path, 'target'))
    symlinkSync(join(path, 'target'), join(path, 'linked.ts'), 'junction')
    expect(deadCoverageExclusions(path, ['linked.ts'])).toEqual(['linked.ts'])
  })

  it('allows only the exact temporary oxlint guard, even in an otherwise empty tree', () => {
    const path = fixture()
    expect(deadCoverageExclusions(path, [
      'packages/*/*/src/oxlint-contract-*.ts',
      'packages/*/*/src/oxlint-contract*.ts',
      'packages/*/*/src/oxlint-contract-*.tsx',
      'packages/retired/*/src/**/*.ts',
    ])).toEqual([
      'packages/*/*/src/oxlint-contract*.ts',
      'packages/*/*/src/oxlint-contract-*.tsx',
      'packages/retired/*/src/**/*.ts',
    ])
  })
})
