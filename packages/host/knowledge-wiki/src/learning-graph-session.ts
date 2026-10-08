/** Verify captured Session/render/request relations without dispatching a request or changing a log. */

import { Session, SessionId, KNOWN_SESSION_EVENT_TYPES, foldRequestHeader, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { ArtifactRef } from './learning-artifacts.ts'
import { GraphContext, digest, equal, originalText, requireRelation } from './learning-graph-context.ts'
import * as S from './learning-graph-schema.ts'
import { sha256 } from './verifier.ts'

/** One consumed request/read budget reservation at its authenticated journal position. */
export interface RecordedReservation { readonly value: S.Reservation; readonly timestamp: string; readonly seq: number }

const object = z.record(z.string(), z.unknown())
const knownEvents = new Set<string>(KNOWN_SESSION_EVENT_TYPES)

function hasEventType(event: { readonly type: string }, type: string): boolean { return event.type === type }

function session(ctx: GraphContext, ref: ArtifactRef, sessionId: string) {
  const value = ctx.json(ref, S.sessionPrefix)
  requireRelation(value.sessionId === sessionId && value.throughSeq === value.events.length - 1)
  for (const raw of value.events) {
    const event = object.parse(raw)
    requireRelation(typeof event['type'] === 'string' && (knownEvents.has(event['type']) || event['ignorable'] === true))
  }
  // The existing restoration owner validates the header, event envelopes, sequence and surface.
  // Its synthetic end-seed marker belongs only to this detached projection, never to the evidence.
  const restored = Session.fromRestore(SessionId(sessionId), structuredClone(value.events) as SessionEvent[],
    structuredClone(value.header) as SessionHeader)
  return { value, restored, events: value.events as SessionEvent[] }
}

function isPrefix(prefix: readonly SessionEvent[], complete: readonly SessionEvent[]): boolean {
  return prefix.length <= complete.length && prefix.every((event, index) => equal(event, complete[index]))
}

/** Check complete signed use facts against the original Session and consumed journal reservations.
 * @param ctx - Selected bounded artifact and owner context.
 * @param use - Independently signed complete use facts.
 * @param arm - Preregistered arm, including original Session/world hashes.
 * @param grant - Authenticated scoped authorization.
 * @param proposal - Frozen evaluated canonical transformation.
 * @param reservations - Complete authenticated consumed request/read reservations.
 * @param validateRetrieval - Reconcile each actual read with the full journal and pre-exposure admission.
 */
export function validateUseSession(
  ctx: GraphContext,
  use: S.MeasuredUse,
  arm: S.TrialArm,
  grant: S.Authorization,
  proposal: S.Proposal,
  reservations: ReadonlyMap<string, RecordedReservation>,
  validateRetrieval: (reservation: RecordedReservation, timestamp: string) => void,
): void {
  const complete = session(ctx, use.completeSession, use.sessionId)
  requireRelation(digest(complete.value.header) === arm.initialSessionHeaderHash)
  let initialLength = -1
  for (let length = 1; length <= complete.events.length; length += 1) {
    if (digest({ ...complete.value, throughSeq: length - 1, events: complete.events.slice(0, length) }) === arm.initialSessionPrefixHash) {
      initialLength = length
      break
    }
  }
  requireRelation(initialLength >= 0)
  const liveEvents = complete.events.slice(initialLength)
  requireRelation(liveEvents.some(event => event.type === 'turn/end'))
  const last = liveEvents.at(-1)
  requireRelation(last?.type === 'turn/end')
  requireRelation(complete.events.every(event => event.time <= Date.parse(use.endedAt)))
  requireRelation(liveEvents.every(event => event.time >= Date.parse(use.startedAt)))
  requireRelation(!liveEvents.some(event => event.type === 'session/end-seed' || hasEventType(event, 'compaction/start')))
  const injected = new Set<number>()
  const readReservations = new Set<string>()
  const requestIds = new Set<string>()
  const requestPrefixes: number[] = []
  const requestAnchors = new Set<number>()
  const initialEvents = complete.events.slice(0, initialLength)
  const initialBoundary = initialEvents.findLast(event => event.type === 'step/start' || event.type === 'step/end')
  const initialAnchor = initialBoundary?.type === 'step/start'
    ? initialEvents.findLast(event => event.type === 'step/start' || hasEventType(event, 'llm/retry-started')) : undefined
  const liveAttemptAnchors = [...(initialAnchor === undefined ? [] : [initialAnchor]),
    ...liveEvents.filter(event => event.type === 'step/start' || hasEventType(event, 'llm/retry-started'))]
  const reservedRequests = [...reservations.values()].filter(row => row.value.useId === use.useId && row.value.phase === 'model-request')
  requireRelation(use.requests.length === reservedRequests.length && use.requests.length > 0)

  for (const [index, ref] of use.requests.entries()) {
    ctx.json(ref, S.providerRequest, (request) => {
      requireRelation(!requestIds.has(request.attemptId))
      requestIds.add(request.attemptId)
      requireRelation(request.useId === use.useId && request.grantId === grant.grantId && request.sessionId === use.sessionId
        && request.model === use.run.model && request.modelConfigHash === use.run.modelConfigHash && request.ordinal === index + 1
        && request.bodySha256 === request.requestBody.digest)
      requireRelation(request.sentAt >= grant.notBefore && request.sentAt <= grant.deadline
        && request.sentAt >= use.startedAt && request.sentAt <= use.endedAt)
      requireRelation(request.settledAt === null || (request.settledAt >= request.sentAt && request.settledAt <= use.endedAt))
      requireRelation(request.dispatchState !== 'response-received' || (request.httpStatus !== null && request.settledAt !== null))
      requireRelation(request.dispatchState !== 'reserved' || (request.httpStatus === null && request.settledAt === null))
      const reservation = reservedRequests.find(row => row.value.requestAttemptId === request.attemptId)
      requireRelation(reservation !== undefined && reservation.timestamp <= request.sentAt)
      requireRelation(reservation.value.sessionId === use.sessionId && reservation.value.grantId === grant.grantId
        && reservation.value.proposalHash === use.proposalHash && reservation.value.sessionPrefixHash === request.sessionPrefix.digest
        && reservation.value.ordinal === request.ordinal && reservation.value.turn === request.turn
          && reservation.value.step === request.step
        && reservation.value.callId === null)
      const prefix = session(ctx, request.sessionPrefix, use.sessionId)
      requireRelation(isPrefix(prefix.events, complete.events) && prefix.events.length >= initialLength)
      requireRelation(prefix.events.every(event => event.time <= Date.parse(request.sentAt)))
      requestPrefixes.push(prefix.value.throughSeq)
      const activeStep = prefix.events.findLast(event => event.type === 'step/start')
      requireRelation(activeStep?.type === 'step/start' && activeStep.data.turn === request.turn && activeStep.data.step === request.step)
      const anchor = prefix.events.findLast(event => event.type === 'step/start' || hasEventType(event, 'llm/retry-started'))
      requireRelation(anchor !== undefined && (anchor.seq >= initialLength || anchor.seq === initialAnchor?.seq)
        && !requestAnchors.has(anchor.seq))
      const anchorData = object.parse(anchor.data)
      requireRelation(anchorData['turn'] === request.turn && anchorData['step'] === request.step
        && anchor.time <= Date.parse(request.sentAt))
      requestAnchors.add(anchor.seq)
      const header = foldRequestHeader(prefix.events)
      requireRelation(header !== undefined && header.config.provider === use.run.provider && header.config.model === use.run.model
        && digest(header.config) === use.run.modelConfigHash)
      const expected = {
        ...header.config, messages: prefix.restored.deriveMessages(),
        ...(header.system === undefined ? {} : { system: header.system }),
        ...(header.tools === undefined ? {} : { tools: header.tools }), sessionId: use.sessionId,
      }
      ctx.json(request.providerInput, object, (input) => { requireRelation(equal(input, expected)) })
      // The external measurement signs the exact final-body relation. The product observer,
      // not a replay-time reimplementation of each provider serializer, captures those bytes.
      ctx.owner.artifacts.visit(request.requestBody, (bytes) => {
        const body = originalText(bytes)
        requireRelation(body.length > 0 && sha256(Buffer.from(bytes)) === request.bodySha256)
      })
    })
  }
  // A jointly omitted receipt/reservation must not erase a logged initial or retry attempt.
  // Even an interrupted step requires its explicit reserved/unknown attempt fact.
  requireRelation(liveAttemptAnchors.length === requestAnchors.size && liveAttemptAnchors.every(event => requestAnchors.has(event.seq)))

  for (const fact of use.injections) {
    requireRelation(fact.evaluatedContentHash === proposal.evaluatedContentHash && fact.sourceContentHash === proposal.evaluatedContentHash)
    requireRelation(!readReservations.has(fact.reservationId))
    readReservations.add(fact.reservationId)
    const reserved = reservations.get(fact.reservationId)
    requireRelation(reserved !== undefined && reserved.value.phase === 'knowledge-read' && reserved.value.callId === fact.callId
      && reserved.value.useId === use.useId && reserved.value.grantId === grant.grantId && reserved.value.sessionId === use.sessionId
      && reserved.value.requestAttemptId === null && reserved.value.proposalHash === use.proposalHash)
    const event = (reference: z.infer<typeof S.eventRef>, type: string): SessionEvent => {
      requireRelation(reference.sessionId === use.sessionId)
      const prefix = session(ctx, reference.sessionPrefix, use.sessionId)
      requireRelation(isPrefix(prefix.events, complete.events))
      const result = prefix.events[reference.seq]
      requireRelation(result !== undefined && result.type === type && digest(result) === reference.eventHash)
      return result
    }
    const call = event(fact.toolCall, 'tool/call')
    const retrieval = event(fact.retrieved, 'knowledge/retrieved')
    const injection = event(fact.injected, 'knowledge/injected')
    const result = event(fact.toolResult, 'tool/result')
    requireRelation(call.seq < retrieval.seq && retrieval.seq < injection.seq && injection.seq < result.seq)
    requireRelation(Date.parse(reserved.timestamp) <= retrieval.time && call.seq >= initialLength)
    validateRetrieval(reserved, new Date(retrieval.time).toISOString())
    const reservedPrefix = { ...complete.value, throughSeq: call.seq, events: complete.events.slice(0, call.seq + 1) }
    requireRelation(digest(reservedPrefix) === reserved.value.sessionPrefixHash)
    requireRelation(call.type === 'tool/call' && call.data.callId === fact.callId && call.data.name === 'wiki_read'
      && equal(JSON.parse(call.data.arguments) as unknown, { path: proposal.targetPath })
      && call.data.turn === reserved.value.turn && call.data.step === reserved.value.step)
    requireRelation(result.type === 'tool/result')
    const message = object.parse(result.data.message)
    const source = object.parse(message['source'])
    const blocks = z.array(object).parse(message['content'])
    const block = blocks[0]
    requireRelation(source['kind'] === 'tool' && source['callId'] === fact.callId && blocks.length === 1
      && block?.['type'] === 'tool-result' && block['toolCallId'] === fact.callId && block['isError'] === false)
    const rendered = block['content']
    // Canonical Session JSON does not preserve the original object's property insertion order.
    // Authenticate the captured original rendering, then compare its parsed content structurally.
    const renderedBytes = ctx.text(fact.renderedToolResult)
    requireRelation(sha256(renderedBytes) === fact.renderedToolResultHash)
    requireRelation(equal(JSON.parse(renderedBytes) as unknown, rendered))
    const read = object.parse(retrieval.data)
    const shown = object.parse(injection.data)
    requireRelation(read['callId'] === fact.callId && shown['callId'] === fact.callId && read['tool'] === 'wiki_read'
      && shown['tool'] === 'wiki_read'
      && read['path'] === proposal.targetPath && shown['path'] === proposal.targetPath && read['allowed'] === true
      && read['sourceContentHash'] === proposal.evaluatedContentHash && shown['sourceContentHash'] === proposal.evaluatedContentHash
      && shown['knowledgeId'] === proposal.knowledgeId && shown['resultHash'] === fact.renderedToolResultHash
      && shown['contentHash'] === fact.renderedToolResultHash && equal(shown['value'], rendered)
      && shown['contentBytes'] === Buffer.byteLength(renderedBytes))
    const expectedRead = { path: proposal.targetPath, content: ctx.text(proposal.targetAfter) }
    requireRelation(equal(read['value'], expectedRead))
    requireRelation(read['resultHash'] === sha256(JSON.stringify(expectedRead)) && read['contentHash'] === read['resultHash'])
    requireRelation(!injected.has(injection.seq))
    injected.add(injection.seq)
    requireRelation(requestPrefixes.some(seq => seq >= result.seq))
  }

  const reservedReads = [...reservations.values()].filter(row => row.value.useId === use.useId && row.value.phase === 'knowledge-read')
  requireRelation(reservedReads.length === readReservations.size)
  for (const event of complete.events) {
    if (!hasEventType(event, 'knowledge/injected')) continue
    const data = object.parse(event.data)
    if (data['sourceContentHash'] === proposal.evaluatedContentHash || data['knowledgeId'] === proposal.knowledgeId) {
      requireRelation(use.variant === 'candidate' && injected.has(event.seq))
    }
  }
  requireRelation(use.variant === 'candidate'
    ? use.injections.length > 0 && use.exposure.candidatePresent && use.exposure.verdict === 'pass'
    : use.injections.length === 0 && !use.exposure.candidatePresent && use.exposure.verdict === 'pass')
}
