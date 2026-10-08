import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const descriptors = vi.hoisted(() => new Map<number, { path: string; directory: boolean }>())
const fault = vi.hoisted(() => ({ log: '', code: '', fileSynced: false, parentSynced: false }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args)
      descriptors.set(fd, { path: String(args[0]), directory: actual.fstatSync(fd).isDirectory() })
      return fd
    },
    closeSync: (fd: number) => {
      descriptors.delete(fd)
      actual.closeSync(fd)
    },
    fsyncSync: (fd: number) => {
      const descriptor = descriptors.get(fd)
      if (descriptor?.directory === true && fault.fileSynced && descriptor.path === dirname(fault.log)) {
        if (fault.code !== '') throw Object.assign(new Error('journal parent sync failed'), { code: fault.code })
        fault.parentSynced = true
      }
      actual.fsyncSync(fd)
      if (descriptor?.path === fault.log) fault.fileSynced = true
    },
  }
})

import { appendKnowledgeEvent, createKnowledgeEvent, readKnowledgeEventLog } from '../src/knowledge-governance.ts'

const roots: string[] = []
afterEach(() => {
  Object.assign(fault, { log: '', code: '', fileSynced: false, parentSynced: false })
  expect(descriptors.size).toBe(0)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('knowledge event namespace publication', () => {
  it.skipIf(process.platform === 'win32').each(['EPERM', 'EIO'])('retains visible first-event bytes and rejects failed parent sync %s', (code) => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-journal-durability-'))
    roots.push(root)
    const log = join(root, 'events.jsonl')
    Object.assign(fault, { log, code })
    const first = createKnowledgeEvent('knowledge/conflict', 'k-1', { visibility: 'project', projectId: 'project-a' }, {}, { seq: 0 })
    expect(() => { appendKnowledgeEvent(log, first) }).toThrow('journal parent sync failed')
    expect(fault.fileSynced).toBe(true)
    expect(readKnowledgeEventLog(log)).toEqual([first])
    const visible = readFileSync(log)
    expect(() => { appendKnowledgeEvent(log, first) }).toThrow('knowledge event hash/sequence mismatch')
    expect(readFileSync(log)).toEqual(visible)

    fault.code = ''
    const second = createKnowledgeEvent('knowledge/conflict', 'k-1', first.scope, {}, { seq: 1, previousEventHash: first.eventHash })
    appendKnowledgeEvent(log, second)
    expect(fault.parentSynced).toBe(true)
    expect(readKnowledgeEventLog(log)).toEqual([first, second])
  })
})
