import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({
  descriptors: new Map<number, string>(),
  trace: [] as string[],
  sync: undefined as ((path: string) => void) | undefined,
  renamed: undefined as ((from: string, to: string) => void) | undefined,
  unlinked: undefined as ((path: string) => void) | undefined,
}))

// Inject errors at real syscall boundaries; all files, descriptors and journal
// authority checks use the production implementations.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const descriptor = actual.openSync(...args)
      io.descriptors.set(descriptor, String(args[0]))
      return descriptor
    },
    closeSync: (descriptor: number) => {
      io.descriptors.delete(descriptor)
      actual.closeSync(descriptor)
    },
    fsyncSync: (descriptor: number) => {
      const path = io.descriptors.get(descriptor)!
      io.trace.push(`sync:${path}`)
      io.sync?.(path)
      actual.fsyncSync(descriptor)
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      actual.renameSync(...args)
      const [from, to] = args.map(String)
      io.trace.push(`rename:${to}`)
      io.renamed?.(from!, to!)
    },
    unlinkSync: (...args: Parameters<typeof actual.unlinkSync>) => {
      actual.unlinkSync(...args)
      const path = String(args[0])
      io.trace.push(`unlink:${path}`)
      io.unlinked?.(path)
    },
  }
})

import { appendCandidateReviews, applyCandidateReview, recoverCandidateReviewTransactions } from '../src/reviews.ts'
import { readKnowledgeEventLog } from '../src/knowledge-governance.ts'
import type { KnowledgeWikiVerifierAuthority, PromotionCheckpoint } from '../src/verifier.ts'
import type { WikiReviewItem } from '../src/types.ts'
import { verifierAuthority } from './verifier-authority-fixture.ts'

interface Operation {
  role: string
  path: string
  before?: string
  after?: string
  stagingPath?: string
  tombstonePath?: string
}
interface Journal { state: string; operations: Operation[] }
const roots: string[] = []
const authority = verifierAuthority()
const injected = Object.assign(new Error('injected namespace fsync failure'), { code: 'EIO' })
const interrupted = new Error('interrupted after durable WAL')

afterEach(() => {
  io.sync = undefined
  io.renamed = undefined
  io.unlinked = undefined
  io.trace = []
  expect(io.descriptors.size).toBe(0)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wiki-review-directory-'))
  roots.push(root)
  const wikiRoot = join(root, 'wiki')
  const candidatePath = '_candidates/sessions/durability.md'
  const candidate = join(wikiRoot, candidatePath)
  const reviewFile = join(root, '.llm-wiki', 'review.json')
  const archiveRoot = join(root, 'archive')
  mkdirSync(dirname(candidate), { recursive: true })
  writeFileSync(candidate, '---\ntype: concept\nstatus: candidate\norigin: ingest\ntitle: Durability\nsources: ["fixture:durability"]\n---\n\n# Durability\n')
  appendCandidateReviews(reviewFile, root, 'fixture:durability', [`wiki/${candidatePath}`])
  const reviewId = (JSON.parse(readFileSync(reviewFile, 'utf8')) as WikiReviewItem[])[0]!.id
  const item = { root, wikiRoot, candidate, reviewFile, archiveRoot, reviewId,
    eventPath: join(dirname(reviewFile), 'knowledge-events.jsonl') }
  return item
}

type Fixture = ReturnType<typeof fixture>
function apply(item: Fixture, acting = authority) {
  return applyCandidateReview(acting, item.reviewFile, item.root, item.wikiRoot, item.archiveRoot, item.reviewId, 'Archive')
}
function recover(item: Fixture) {
  return recoverCandidateReviewTransactions(authority, item.reviewFile, item.wikiRoot, item.archiveRoot)
}
function journalPath(item: Fixture): string {
  const directory = join(dirname(item.reviewFile), 'promotion-journal')
  return join(directory, readdirSync(directory).find(name => name.endsWith('.json'))!)
}
function journal(item: Fixture): Journal { return JSON.parse(readFileSync(journalPath(item), 'utf8')) as Journal }
function withCheckpoint(hook: (checkpoint: PromotionCheckpoint) => void): KnowledgeWikiVerifierAuthority {
  return { ...authority, checkpointPromotion(_core, checkpoint) { hook(checkpoint) } }
}
function prepare(item: Fixture): Journal {
  expect(() => apply(item, withCheckpoint((checkpoint) => {
    if (checkpoint.phase === 'journal-persisted') throw interrupted
  }))).toThrow(interrupted)
  expect(journal(item).state).toBe('prepared')
  io.trace = []
  return journal(item)
}
function noCompletion(item: Fixture): void {
  expect(readKnowledgeEventLog(item.eventPath).filter(event =>
    event.type === 'knowledge/rejected' || event.type === 'knowledge/rolled_back')).toEqual([])
}
function publishPostStates(record: Journal): void {
  for (const operation of record.operations) {
    mkdirSync(dirname(operation.path), { recursive: true })
    if (operation.after === undefined) unlinkSync(operation.path)
    else writeFileSync(operation.path, operation.after)
  }
}

describe.skipIf(process.platform === 'win32')('Archive namespace durability and guarded recovery', () => {
  it.each(['candidate-archive', 'review', 'governance', 'candidate'])('retains prepared WAL on post-rename fsync failure for %s', (role) => {
    const item = fixture()
    const record = prepare(item)
    const operation = record.operations.find(value => value.role === role)!
    const destination = operation.after === undefined ? operation.tombstonePath! : operation.path
    io.renamed = (_from, to) => {
      if (to === destination) io.sync = (path) => { if (path === dirname(to)) throw injected }
    }
    expect(() => recover(item)).toThrow(injected)
    expect(journal(item).state).toBe('prepared')
    noCompletion(item)
    expect(io.trace[io.trace.indexOf(`rename:${destination}`) + 1]).toBe(`sync:${dirname(destination)}`)
    if (operation.after === undefined) {
      expect(existsSync(operation.path)).toBe(false)
      expect(readFileSync(destination, 'utf8')).toBe(operation.before)
    } else expect(readFileSync(operation.path, 'utf8')).toBe(operation.after)
    io.sync = undefined
    io.renamed = undefined
    expect(recover(item)).toBe(1)
    expect(recover(item)).toBe(0)
  })

  it('re-syncs a resumed tombstone unlink and an already absent delete on retry', () => {
    const item = fixture()
    const record = prepare(item)
    const candidate = record.operations.find(value => value.role === 'candidate')!
    io.unlinked = (path) => {
      if (path === candidate.tombstonePath) io.sync = (directory) => { if (directory === dirname(path)) throw injected }
    }
    expect(() => recover(item)).toThrow(injected)
    expect(existsSync(candidate.path)).toBe(false)
    expect(existsSync(candidate.tombstonePath!)).toBe(false)
    expect(() => recover(item)).toThrow(injected)
    noCompletion(item)
    io.sync = undefined
    io.unlinked = undefined
    expect(recover(item)).toBe(1)
  })

  it('re-fsyncs a matching staged file before publishing it', () => {
    const item = fixture()
    const operation = prepare(item).operations[0]!
    mkdirSync(dirname(operation.path), { recursive: true })
    writeFileSync(operation.stagingPath!, operation.after!)
    io.sync = (path) => { if (path === operation.stagingPath) throw injected }
    expect(() => recover(item)).toThrow(injected)
    expect(existsSync(operation.path)).toBe(false)
    expect(readFileSync(operation.stagingPath!, 'utf8')).toBe(operation.after)
    noCompletion(item)
    io.sync = undefined
    expect(recover(item)).toBe(1)
  })

  it.each(['prepared', 'committed'])('re-syncs matching poststates before certifying a %s WAL with no event', (state) => {
    const item = fixture()
    const record = prepare(item)
    publishPostStates(record)
    if (state === 'committed') writeFileSync(journalPath(item), JSON.stringify({ ...JSON.parse(readFileSync(journalPath(item), 'utf8')), state }))
    const walBefore = readFileSync(journalPath(item), 'utf8')
    io.sync = (path) => { if (path === dirname(record.operations[0]!.path)) throw injected }
    expect(() => recover(item)).toThrow(injected)
    expect(readFileSync(journalPath(item), 'utf8')).toBe(walBefore)
    noCompletion(item)
    io.sync = undefined
    expect(recover(item)).toBe(state === 'prepared' ? 1 : 0)
    expect(readKnowledgeEventLog(item.eventPath).filter(event => event.type === 'knowledge/rejected')).toHaveLength(1)
  })

  it.each(['wal-file', 'wal-parent', 'event-file', 'event-parent'])('repeats the %s barrier for already visible matching terminal history', (barrier) => {
    const item = fixture()
    prepare(item)
    expect(recover(item)).toBe(1)
    const before = readFileSync(item.eventPath)
    const walBefore = readFileSync(journalPath(item))
    const target = barrier === 'wal-file' ? journalPath(item) : barrier === 'wal-parent' ? dirname(journalPath(item))
      : barrier === 'event-file' ? item.eventPath : dirname(item.eventPath)
    io.sync = (path) => { if (path === target) throw injected }
    expect(() => recoverCandidateReviewTransactions(undefined, item.reviewFile, item.wikiRoot, item.archiveRoot)).toThrow(injected)
    expect(readFileSync(item.eventPath)).toEqual(before)
    expect(readFileSync(journalPath(item))).toEqual(walBefore)
    io.sync = undefined
    expect(recoverCandidateReviewTransactions(undefined, item.reviewFile, item.wikiRoot, item.archiveRoot)).toBe(0)
    expect(readFileSync(item.eventPath)).toEqual(before)
  })

  it('reports a restore directory-fsync failure with the original error and retains raw WAL', () => {
    const item = fixture()
    const before = readFileSync(item.candidate, 'utf8')
    const original = new Error('interrupted after candidate rename')
    io.renamed = (_from, to) => {
      if (to === item.candidate) io.sync = (path) => { if (path === dirname(to)) throw injected }
    }
    let caught: unknown
    try {
      apply(item, withCheckpoint((checkpoint) => {
        if (checkpoint.phase === 'entry-renamed' && checkpoint.operationIndex === 3) throw original
      }))
    } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toEqual([original, injected])
    expect(readFileSync(item.candidate, 'utf8')).toBe(before)
    expect(journal(item).state).toBe('prepared')
    noCompletion(item)
    expect(() => recover(item)).toThrow(injected)
    io.sync = undefined
    io.renamed = undefined
    expect(recover(item)).toBe(1)
  })

  it('preserves the initiating failure when a visible rolled-back marker cannot be synced', () => {
    const item = fixture()
    const original = new Error('interrupted before commit marker')
    io.renamed = (_from, to) => {
      if (to.endsWith('.json') && to.includes('promotion-journal') && readFileSync(to, 'utf8').includes('"rolled-back"')) {
        io.sync = (path) => { if (path === dirname(to)) throw injected }
      }
    }
    let caught: unknown
    try {
      apply(item, withCheckpoint((checkpoint) => { if (checkpoint.phase === 'before-commit-marker') throw original }))
    } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toEqual([original, injected])
    expect(journal(item).state).toBe('rolled-back')
    noCompletion(item)
    expect(existsSync(item.candidate)).toBe(true)
    const retained = readFileSync(journalPath(item))
    expect(() => recover(item)).toThrow(injected)
    expect(readFileSync(journalPath(item))).toEqual(retained)
    io.sync = (path) => { if (path === journalPath(item)) throw injected }
    expect(() => recover(item)).toThrow(injected)
    expect(readFileSync(journalPath(item))).toEqual(retained)
    io.sync = undefined
    expect(recoverCandidateReviewTransactions(undefined, item.reviewFile, item.wikiRoot, item.archiveRoot)).toBe(0)
    noCompletion(item)
  })

  it('rolls back guarded bytes after a one-shot post-publication failure without claiming Archive success', () => {
    const item = fixture()
    const reviewBefore = readFileSync(item.reviewFile, 'utf8')
    io.renamed = (_from, to) => {
      if (to !== item.reviewFile) return
      io.renamed = undefined
      io.sync = (path) => {
        if (path !== dirname(to)) return
        io.sync = undefined
        throw injected
      }
    }
    expect(() => apply(item)).toThrow(injected)
    expect(readFileSync(item.reviewFile, 'utf8')).toBe(reviewBefore)
    expect(existsSync(item.candidate)).toBe(true)
    expect(journal(item).state).toBe('rolled-back')
    expect(readKnowledgeEventLog(item.eventPath).filter(event => event.type === 'knowledge/rejected')).toEqual([])
    expect(readKnowledgeEventLog(item.eventPath).filter(event => event.type === 'knowledge/rolled_back')).toHaveLength(1)
  })

  it('preserves a recreated candidate on a postdelete failure and refuses completion or rollback overwrite', () => {
    const item = fixture()
    io.unlinked = (path) => {
      if (!path.includes('.ark-wal-delete-')) return
      io.sync = (directory) => {
        if (directory !== dirname(item.candidate)) return
        io.sync = undefined
        writeFileSync(item.candidate, 'foreign recreated bytes')
        throw injected
      }
    }
    expect(() => apply(item)).toThrow(AggregateError)
    expect(readFileSync(item.candidate, 'utf8')).toBe('foreign recreated bytes')
    expect(journal(item).state).toBe('prepared')
    noCompletion(item)
    expect(() => recover(item)).toThrow('divergent state')
    expect(readFileSync(item.candidate, 'utf8')).toBe('foreign recreated bytes')
  })
})
