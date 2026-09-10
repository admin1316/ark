import { applyCandidateReview } from '../../src/reviews.ts'
import { verifierAuthority } from '../verifier-authority-fixture.ts'

const required = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`missing ${name}`)
  return value
}

const applied = applyCandidateReview(
  verifierAuthority('pass', required('WIKI_CRASH_CHECKPOINT')),
  required('WIKI_REVIEW_FILE'),
  required('WIKI_PROJECT_ROOT'),
  required('WIKI_ROOT'),
  required('WIKI_ARCHIVE_ROOT'),
  required('WIKI_REVIEW_ID'),
  'Promote',
  'human',
)
if (applied !== true) process.exitCode = 2
