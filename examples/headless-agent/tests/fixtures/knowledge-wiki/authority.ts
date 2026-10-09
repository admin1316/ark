import type { Context } from '@deepseek-ai/cordis'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { verifierAuthority } from '../../../../../packages/host/knowledge-wiki/tests/verifier-authority-fixture.ts'
import type { KnowledgeWikiVerifierAuthority } from '../../../../../packages/host/knowledge-wiki/src/verifier.ts'
import { ARCHIVE_CONFLICT_PATH, ARCHIVE_RECREATED_BYTES } from './archive-rollback-conflict.ts'
export const name = 'wiki-governance-external-verifier-fixture'
export interface Config { archiveRollbackConflict?: boolean }
export function apply(ctx: Context, config: Config = {}): void {
  const authority = verifierAuthority()
  if (config.archiveRollbackConflict !== true) {
    ctx.provide('knowledgeWikiVerifierAuthority', authority)
    return
  }
  // The seal and failure callback are test authorities, never learning evidence.
  const conflictAuthority: KnowledgeWikiVerifierAuthority = {
    ...authority,
    async verifyCandidate() { throw new Error('Archive fixture must not request external verification') },
    checkpointPromotion(payload, checkpoint) {
      if (checkpoint.phase !== 'tombstone-unlinked' || checkpoint.operationIndex !== 3) return
      const journal = JSON.parse(payload) as { operations: Array<{ role: string; path: string }> }
      const candidate = journal.operations.find(operation => operation.role === 'candidate')
      assert.equal(candidate?.path, join(process.cwd(), 'wiki', ARCHIVE_CONFLICT_PATH))
      writeFileSync(candidate.path, ARCHIVE_RECREATED_BYTES, { flag: 'wx' })
      throw new Error('fixture Archive checkpoint failure')
    },
  }
  ctx.provide('knowledgeWikiVerifierAuthority', conflictAuthority)
}
