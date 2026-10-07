import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { assertImmutableBoundaries, readRunContext, type ImmutableBoundaries } from './run-context.ts'

const HASH = 'a'.repeat(64)
const immutable: ImmutableBoundaries = {
  goalHash: HASH, planHash: HASH, scopeHash: HASH, permissionsHash: HASH,
  securityThresholdHash: HASH, acceptanceHash: HASH, dataFormatHash: HASH,
  publishPolicyHash: HASH, stateVersion: 1,
}

describe('ARK run context', () => {
  it('reports a missing manifest without inventing immutable state', () => {
    const context = readRunContext(mkdtempSync(join(tmpdir(), 'ark-run-context-')))
    expect(context.status).toBe('missing-manifest')
    expect(context.immutable).toBeNull()
  })

  it('reads evidence hashes and rejects immutable drift', () => {
    const root = mkdtempSync(join(tmpdir(), 'ark-run-context-'))
    writeFileSync(join(root, 'project-manifest.json'), JSON.stringify({ schemaVersion: 1, projectId: 'ark', profile: 'jiuzhang', immutable }))
    writeFileSync(join(root, 'progress.jsonl'), '{"status":"evidence"}\n')
    const context = readRunContext(root)
    expect(context.status).toBe('ready')
    expect(context.profile).toBe('jiuzhang')
    expect(context.evidence['progress.jsonl']?.bytes).toBeGreaterThan(0)
    expect(() => {
      assertImmutableBoundaries(immutable, { ...immutable, goalHash: 'b'.repeat(64) })
    }).toThrow('goalHash')
  })
})
