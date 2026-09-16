/**
 * Reference-scanner contract: a line-level `repo-path-fixture:` marker declares
 * its path literals as temporary-fixture paths rather than repository
 * references, so intentional fixtures stay reviewable in place. Every other
 * line keeps the gate's full strictness.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FIXTURE_PATH_MARKER, findReferenceViolations } from './repo-files.ts'

const roots: string[] = []
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-repo-files-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('findReferenceViolations', () => {
  const scan = (root: string, source: string): { line: number; ref: string }[] => {
    const file = join(root, 'sample.ts')
    writeFileSync(file, source)
    return findReferenceViolations(
      root,
      file,
      /\bpackages\/[A-Za-z0-9._/-]+/g,
      ref => ref.replace(/[./]+$/, ''),
      ref => ref === 'packages/client',
    ).map(violation => ({ line: violation.line, ref: violation.ref }))
  }

  it('reports an undeclared fixture-shaped reference', () => {
    const root = tmp()
    expect(scan(root, "const p = join(root, 'packages/client')\n")).toEqual([
      { line: 1, ref: 'packages/client' },
    ])
  })

  it('skips a line that declares itself a fixture path', () => {
    const root = tmp()
    const source = [
      "const p = join(root, 'packages/client', 'src/index.ts') // " + FIXTURE_PATH_MARKER + ' temporary fixture root',
      "const q = join(root, 'packages/client')",
      '',
    ].join('\n')
    expect(scan(root, source)).toEqual([{ line: 2, ref: 'packages/client' }])
  })
})
