import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionRemoteHistoryEntry, SessionRemoteSemanticHistoryValue } from '@deepseek-ai/dsh-session'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { SessionObservationReader } from '../../../session-query/session-query/src/observation.ts'
import { SemanticHistoryReader } from '../src/semantic-history.ts'

const execute = promisify(execFile)

// This is a cross-language contract for the native product. Other platforms
// retain the Host history suites; the macOS gate compiles the actual reducer.
describe.runIf(process.platform === 'darwin')('semantic timing seed / Native reducer parity', () => {
  let scratch: string
  let executable: string

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'ark-semantic-metrics-'))
    executable = join(scratch, 'metrics')
    const root = resolve('integrations/jiuzhang/native/Sources')
    const api = await readFile(join(root, 'JiuzhangShellCore/ArkAPIClient.swift'), 'utf8')
    const metrics = await readFile(join(root, 'JiuzhangShellUI/ArkChatTurnMetrics.swift'), 'utf8')
    const extract = (start: string, end: string): string => {
      const from = api.indexOf(start)
      const to = api.indexOf(end, from)
      if (from < 0 || to < from) throw new Error(`Native type boundary missing: ${start}`)
      return api.slice(from, to)
    }
    const probe = `import Foundation
${extract('public enum JSONValue:', '/// One workspace')}
${extract('public struct ArkHistoryEvent:', '/// One backward history page')}
${metrics.replace('import JiuzhangShellCore', '')}
struct Fixture: Decodable {
  struct Event: Decodable {
    let seq: Int
    let type: String
    let time: Double
    let data: JSONValue
    var native: ArkHistoryEvent {
      ArkHistoryEvent(id: seq, type: type, time: Date(timeIntervalSince1970: time / 1000), data: data, view: nil)
    }
  }
  struct Cut: Decodable { let through: Int; let seed: [Event] }
  let raw: [Event]
  let cuts: [Cut]
}
let fixtures = try JSONDecoder().decode([Fixture].self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
var failures: [Int] = []
var index = 0
for fixture in fixtures {
  let events = fixture.raw.map(\\.native)
  for cut in fixture.cuts {
    let full = ArkChatTurnProjection(events: Array(events.prefix(cut.through + 1)))
    let compact = ArkChatTurnProjection(events: cut.seed.map(\\.native))
    if full != compact { failures.append(index) }
    index += 1
  }
}
print(String(data: try JSONEncoder().encode(failures), encoding: .utf8)!)
`
    const source = join(scratch, 'main.swift')
    await writeFile(source, probe)
    // The complete turn-state projection includes localized lifecycle labels;
    // compile its real production dependencies rather than dropping that code.
    await execute('swiftc', [
      '-O', '-module-cache-path', join(scratch, 'modules'), source,
      join(root, 'JiuzhangShellUI/ArkLanguagePreference.swift'),
      join(root, 'JiuzhangShellUI/ArkL10n.swift'),
      '-o', executable,
    ], { timeout: 120_000 })
  }, 150_000)

  afterAll(async () => { if (scratch !== undefined) await rm(scratch, { recursive: true, force: true }) })

  it('preserves complete projection state across active cuts, retries, resets, and a dense answer', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const observations = new SessionObservationReader(ctx)
    ctx.provide('sessionQuery', { observeSession: observations.read.bind(observations) } as never)
    const present = async (event: SessionEvent): Promise<SessionRemoteHistoryEntry> => ({
      event: { type: event.type, seq: event.seq, time: event.time, data: z.json().parse(snapshotJsonValue(event.data)) },
    })
    const reader = new SemanticHistoryReader(ctx, () => present)
    const signal = new AbortController().signal
    const fixtures: { raw: SessionRemoteHistoryEntry['event'][]; cuts: { through: number; seed: SessionRemoteHistoryEntry['event'][] }[] }[] = []
    let clock = 1_000_000
    const now = vi.spyOn(Date, 'now').mockImplementation(() => { clock += 17; return clock })
    try {
      for (let variant = 0; variant < 16; variant += 1) {
        const session = ctx.sessions.create(SessionId(`native-timing-${String(variant)}`), { meta: { cwd: '/workspace' } })
        const cuts: { through: number; page: SessionRemoteSemanticHistoryValue }[] = []
        const capture = async (): Promise<void> => {
          const page = await reader.read({ sessionId: session.id, view: 'semantic' }, signal)
          if (page.view !== 'semantic') throw new Error('Expected semantic cut')
          cuts.push({ through: session.events.length - 1, page })
        }
        for (let turn = 0; turn < 3; turn += 1) {
          session.append('turn/start', { turn })
          for (let step = 0; step < 2; step += 1) {
            session.append('step/start', { turn, step })
            const count = variant === 0 && turn === 0 && step === 0 ? 60_010 : 3 + variant
            const source: number[] = []
            for (let chunk = 0; chunk < count; chunk += 1) {
              source.push(session.append('assistant/chunk', { turn, step, chunk: { type: 'text-delta', index: 0, text: '文🙂' } }).seq)
              if (chunk === 1 || chunk === count - 1) await capture()
            }
            if (variant % 3 === 0) {
              source.push(session.append('assistant/chunk', { turn, step, chunk: {
                type: 'finish', reason: { kind: 'aborted', failure: { code: 'aborted', message: 'Fixture stream cancelled' } },
              } }).seq)
              await capture()
              // A new stream in the same step must reset throughput timing.
              for (let retry = 0; retry < 3; retry += 1) {
                source.push(session.append('assistant/chunk', { turn, step, chunk: { type: 'text-delta', index: 0, text: 'retry' } }).seq)
              }
            }
            session.append('assistant/message', {
              turn, step,
              message: createAssistantMessage({ content: [{ type: 'text', text: 'canonical' }], source: { provider: 'fixture', model: 'fixture' } }),
              usage: { inputTokens: 5, outputTokens: variant === 1 ? 0 : 20, totalTokens: variant === 1 ? 5 : 25 },
            }, { surfaceOp: 'append', sourceEventSeqs: source })
            await capture()
            session.append('step/end', { turn, step })
          }
          session.append('turn/end', {
            turn, reason: variant % 2 === 0 ? { kind: 'completed' } : { kind: 'aborted', reason: { kind: 'user' } },
          })
          await capture()
        }
        const raw = await Promise.all(session.events.map(present))
        const fixture: typeof fixtures[number] = { raw: raw.map(entry => entry.event), cuts: [] }
        fixtures.push(fixture)
        for (const { through, page } of cuts) {
          let text = ''
          let offset = 0
          let contentReadId: string | undefined
          for (;;) {
            const part = await reader.read({ sessionId: session.id, view: 'content', sourceRevision: page.sourceRevision,
              recordId: page.dependencyRecords.turn, offset, maxCodeUnits: 4_097,
              ...contentReadId === undefined ? {} : { contentReadId } }, signal)
            if (part.view !== 'content') throw new Error('Expected timing content')
            text += part.text
            if (part.done) break
            contentReadId = part.contentReadId
            offset = part.nextOffset
          }
          const bundle = z.object({ chunkCoverage: z.literal('timing-boundaries'), entries: z.array(z.object({
            event: z.object({ seq: z.number(), type: z.string(), time: z.number(), data: z.json() }),
          })) }).parse(JSON.parse(text))
          fixture.cuts.push({ through, seed: bundle.entries.map(entry => entry.event) })
          expect(bundle.entries.length).toBeLessThan(100)
        }
      }
      const input = join(scratch, 'fixtures.json')
      await writeFile(input, JSON.stringify(fixtures))
      const result = await execute(executable, [input], { timeout: 30_000 })
      expect(JSON.parse(result.stdout)).toEqual([])
      expect(fixtures.reduce((count, fixture) => count + fixture.cuts.length, 0)).toBeGreaterThan(300)
    } finally {
      now.mockRestore()
      reader.clear()
      await ctx.fiber.dispose()
    }
  }, 90_000)
})
