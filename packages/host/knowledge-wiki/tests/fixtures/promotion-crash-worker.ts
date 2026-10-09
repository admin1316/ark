import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, join } from 'node:path'
import { applyCandidateReview } from '../../src/reviews.ts'
import type { KnowledgeWikiVerifierAuthority } from '../../src/verifier.ts'
import { verifierAuthority } from '../verifier-authority-fixture.ts'

const required = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`missing ${name}`)
  return value
}

const checkpointId = required('WIKI_CRASH_CHECKPOINT')
if (checkpointId === 'committed-before-lifecycle' || checkpointId === 'committed-after-lifecycle'
  || checkpointId === 'committed-lifecycle-append-error') {
  // Observe the real append boundary after the owner has durably committed.
  // This fixture-only interception adds no production checkpoint or format.
  const openSync = fs.openSync
  const fsyncSync = fs.fsyncSync
  const reviewFile = required('WIKI_REVIEW_FILE')
  const eventPath = join(dirname(reviewFile), 'knowledge-events.jsonl')
  let eventDescriptor: number | undefined
  fs.openSync = (path, flags, mode) => {
    if (path === eventPath && typeof flags === 'number' && (flags & fs.constants.O_APPEND) !== 0) {
      const directory = join(dirname(reviewFile), 'promotion-journal')
      const journal = JSON.parse(fs.readFileSync(join(directory, fs.readdirSync(directory)[0]!), 'utf8')) as { state: string }
      if (journal.state !== 'committed') throw new Error('fixture lifecycle append preceded commit')
      if (checkpointId === 'committed-before-lifecycle') process.kill(process.pid, 'SIGKILL')
      if (checkpointId === 'committed-lifecycle-append-error') throw new Error('fixture lifecycle append failure')
      eventDescriptor = openSync(path, flags, mode)
      return eventDescriptor
    }
    return openSync(path, flags, mode)
  }
  fs.fsyncSync = (descriptor) => {
    fsyncSync(descriptor)
    if (descriptor === eventDescriptor) process.kill(process.pid, 'SIGKILL')
  }
  syncBuiltinESMExports()
}
const rollbackCheckpoint = checkpointId.startsWith('rollback:') ? checkpointId.slice('rollback:'.length) : undefined
const authority: KnowledgeWikiVerifierAuthority = {
  ...verifierAuthority('pass', checkpointId),
  ...(rollbackCheckpoint === undefined ? {} : {
    checkpointPromotion(payload, checkpoint) {
      if (`${checkpoint.phase}:${checkpoint.operationIndex}` === rollbackCheckpoint) {
        const recreatedCandidate = process.env.WIKI_RECREATED_CANDIDATE
        if (recreatedCandidate !== undefined) {
          const journal = JSON.parse(payload) as { operations: Array<{ role: string; path: string }> }
          const candidate = journal.operations.find(operation => operation.role === 'candidate')
          if (candidate === undefined) throw new Error('fixture journal lacks candidate operation')
          fs.writeFileSync(candidate.path, recreatedCandidate, { flag: 'wx' })
        }
        throw new Error('fixture Archive checkpoint failure')
      }
    },
  }),
}

const applied = applyCandidateReview(
  authority,
  required('WIKI_REVIEW_FILE'),
  required('WIKI_PROJECT_ROOT'),
  required('WIKI_ROOT'),
  required('WIKI_ARCHIVE_ROOT'),
  required('WIKI_REVIEW_ID'),
  required('WIKI_REVIEW_ACTION'),
  'human',
)
if (applied !== true) process.exitCode = 2
