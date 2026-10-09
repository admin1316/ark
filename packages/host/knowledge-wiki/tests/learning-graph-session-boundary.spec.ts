/** Detached synthetic Session facts exercise the real restore/graph owners; no provider runs or learning credit. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Session, SessionId, foldRequestHeader, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { GraphContext, digest } from '../src/learning-graph-context.ts'
import { validateUseSession, type RecordedReservation } from '../src/learning-graph-session.ts'
import * as S from '../src/learning-graph-schema.ts'
import { createLearningGraphFixture } from './learning-graph-fixture.ts'
import { graphFixtureOwner } from './learning-graph-coverage-owner.ts'

type Fixture = ReturnType<typeof createLearningGraphFixture>
type Json = Record<string, unknown>
const fixtures: Fixture[] = []
afterEach(() => { for (const value of fixtures.splice(0)) value.artifacts.dispose() })
function fixture(): Fixture {
  const value = createLearningGraphFixture()
  fixtures.push(value)
  return value
}

/** Re-freeze genuine Session prefixes after a detached test mutation, preserving every request/read reservation. */
function facts(value: Fixture, index: 0 | 1, edit: (events: Json[]) => void, rebuildInput = true) {
  const use = S.use.parse(value.usePayloads[index])
  const arm = S.arm.parse(value.sessions[index]!.arm)
  const complete = S.sessionPrefix.parse(value.artifacts.json(use.completeSession))
  const initial = S.sessionPrefix.parse(value.artifacts.json(value.sessions[index]!.initialPrefix))
  const events = structuredClone(complete.events) as Json[]
  edit(events)
  const prefix = (throughSeq: number) => ({ ...complete, throughSeq, events: events.slice(0, throughSeq + 1) })
  const reservations = new Map<string, RecordedReservation>()
  for (const event of value.journal.events) {
    const payload = event['payload'] as Json
    if (payload['type'] !== 'knowledge/trial-consumed') continue
    const reservation = S.reservation.parse(payload['reservation'])
    if (reservation.useId === use.useId) reservations.set(reservation.reservationId,
      { value: reservation, timestamp: String(event['timestamp']), seq: Number(event['seq']) })
  }
  use.requests = use.requests.map((ref) => {
    const request = S.providerRequest.parse(value.artifacts.json(ref))
    const oldPrefix = S.sessionPrefix.parse(value.artifacts.json(request.sessionPrefix))
    const projected = prefix(oldPrefix.throughSeq)
    request.sessionPrefix = value.artifacts.put(projected)
    if (rebuildInput) {
      const projectedEvents = projected.events as unknown as SessionEvent[]
      const restored = Session.fromRestore(SessionId(use.sessionId), projectedEvents,
        structuredClone(projected.header) as SessionHeader)
      const header = foldRequestHeader(projectedEvents)!
      request.providerInput = value.artifacts.put({ ...header.config, messages: restored.deriveMessages(),
        ...header.system === undefined ? {} : { system: header.system },
        ...header.tools === undefined ? {} : { tools: header.tools }, sessionId: use.sessionId })
    }
    for (const [id, row] of reservations) if (row.value.requestAttemptId === request.attemptId) {
      reservations.set(id, { ...row, value: { ...row.value, sessionPrefixHash: request.sessionPrefix.digest } })
    }
    return value.artifacts.put(request)
  })
  use.injections = use.injections.map((injection) => {
    const next = { ...injection }
    for (const key of ['toolCall', 'retrieved', 'injected', 'toolResult'] as const) {
      const original = injection[key]
      const oldPrefix = S.sessionPrefix.parse(value.artifacts.json(original.sessionPrefix))
      next[key] = { ...original, eventHash: digest(events[original.seq]),
        sessionPrefix: value.artifacts.put(prefix(oldPrefix.throughSeq)) }
    }
    const reserved = reservations.get(injection.reservationId)!
    reservations.set(injection.reservationId, { ...reserved,
      value: { ...reserved.value, sessionPrefixHash: digest(prefix(injection.toolCall.seq)) } })
    return next
  })
  use.completeSession = value.artifacts.put({ ...complete, events })
  arm.initialSessionPrefixHash = digest(prefix(initial.throughSeq))
  const validateRetrieval = vi.fn()
  const validate = () => {
    validateUseSession(new GraphContext(graphFixtureOwner(value)), use, arm,
      S.authorization.parse(value.authorization), S.proposal.parse(value.proposalPayload), reservations, validateRetrieval)
  }
  return { validate, validateRetrieval, use }
}

describe('complete original Session boundary relations', () => {
  it('allows an explicitly ignorable unknown event while refusing an unmarked unknown event', () => {
    const value = fixture()
    const rewrite = (ignorable: boolean) => facts(value, 0, (events) => {
      const context = events.find(event => event['type'] === 'request/context')!
      context['type'] = 'synthetic/optional-extension'
      context['ignorable'] = ignorable
    }, ignorable)
    expect(() => { rewrite(true).validate() }).not.toThrow()
    expect(() => { rewrite(false).validate() }).toThrow('invalid learning graph relation')
  })

  it('keeps optional system/tools fields matched to the original captured request header', () => {
    const value = fixture()
    const prepared = facts(value, 1, (events) => {
      const event = events.find(row => row['type'] === 'request/header')!
      const header = (event['data'] as Json)['header'] as Json
      delete header['system']
      header['tools'] = [{ name: 'synthetic_probe', description: 'Test-only schema, never dispatched',
        parameters: { type: 'object', properties: {}, required: [] } }]
    })
    expect(prepared.validate).not.toThrow()
    expect(prepared.validateRetrieval).toHaveBeenCalledTimes(1)
  })

  it.each(['no-transport-result', 'invented-status', 'invented-settlement'] as const)(
    'preserves an explicit reserved attempt without inventing transport completion (%s)', (state) => {
      const value = fixture()
      const prepared = facts(value, 0, () => {})
      const request = S.providerRequest.parse(value.artifacts.json(prepared.use.requests[0]!))
      request.dispatchState = 'reserved'
      request.providerRequestId = null
      request.httpStatus = state === 'invented-status' ? 200 : null
      request.settledAt = state === 'invented-settlement' ? request.sentAt : null
      prepared.use.requests[0] = value.artifacts.put(request)
      if (state === 'no-transport-result') expect(prepared.validate).not.toThrow()
      else expect(prepared.validate).toThrow('invalid learning graph relation')
      expect(prepared.validateRetrieval).not.toHaveBeenCalled()
    },
  )

  it('binds an initial retry anchor to its own captured provider attempt', () => {
    const value = fixture()
    const prepared = facts(value, 0, (events) => {
      const event = events.find(row => row['type'] === 'request/context')!
      event['type'] = 'llm/retry-started'
      event['ignorable'] = true
      event['data'] = { turn: 0, step: 0 }
    })
    expect(prepared.validate).not.toThrow()
    expect(prepared.validateRetrieval).not.toHaveBeenCalled()
  })

  it.each(['step/end', 'synthetic/ignored-boundary'])('refuses requests without an active initial step (%s)', (type) => {
    const value = fixture()
    const prepared = facts(value, 0, (events) => {
      const event = events.find(row => row['type'] === 'step/start')!
      event['type'] = type
      if (type.startsWith('synthetic/')) event['ignorable'] = true
    }, false)
    expect(prepared.validate).toThrow('invalid learning graph relation')
  })

  it.each(['unrelated', 'same-content', 'same-knowledge-id'] as const)(
    'checks preexisting injection relevance by both identity and exact content (%s)', (binding) => {
      const value = fixture()
      const prepared = facts(value, 0, (events) => {
        const event = events.find(row => row['type'] === 'request/context')!
        event['type'] = 'knowledge/injected'
        event['data'] = {
          sourceContentHash: binding === 'same-content' ? value.proposalPayload['evaluatedContentHash'] : digest('unrelated content'),
          knowledgeId: binding === 'same-knowledge-id' ? value.proposalPayload['knowledgeId'] : 'unrelated-knowledge-id',
        }
      })
      if (binding === 'unrelated') expect(prepared.validate).not.toThrow()
      else expect(prepared.validate).toThrow('invalid learning graph relation')
    },
  )
})
