import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { decodeStorageRecord, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { eventFrameContents, eventLines, scanLog, toHeaderLine } from '../src/format.ts'
import { exportLegacySessionArtifact } from '../src/export-legacy.ts'
import { compressZstdFrame, decompressZstdPrefix } from '../src/zstd.ts'

const prompt = createUserMessage({ content: [{ type: 'text', text: '合成原子输入' }], source: { kind: 'user' } })
const header: SessionHeader = { id: SessionId('atomic-file'), version: 0, createdAt: 1, delegationDepth: 0 }
const prefix: SessionEvent[] = [
  { type: 'agent/inbox/spliced', seq: 0, time: 1, data: { target: 'next-turn', start: 0, inserted: [prompt] } },
  { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } },
]
const group: SessionEvent[] = [
  { type: 'agent/inbox/spliced', seq: 2, time: 3, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
  { type: 'step/start', seq: 3, time: 4, data: { turn: 1, step: 1 } },
  { type: 'user/message', seq: 4, time: 5, data: prompt, surfaceOp: 'append' },
]
const before = Buffer.from(`${JSON.stringify(toHeaderLine(header))}\n${eventLines(prefix, false)}\n`)
const row = Buffer.from(`${eventLines(group, true, [{ firstSeq: 2, count: 3 }])}\n`)

describe('atomic JSONL physical records', () => {
  it('separates atomic compression segments while preserving the exact plaintext record stream', () => {
    const events = [...prefix, ...group]
    const segments = eventFrameContents(events, true, [{ firstSeq: 2, count: 3 }])
    expect(segments).toHaveLength(2)
    expect(segments.join('')).toBe(eventLines(events, true, [{ firstSeq: 2, count: 3 }]) + '\n')
    expect(eventFrameContents(group, false, [{ firstSeq: 2, count: 3 }])).toHaveLength(1)
    expect(eventFrameContents([], true, [])).toEqual([])
  })
  it('admits every byte-split tail as either no group or the complete group', () => {
    for (let cut = 0; cut <= row.length; cut++) {
      const scan = scanLog(Buffer.concat([before, row.subarray(0, cut)]))
      expect(scan.events).toEqual(cut === row.length ? [...prefix, ...group] : prefix)
      expect(scan.committedBytes).toBe(cut === row.length ? before.length + row.length : before.length)
    }
  })

  it('never salvages a member prefix from an incomplete Zstandard frame', async () => {
    const frame = await compressZstdFrame(row)
    for (let cut = 1; cut < frame.length; cut++) {
      let recovered: Buffer
      try { recovered = await decompressZstdPrefix(frame.subarray(0, cut)) } catch { continue }
      const scan = scanLog(Buffer.concat([before, recovered]))
      expect([prefix.length, prefix.length + group.length]).toContain(scan.events.length)
      expect(scan.events).toEqual(scan.events.length === prefix.length ? prefix : [...prefix, ...group])
    }
  })

  it('rejects an invalid atomic member as a whole and refuses to export damaged bytes', async () => {
    const damaged = Buffer.from(JSON.stringify({ type: 'atomic-events', version: 1, seq: 2, events: [group[0], { ...group[1], seq: 77 }] }) + '\n')
    expect(() => scanLog(Buffer.concat([before, damaged]))).toThrow('malformed atomic-events')
    await expect(exportLegacySessionArtifact(Buffer.concat([before, damaged]), 'none')).rejects.toThrow('malformed atomic-events')
    await expect(exportLegacySessionArtifact(Buffer.concat([before, row.subarray(0, row.length - 1)]), 'none')).rejects.toThrow('complete artifact')
  })

  it.each([
    { name: 'guard mismatch', seq: 3, events: group, error: 'guard seq' },
    { name: 'missing member data', seq: 2, events: [{ type: 'step/start', seq: 2, time: 3 }], error: 'invalid member event envelope' },
    { name: 'global sequence gap', seq: 3, events: [{ ...group[0], seq: 3 }], error: 'seq gap in committed region' },
  ])('refuses a complete atomic record with $name before a turn end exists', ({ seq, events, error }) => {
    const damaged = Buffer.from(JSON.stringify({ type: 'atomic-events', version: 1, seq, events }) + '\n')
    expect(() => scanLog(Buffer.concat([before, damaged]))).toThrow(error)
  })

  it('refuses an earlier corrupt scalar suffix when a complete atomic group follows it', () => {
    expect(() => scanLog(Buffer.concat([before, Buffer.from('{bad json}\n'), row]))).toThrow('unparsable committed event')
  })

  it('refuses unknown atomic record versions and corruption containing a committed turn boundary', () => {
    const future = Buffer.from(JSON.stringify({ type: 'atomic-events', version: 2, seq: 2, events: group }) + '\n')
    expect(() => scanLog(Buffer.concat([before, future]))).toThrow('expected version 1')
    const closed = Buffer.from(JSON.stringify({ type: 'atomic-events', version: 1, seq: 2, events: [
      group[0], { type: 'turn/end', seq: 99, time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
    ] }) + '\n')
    expect(() => scanLog(Buffer.concat([before, closed]))).toThrow('corrupt session log')
  })

  it('requires a physical guard matching the first member, including a one-member group', () => {
    expect(decodeStorageRecord({ type: 'atomic-events', version: 1, seq: 2, events: [group[0]] })).toEqual([group[0]])
    expect(JSON.parse(row.toString('utf8'))).toMatchObject({ type: 'atomic-events', seq: 2 })
    for (const seq of [undefined, -1, 1.5, 3]) {
      expect(() => decodeStorageRecord({ type: 'atomic-events', version: 1, seq, events: group })).toThrow('guard seq')
    }
    expect(() => decodeStorageRecord({ type: 'atomic-events', version: 1, events: group })).toThrow('expected version 1')
  })

  for (const compression of ['none', 'zstd'] as const) {
    it(`exports ${compression} atomic records to lossless Ark 3.1.2 scalar JSONL without modifying input`, async () => {
      const plain = Buffer.concat([before, row])
      const source = compression === 'none' ? plain : await compressZstdFrame(plain)
      const original = Buffer.from(source)
      const legacy = await exportLegacySessionArtifact(source, compression)
      expect(source).toEqual(original)
      const records = legacy.trimEnd().split('\n').map(line => JSON.parse(line) as { type: string })
      expect(records.slice(1)).toEqual([...prefix, ...group])
      expect(records.some(record => record.type === 'atomic-events')).toBe(false)
      expect(scanLog(Buffer.from(legacy)).events).toEqual([...prefix, ...group])
    })
  }
})
