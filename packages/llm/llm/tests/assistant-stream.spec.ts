import { describe, expect, it } from 'vitest'
import {
  AssistantStreamAccumulator,
  BlockAssembler,
  CallId,
  assembleAssistantStream,
  assistantStreamChunks,
  assistantStreamFirstTokenTime,
  assistantStreamHasVisibleContent,
  assistantStreamHasVisibleText,
  chunkHasVisibleText,
  expandAssistantStream,
  isTokenDelta,
  isVisibleChunk,
  joinAssistantStreamText,
  lastAssistantStreamChunk,
  runFirstTokenTime,
  runFirstVisibleTime,
  type AssistantStreamRecord,
  type StreamChunk,
  type TimedStreamChunk,
} from '@deepseek-ai/dsh-llm'

const text = (index: number, value: string): StreamChunk => ({ type: 'text-delta', index, text: value })
const reasoning = (index: number, value: string): StreamChunk => ({ type: 'reasoning-delta', index, text: value })
const toolCall = (index: number, id: string, argumentsDelta: string, name?: string): StreamChunk => ({
  type: 'tool-call-delta',
  index,
  id: CallId(id),
  ...name === undefined ? {} : { name },
  argumentsDelta,
})
const usage = { inputTokens: 3, outputTokens: 4 } as const
const timed = (time: number, chunk: StreamChunk): TimedStreamChunk => ({ time, chunk })

/** A runtime value outside the static union, as a durable boundary or a foreign adapter delivers. */
const rogueChunk = (value: unknown): StreamChunk => value as StreamChunk
const rogueRecord = (value: unknown): AssistantStreamRecord => value as AssistantStreamRecord

/** One full attempt stream compacted through the public accumulator. */
const compact = (chunks: readonly TimedStreamChunk[]): readonly AssistantStreamRecord[] => {
  const accumulator = new AssistantStreamAccumulator()
  for (const chunk of chunks) accumulator.push(chunk)
  return accumulator.snapshot()
}

describe('AssistantStreamAccumulator packing', () => {
  it('packs consecutive same-index text deltas into one run and splits on an index change', () => {
    const records = compact([
      timed(100, text(0, 'Hel')),
      timed(110, text(0, 'lo')),
      timed(120, text(1, '!')),
      timed(130, text(1, '?')),
    ])
    expect(records).toEqual([
      { type: 'text-chunks', time0: 100, index: 0, dt: [10], texts: ['Hel', 'lo'] },
      { type: 'text-chunks', time0: 120, index: 1, dt: [10], texts: ['!', '?'] },
    ])
    // The compact form carries every original boundary: expansion restores the exact chunk times.
    expect(expandAssistantStream(records)).toEqual([
      timed(100, text(0, 'Hel')),
      timed(110, text(0, 'lo')),
      timed(120, text(1, '!')),
      timed(130, text(1, '?')),
    ])
  })

  it('packs reasoning deltas separately and starts a new text run after interleaved reasoning', () => {
    const records = compact([
      timed(1, reasoning(0, 'plan')),
      timed(2, reasoning(0, 'ning')),
      timed(3, text(1, 'answer')),
      timed(4, reasoning(0, ' tail')),
      timed(5, text(1, ' more')),
    ])
    expect(records).toEqual([
      { type: 'reasoning-chunks', time0: 1, index: 0, dt: [1], texts: ['plan', 'ning'] },
      { type: 'text-chunks', time0: 3, index: 1, dt: [], texts: ['answer'] },
      { type: 'reasoning-chunks', time0: 4, index: 0, dt: [], texts: [' tail'] },
      { type: 'text-chunks', time0: 5, index: 1, dt: [], texts: [' more'] },
    ])
    expect(expandAssistantStream(records)).toEqual([
      timed(1, reasoning(0, 'plan')),
      timed(2, reasoning(0, 'ning')),
      timed(3, text(1, 'answer')),
      timed(4, reasoning(0, ' tail')),
      timed(5, text(1, ' more')),
    ])
  })

  it('starts a new run when the timestamp gap is not a safe integer', () => {
    const records = compact([
      timed(-Number.MAX_SAFE_INTEGER, text(0, 'a')),
      timed(Number.MAX_SAFE_INTEGER, text(0, 'b')),
    ])
    expect(records).toEqual([
      { type: 'text-chunks', time0: -Number.MAX_SAFE_INTEGER, index: 0, dt: [], texts: ['a'] },
      { type: 'text-chunks', time0: Number.MAX_SAFE_INTEGER, index: 0, dt: [], texts: ['b'] },
    ])
    expect(expandAssistantStream(records)).toEqual([
      timed(-Number.MAX_SAFE_INTEGER, text(0, 'a')),
      timed(Number.MAX_SAFE_INTEGER, text(0, 'b')),
    ])
  })

  it('accumulates Tool-call arguments per call and splits on id, index, or name-shape change', () => {
    const records = compact([
      timed(10, toolCall(2, 'c1', '{"text"', 'echo')),
      timed(20, toolCall(2, 'c1', ':"hi"}', 'echo')),
      timed(30, toolCall(2, 'c2', '{"a"', 'echo')),
      timed(40, toolCall(3, 'c2', '{"b"', 'echo')),
      timed(50, toolCall(2, 'c1', '{"c"')),
    ])
    expect(records).toEqual([
      { type: 'tool-call-chunks', time0: 10, index: 2, dt: [10], id: CallId('c1'), name: 'echo', args: ['{"text"', ':"hi"}'] },
      { type: 'tool-call-chunks', time0: 30, index: 2, dt: [], id: CallId('c2'), name: 'echo', args: ['{"a"'] },
      { type: 'tool-call-chunks', time0: 40, index: 3, dt: [], id: CallId('c2'), name: 'echo', args: ['{"b"'] },
      { type: 'tool-call-chunks', time0: 50, index: 2, dt: [], id: CallId('c1'), args: ['{"c"'] },
    ])
    expect(expandAssistantStream(records)).toEqual([
      timed(10, toolCall(2, 'c1', '{"text"', 'echo')),
      timed(20, toolCall(2, 'c1', ':"hi"}', 'echo')),
      timed(30, toolCall(2, 'c2', '{"a"', 'echo')),
      timed(40, toolCall(3, 'c2', '{"b"', 'echo')),
      timed(50, toolCall(2, 'c1', '{"c"')),
    ])
  })

  it('keeps an unnamed Tool-call continuation unnamed while its id and index match', () => {
    const records = compact([timed(1, toolCall(0, 'c1', '{')), timed(2, toolCall(0, 'c1', '}'))])
    expect(records).toEqual([
      { type: 'tool-call-chunks', time0: 1, index: 0, dt: [1], id: CallId('c1'), args: ['{', '}'] },
    ])
  })

  it('records an empty call id or empty tool name as a raw chunk instead of packing it', () => {
    const records = compact([
      timed(1, toolCall(0, '', 'x')),
      timed(2, toolCall(0, 'c1', 'y', '')),
    ])
    expect(records).toEqual([
      { type: 'chunk', time: 1, chunk: { type: 'tool-call-delta', index: 0, id: CallId(''), argumentsDelta: 'x' } },
      { type: 'chunk', time: 2, chunk: { type: 'tool-call-delta', index: 0, id: CallId('c1'), name: '', argumentsDelta: 'y' } },
    ])
    expect(expandAssistantStream(records)).toEqual([
      timed(1, toolCall(0, '', 'x')),
      timed(2, toolCall(0, 'c1', 'y', '')),
    ])
  })

  it('records block, usage, and finish chunks verbatim in stream order', () => {
    const blockStart: StreamChunk = { type: 'block-start', index: 0, blockType: 'text' }
    const blockEnd: StreamChunk = { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } }
    const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
    const records = compact([
      timed(1, blockStart),
      timed(2, text(0, 'hi')),
      timed(3, blockEnd),
      timed(4, { type: 'usage', usage }),
      timed(5, finish),
    ])
    expect(records).toEqual([
      { type: 'chunk', time: 1, chunk: blockStart },
      { type: 'text-chunks', time0: 2, index: 0, dt: [], texts: ['hi'] },
      { type: 'chunk', time: 3, chunk: blockEnd },
      { type: 'chunk', time: 4, chunk: { type: 'usage', usage } },
      { type: 'chunk', time: 5, chunk: finish },
    ])
    expect(expandAssistantStream(records)).toEqual([
      timed(1, blockStart),
      timed(2, text(0, 'hi')),
      timed(3, blockEnd),
      timed(4, { type: 'usage', usage }),
      timed(5, finish),
    ])
  })

  it('returns a detached frozen chunk copy from push and detached frozen records from snapshot', () => {
    const accumulator = new AssistantStreamAccumulator()
    const chunk = text(0, 'one')
    const published = accumulator.push({ time: 7, chunk })
    expect(published).toEqual(timed(7, text(0, 'one')))
    expect(Object.isFrozen(published)).toBe(true)
    expect(Object.isFrozen(published.chunk)).toBe(true)

    const snapshot = accumulator.snapshot()
    // Later pushes must not mutate an already-published snapshot, and the caller's
    // own chunk object stays the caller's to mutate.
    accumulator.push(timed(8, text(0, 'two')))
    expect(snapshot).toEqual([{ type: 'text-chunks', time0: 7, index: 0, dt: [], texts: ['one'] }])
    expect(accumulator.snapshot()).toEqual([
      { type: 'text-chunks', time0: 7, index: 0, dt: [1], texts: ['one', 'two'] },
    ])
    expect(Object.isFrozen(snapshot)).toBe(true)
    const [record] = snapshot
    expect(record?.type === 'text-chunks' && Object.isFrozen(record.texts)).toBe(true)
    expect(record).not.toHaveProperty('lastTime')
  })

  it('rejects a time that is not a safe integer', () => {
    const accumulator = new AssistantStreamAccumulator()
    expect(() => accumulator.push(timed(1.5, text(0, 'x'))))
      .toThrow('Assistant stream time must be a safe integer, got 1.5')
    expect(accumulator.snapshot()).toEqual([])
  })

  it('rejects a negative, fractional, or negative-zero block index', () => {
    const accumulator = new AssistantStreamAccumulator()
    const negativeZero = Number('-0')
    expect(() => accumulator.push(timed(1, text(-1, 'x')))).toThrow('text-delta index must be a non-negative safe integer')
    expect(() => accumulator.push(timed(1, reasoning(0.5, 'x')))).toThrow('reasoning-delta index must be a non-negative safe integer')
    expect(() => accumulator.push(timed(1, toolCall(-1, 'c1', '{}')))).toThrow('tool-call-delta index must be a non-negative safe integer')
    // Negative zero survives JSON but is not a block index: the durable-boundary validator refuses it.
    expect(() => expandAssistantStream([rogueRecord({ type: 'reasoning-chunks', time0: 0, index: negativeZero, dt: [], texts: ['a'] })]))
      .toThrow('reasoning-chunks index must be a non-negative safe integer')
  })

  it('rejects delta payloads whose fields are not strings', () => {
    const accumulator = new AssistantStreamAccumulator()
    expect(() => accumulator.push(timed(1, rogueChunk({ type: 'text-delta', index: 0, text: 5 }))))
      .toThrow('text-delta text must be a string')
    expect(() => accumulator.push(timed(1, rogueChunk({ type: 'reasoning-delta', index: 0, text: 5 }))))
      .toThrow('reasoning-delta text must be a string')
    expect(() => accumulator.push(timed(1, rogueChunk({ type: 'tool-call-delta', index: 0, id: 5, argumentsDelta: '{}' }))))
      .toThrow('tool-call-delta id must be a string')
    expect(() => accumulator.push(timed(1, rogueChunk({ type: 'tool-call-delta', index: 0, id: 'c1', name: 5, argumentsDelta: '{}' }))))
      .toThrow('tool-call-delta name must be a string')
    expect(() => accumulator.push(timed(1, rogueChunk({ type: 'tool-call-delta', index: 0, id: 'c1', argumentsDelta: 5 }))))
      .toThrow('tool-call-delta argumentsDelta must be a string')
  })

  it('rejects a chunk outside the lossless JSON boundary and a chunk outside the union', () => {
    const accumulator = new AssistantStreamAccumulator()
    expect(() => accumulator.push(timed(1, rogueChunk({ type: 'text-delta', index: 0, text: 'x', extra: undefined }))))
      .toThrow('Assistant stream chunk must be losslessly JSON-serializable')
    expect(() => accumulator.push(timed(1, rogueChunk({ type: 'rogue' }))))
      .toThrow('unreachable variant in AssistantStreamAccumulator.push: {"type":"rogue"}')
    expect(accumulator.snapshot()).toEqual([])
  })
})

describe('expandAssistantStream', () => {
  it('reconstructs one attempt stream exactly, including raw chunks and multi-member runs', () => {
    const stream = compact([
      timed(5, { type: 'block-start', index: 0, blockType: 'text' }),
      timed(10, text(0, 'he')),
      timed(15, text(0, 'llo')),
      timed(20, { type: 'usage', usage }),
      timed(25, { type: 'finish', reason: { kind: 'stop' } }),
    ])
    expect(expandAssistantStream(stream)).toEqual([
      timed(5, { type: 'block-start', index: 0, blockType: 'text' }),
      timed(10, text(0, 'he')),
      timed(15, text(0, 'llo')),
      timed(20, { type: 'usage', usage }),
      timed(25, { type: 'finish', reason: { kind: 'stop' } }),
    ])
    // Re-compacting an expanded stream must reproduce the same compact records.
    expect(compact(expandAssistantStream(stream))).toEqual(stream)
  })

  it('rejects records that are not objects and record types outside the union', () => {
    for (const value of [null, 'text-chunks', 7, [], [{ type: 'chunk' }]]) {
      expect(() => expandAssistantStream([rogueRecord(value)])).toThrow('Assistant stream record must be an object')
    }
    expect(() => expandAssistantStream([rogueRecord({ type: 'wat', time0: 0, index: 0, dt: [], texts: ['a'] })]))
      .toThrow('Unsupported Assistant stream record "wat"')
  })

  it('rejects a text run with unknown keys, non-string members, or no members', () => {
    const base = { type: 'text-chunks', time0: 0, index: 0, dt: [], texts: ['a'] }
    expect(() => expandAssistantStream([rogueRecord({ ...base, extra: 1 })]))
      .toThrow('text-chunks Assistant stream record must contain exactly type, time0, index, dt, texts')
    expect(() => expandAssistantStream([rogueRecord({ ...base, texts: [1] })]))
      .toThrow('text-chunks texts must be a string array')
    expect(() => expandAssistantStream([rogueRecord({ ...base, texts: 'a' })]))
      .toThrow('text-chunks texts must be a string array')
    expect(() => expandAssistantStream([rogueRecord({ ...base, texts: [] })]))
      .toThrow('text-chunks texts must be non-empty')
  })

  it('rejects a run whose dt does not describe exactly one gap per extra member', () => {
    const base = { type: 'reasoning-chunks', time0: 0, index: 0, dt: [1], texts: ['a', 'b'] }
    expect(expandAssistantStream([base])).toEqual([timed(0, reasoning(0, 'a')), timed(1, reasoning(0, 'b'))])
    expect(() => expandAssistantStream([rogueRecord({ ...base, dt: [] })]))
      .toThrow('reasoning-chunks dt length must be one less than its members')
    expect(() => expandAssistantStream([rogueRecord({ ...base, dt: 'x' })]))
      .toThrow('reasoning-chunks dt must contain safe integers')
    expect(() => expandAssistantStream([rogueRecord({ ...base, dt: [1.5] })]))
      .toThrow('reasoning-chunks dt must contain safe integers')
    expect(() => expandAssistantStream([rogueRecord({ ...base, time0: 1.5 })]))
      .toThrow('Assistant stream time must be a safe integer, got 1.5')
    expect(() => expandAssistantStream([rogueRecord({ ...base, index: -1 })]))
      .toThrow('reasoning-chunks index must be a non-negative safe integer')
    expect(() => expandAssistantStream([rogueRecord({ ...base, time0: Number.MAX_SAFE_INTEGER })]))
      .toThrow('reasoning-chunks member times must stay safe integers')
  })

  it('validates Tool-call runs: exact keys, non-empty args, id, and name', () => {
    const named = { type: 'tool-call-chunks', time0: 0, index: 0, dt: [], id: 'c1', name: 'echo', args: ['{}'] }
    expect(expandAssistantStream([named])).toEqual([timed(0, toolCall(0, 'c1', '{}', 'echo'))])
    const unnamed = { type: 'tool-call-chunks', time0: 0, index: 0, dt: [], id: 'c1', args: ['{}'] }
    expect(expandAssistantStream([unnamed])).toEqual([timed(0, toolCall(0, 'c1', '{}'))])
    expect(() => expandAssistantStream([rogueRecord({ ...named, extra: 1 })]))
      .toThrow('tool-call-chunks Assistant stream record must contain exactly type, time0, index, dt, id, name, args')
    expect(() => expandAssistantStream([rogueRecord({ ...unnamed, extra: 1 })]))
      .toThrow('tool-call-chunks Assistant stream record must contain exactly type, time0, index, dt, id, args')
    expect(() => expandAssistantStream([rogueRecord({ ...unnamed, args: [] })]))
      .toThrow('tool-call-chunks args must be non-empty')
    expect(() => expandAssistantStream([rogueRecord({ ...unnamed, args: [1] })]))
      .toThrow('tool-call-chunks args must be a string array')
    expect(() => expandAssistantStream([rogueRecord({ ...unnamed, id: '' })]))
      .toThrow('tool-call-chunks id must be a non-empty string')
    expect(() => expandAssistantStream([rogueRecord({ ...unnamed, id: 1 })]))
      .toThrow('tool-call-chunks id must be a non-empty string')
    expect(() => expandAssistantStream([rogueRecord({ ...named, name: '' })]))
      .toThrow('tool-call-chunks name must be a non-empty string')
    expect(() => expandAssistantStream([rogueRecord({ ...named, name: 1 })]))
      .toThrow('tool-call-chunks name must be a non-empty string')
  })

  it('validates raw chunk records and rejects a chunk outside the lossless JSON boundary', () => {
    const record = { type: 'chunk', time: 3, chunk: { type: 'finish', reason: { kind: 'stop' } } }
    expect(expandAssistantStream([record])).toEqual([timed(3, { type: 'finish', reason: { kind: 'stop' } })])
    expect(() => expandAssistantStream([rogueRecord({ ...record, extra: 1 })]))
      .toThrow('chunk Assistant stream record must contain exactly type, time, chunk')
    expect(() => expandAssistantStream([rogueRecord({ ...record, time: 1.5 })]))
      .toThrow('Assistant stream time must be a safe integer, got 1.5')
    for (const chunk of [null, [], 'chunk', 7]) {
      expect(() => expandAssistantStream([rogueRecord({ ...record, chunk })]))
        .toThrow('Assistant stream raw chunk must be a lossless JSON object')
    }
    // A non-lossless chunk value (an own property JSON would discard) is refused with its cause.
    expect(() => expandAssistantStream([rogueRecord({ ...record, chunk: { type: 'finish', reason: { kind: 'stop' }, extra: undefined } })]))
      .toThrow('Assistant stream raw chunk must be a lossless JSON object')
    expect(() => expandAssistantStream([rogueRecord({ ...record, chunk: { type: 'usage', usage: { inputTokens: Number.NaN, outputTokens: 1 } } })]))
      .toThrow('Assistant stream raw chunk must be a lossless JSON object')
  })
})

describe('stream chunk predicates', () => {
  it('isTokenDelta accepts non-empty fragments and any name-bearing Tool-call delta', () => {
    expect(isTokenDelta(text(0, 'a'))).toBe(true)
    expect(isTokenDelta(text(0, ''))).toBe(false)
    expect(isTokenDelta(reasoning(0, 'a'))).toBe(true)
    expect(isTokenDelta(reasoning(0, ''))).toBe(false)
    expect(isTokenDelta(toolCall(0, 'c1', 'x'))).toBe(true)
    expect(isTokenDelta(toolCall(0, 'c1', ''))).toBe(false)
    expect(isTokenDelta(toolCall(0, 'c1', '', 'echo'))).toBe(true)
    expect(isTokenDelta({ type: 'block-start', index: 0, blockType: 'text' })).toBe(false)
    expect(isTokenDelta({ type: 'usage', usage })).toBe(false)
    expect(isTokenDelta({ type: 'finish', reason: { kind: 'stop' } })).toBe(false)
  })

  it('isVisibleChunk counts non-whitespace text and non-text block kinds', () => {
    expect(isVisibleChunk(text(0, 'hi'))).toBe(true)
    expect(isVisibleChunk(text(0, '  \n'))).toBe(false)
    expect(isVisibleChunk(reasoning(0, 'think'))).toBe(true)
    expect(isVisibleChunk(reasoning(0, '\t'))).toBe(false)
    expect(isVisibleChunk({ type: 'block-start', index: 0, blockType: 'text' })).toBe(false)
    expect(isVisibleChunk({ type: 'block-start', index: 0, blockType: 'reasoning' })).toBe(false)
    expect(isVisibleChunk({ type: 'block-start', index: 0, blockType: 'tool-call' })).toBe(false)
    expect(isVisibleChunk(rogueChunk({ type: 'block-start', index: 0, blockType: 'image' }))).toBe(true)
    expect(isVisibleChunk({ type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } })).toBe(true)
    expect(isVisibleChunk({ type: 'block-end', index: 0, block: { type: 'text', text: ' ' } })).toBe(false)
    expect(isVisibleChunk({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'why' } })).toBe(true)
    expect(isVisibleChunk({ type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('c1'), name: 'echo', arguments: '{}' } })).toBe(false)
    expect(isVisibleChunk(rogueChunk({ type: 'block-end', index: 0, block: { type: 'tool-result', toolCallId: CallId('c1'), content: [] } }))).toBe(true)
    expect(isVisibleChunk(toolCall(0, 'c1', 'x'))).toBe(false)
    expect(isVisibleChunk({ type: 'usage', usage })).toBe(false)
  })

  it('chunkHasVisibleText counts streamed or completed text only', () => {
    expect(chunkHasVisibleText(text(0, 'hi'))).toBe(true)
    expect(chunkHasVisibleText(text(0, ' \n'))).toBe(false)
    expect(chunkHasVisibleText({ type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } })).toBe(true)
    expect(chunkHasVisibleText({ type: 'block-end', index: 0, block: { type: 'text', text: ' ' } })).toBe(false)
    expect(chunkHasVisibleText({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'why' } })).toBe(false)
    expect(chunkHasVisibleText(reasoning(0, 'why'))).toBe(false)
    expect(chunkHasVisibleText(toolCall(0, 'c1', 'x'))).toBe(false)
  })
})

describe('packed run readers', () => {
  const namedToolRun = { type: 'tool-call-chunks', time0: 30, index: 1, dt: [4], id: CallId('c1'), name: 'echo', args: ['{"a"', ':"b"}'] } as const
  const unnamedToolRun = { type: 'tool-call-chunks', time0: 30, index: 1, dt: [4], id: CallId('c1'), args: ['{"a"', ':"b"}'] } as const
  const lateToolRun = { type: 'tool-call-chunks', time0: 30, index: 1, dt: [4], id: CallId('c1'), args: ['', 'x'] } as const
  const textRun = { type: 'text-chunks', time0: 10, index: 0, dt: [5, 5], texts: ['', ' two', ' three'] } as const
  const reasoningRun = { type: 'reasoning-chunks', time0: 10, index: 0, dt: [5], texts: ['  ', 'thought'] } as const

  it('runFirstTokenTime reads a name-bearing Tool-call run at its first member', () => {
    expect(runFirstTokenTime(namedToolRun)).toBe(30)
    expect(runFirstTokenTime(unnamedToolRun)).toBe(30)
    expect(runFirstTokenTime(lateToolRun)).toBe(34)
    expect(runFirstTokenTime(textRun)).toBe(15)
    // A whitespace-only fragment is still a token; only the empty string is skipped.
    expect(runFirstTokenTime(reasoningRun)).toBe(10)
    expect(runFirstTokenTime({ type: 'text-chunks', time0: 10, index: 0, dt: [5], texts: ['', ''] })).toBeUndefined()
  })

  it('runFirstVisibleTime skips whitespace and never reports a Tool-call run', () => {
    expect(runFirstVisibleTime(textRun)).toBe(15)
    expect(runFirstVisibleTime(reasoningRun)).toBe(15)
    expect(runFirstVisibleTime(namedToolRun)).toBeUndefined()
    expect(runFirstVisibleTime({ type: 'reasoning-chunks', time0: 10, index: 0, dt: [5], texts: [' ', '\n'] })).toBeUndefined()
  })

  it('assistantStreamFirstTokenTime stops at the first token carrying record', () => {
    expect(assistantStreamFirstTokenTime([])).toBeUndefined()
    expect(assistantStreamFirstTokenTime([
      { type: 'chunk', time: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
      { type: 'chunk', time: 2, chunk: text(0, '') },
      { type: 'chunk', time: 3, chunk: text(0, 'hi') },
      { type: 'chunk', time: 4, chunk: text(0, 'later') },
    ])).toBe(3)
    expect(assistantStreamFirstTokenTime([{ type: 'chunk', time: 1, chunk: toolCall(0, 'c1', '', 'echo') }])).toBe(1)
    expect(assistantStreamFirstTokenTime([namedToolRun])).toBe(30)
    expect(assistantStreamFirstTokenTime([{ type: 'chunk', time: 9, chunk: { type: 'usage', usage } }, unnamedToolRun])).toBe(30)
    expect(assistantStreamFirstTokenTime([lateToolRun])).toBe(34)
    expect(assistantStreamFirstTokenTime([{ type: 'chunk', time: 9, chunk: { type: 'finish', reason: { kind: 'stop' } } }])).toBeUndefined()
  })

  it('assistantStreamHasVisibleContent answers from raw chunks and packed runs', () => {
    expect(assistantStreamHasVisibleContent([])).toBe(false)
    expect(assistantStreamHasVisibleContent([{ type: 'chunk', time: 1, chunk: { type: 'block-start', index: 0, blockType: 'tool-call' } }])).toBe(false)
    expect(assistantStreamHasVisibleContent([namedToolRun])).toBe(false)
    expect(assistantStreamHasVisibleContent([textRun])).toBe(true)
    expect(assistantStreamHasVisibleContent([{ type: 'chunk', time: 1, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } } }])).toBe(true)
  })

  it('assistantStreamHasVisibleText answers from text runs and completed text blocks', () => {
    expect(assistantStreamHasVisibleText([])).toBe(false)
    expect(assistantStreamHasVisibleText([{ type: 'reasoning-chunks', time0: 0, index: 0, dt: [], texts: ['thought'] }])).toBe(false)
    expect(assistantStreamHasVisibleText([namedToolRun])).toBe(false)
    expect(assistantStreamHasVisibleText([{ type: 'text-chunks', time0: 0, index: 0, dt: [], texts: [' '] }])).toBe(false)
    expect(assistantStreamHasVisibleText([{ type: 'text-chunks', time0: 0, index: 0, dt: [], texts: ['hi'] }])).toBe(true)
    expect(assistantStreamHasVisibleText([{ type: 'chunk', time: 1, chunk: text(0, 'hi') }])).toBe(true)
    expect(assistantStreamHasVisibleText([{ type: 'chunk', time: 1, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'why' } } }])).toBe(false)
  })

  it('lastAssistantStreamChunk finds the final raw chunk of one type', () => {
    const stream: readonly AssistantStreamRecord[] = [
      { type: 'chunk', time: 1, chunk: { type: 'usage', usage } },
      { type: 'text-chunks', time0: 2, index: 0, dt: [], texts: ['hi'] },
      { type: 'chunk', time: 3, chunk: { type: 'usage', usage: { inputTokens: 9, outputTokens: 9 } } },
      { type: 'chunk', time: 4, chunk: { type: 'finish', reason: { kind: 'stop' } } },
    ]
    expect(lastAssistantStreamChunk(stream, 'usage')).toEqual({ type: 'usage', usage: { inputTokens: 9, outputTokens: 9 } })
    expect(lastAssistantStreamChunk(stream, 'finish')).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(lastAssistantStreamChunk(stream, 'block-start')).toBeUndefined()
    expect(lastAssistantStreamChunk([], 'usage')).toBeUndefined()
  })

  it('assistantStreamChunks returns every raw chunk of one type in stream order', () => {
    const first: StreamChunk = { type: 'block-start', index: 0, blockType: 'text' }
    const second: StreamChunk = { type: 'block-start', index: 1, blockType: 'tool-call' }
    const stream: readonly AssistantStreamRecord[] = [
      { type: 'chunk', time: 1, chunk: first },
      { type: 'text-chunks', time0: 2, index: 0, dt: [], texts: ['hi'] },
      { type: 'chunk', time: 3, chunk: second },
    ]
    expect(assistantStreamChunks(stream, 'block-start')).toEqual([first, second])
    expect(assistantStreamChunks(stream, 'finish')).toEqual([])
  })

  it('joinAssistantStreamText joins streamed text runs and raw text deltas only', () => {
    const stream: readonly AssistantStreamRecord[] = [
      { type: 'reasoning-chunks', time0: 0, index: 0, dt: [], texts: ['thought'] },
      { type: 'text-chunks', time0: 1, index: 1, dt: [1], texts: ['he', 'llo'] },
      { type: 'tool-call-chunks', time0: 3, index: 2, dt: [], id: CallId('c1'), args: ['{}'] },
      { type: 'chunk', time: 4, chunk: text(1, ' raw') },
      { type: 'chunk', time: 5, chunk: { type: 'finish', reason: { kind: 'stop' } } },
    ]
    expect(joinAssistantStreamText(stream)).toBe('hello raw')
    expect(joinAssistantStreamText([])).toBe('')
    expect(joinAssistantStreamText([{ type: 'reasoning-chunks', time0: 0, index: 0, dt: [], texts: ['x'] }])).toBe('')
  })
})

describe('assembleAssistantStream', () => {
  const chunks: readonly TimedStreamChunk[] = [
    timed(1, { type: 'block-start', index: 0, blockType: 'reasoning' }),
    timed(2, reasoning(0, 'plan')),
    timed(3, reasoning(0, 'ning')),
    timed(4, { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'planning' } }),
    timed(5, { type: 'block-start', index: 1, blockType: 'text' }),
    timed(6, text(1, 'Hel')),
    timed(7, text(1, 'lo')),
    timed(8, { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello' } }),
    timed(9, { type: 'block-start', index: 2, blockType: 'tool-call' }),
    timed(10, toolCall(2, 'c1', '{"text"', 'echo')),
    timed(11, toolCall(2, 'c1', ':"hi"}', 'echo')),
    timed(12, { type: 'block-end', index: 2, block: { type: 'tool-call', id: CallId('c1'), name: 'echo', arguments: '{"text":"hi"}' } }),
    timed(13, { type: 'usage', usage }),
    timed(14, { type: 'finish', reason: { kind: 'tool-calls' } }),
  ]

  it('assembles the same blocks as the expanded per-chunk sequence', () => {
    const stream = compact(chunks)
    const expected = new BlockAssembler()
    for (const chunk of expandAssistantStream(stream)) expected.push(chunk.chunk)

    const assembled = assembleAssistantStream(stream)
    expect(assembled.blocks()).toEqual([
      { type: 'reasoning', text: 'planning' },
      { type: 'text', text: 'Hello' },
      { type: 'tool-call', id: CallId('c1'), name: 'echo', arguments: '{"text":"hi"}' },
    ])
    expect(assembled.blocks()).toEqual(expected.blocks())
    expect(assembled.message().role).toBe(expected.message().role)
    expect(assembled.message().content).toEqual(expected.message().content)
    expect(assembled.usage).toEqual({ inputTokens: 3, outputTokens: 4 })
    expect(assembled.finish).toEqual({ kind: 'tool-calls' })
    expect(joinAssistantStreamText(stream)).toBe('Hello')
  })

  it('returns the caller-supplied assembler and pushes an unnamed Tool-call run without a name', () => {
    const stream: readonly AssistantStreamRecord[] = [
      { type: 'tool-call-chunks', time0: 1, index: 0, dt: [1], id: CallId('c1'), args: ['{"a"', ':1}'] },
    ]
    const assembler = new BlockAssembler()
    expect(assembleAssistantStream(stream, assembler)).toBe(assembler)
    expect(assembler.blocks()).toEqual([
      { type: 'tool-call', id: CallId('c1'), name: '', arguments: '{"a":1}' },
    ])
  })

  it('rejects a record outside the compact union', () => {
    expect(() => assembleAssistantStream([rogueRecord({ type: 'wat' })]))
      .toThrow('unreachable variant in assembleAssistantStream: {"type":"wat"}')
  })
})
