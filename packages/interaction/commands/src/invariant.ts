/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-commands`:
 * command lifecycle events pair by commandId within one session log.
 * @module @deepseek-ai/dsh-commands/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-commands'

/** Cordis companion plugin name. */
export const name = 'commands-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Install pairing validation over loaded logs and newly appended lifecycle events. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  // Install-scoped so a dispose/re-register cycle re-sweeps from a clean slate.
  const runIds = new WeakMap<Session, Set<string>>()
  const doneIds = new WeakMap<Session, Set<string>>()
  const invocationIds = new WeakMap<Session, Set<string>>()
  const validateEvent = (session: Session, event: SessionEvent): void => {
    if (event.type === 'command/run') {
      const { invocationId, inputDigest } = event.data
      let invocations: Set<string> | undefined
      if (invocationId !== undefined || inputDigest !== undefined) {
        if (typeof invocationId !== 'string' || invocationId.length === 0
            || typeof inputDigest !== 'string' || !/^command-v1:[a-f0-9]{64}$/u.test(inputDigest)) {
          fail('command/run has invalid invocation metadata')
        }
        if (event.seq >= (session.header.seedLength ?? 0)) {
          invocations = invocationIds.get(session) ?? new Set<string>()
          if (invocations.has(invocationId)) fail('command/run repeats invocationId')
        }
      }
      const ids = runIds.get(session) ?? new Set<string>()
      if (ids.has(event.data.commandId)) {
        fail(`command/run repeats commandId ${JSON.stringify(event.data.commandId)}`)
      }
      ids.add(event.data.commandId)
      runIds.set(session, ids)
      if (invocations !== undefined) {
        invocations.add(invocationId as string)
        invocationIds.set(session, invocations)
      }
      return
    }
    if (event.type !== 'command/done') return
    const settled = doneIds.get(session) ?? new Set<string>()
    if (settled.has(event.data.commandId)) fail('command/done repeats a settled commandId')
    if (runIds.get(session)?.has(event.data.commandId) !== true) {
      fail(`command/done ${JSON.stringify(event.data.commandId)} pairs no prior command/run in this log`)
    }
    const source = event.data.sourceEventSeq
    const sourceEvent = source === undefined ? undefined : session.events[source]
    if (source !== undefined
      && (event.data.kind !== 'success'
        || !Number.isSafeInteger(source) || source < 0 || source >= event.seq
        || sourceEvent?.seq !== source
        || sourceEvent.type === 'command/run'
        || sourceEvent.type === 'command/done')) {
      fail(`command/done ${JSON.stringify(event.data.commandId)} has invalid sourceEventSeq ${String(source)}`)
    }
    settled.add(event.data.commandId)
    doneIds.set(session, settled)
  }
  for (const session of ctx.sessions.list()) {
    for (const event of session.events) validateEvent(session, event)
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    validateEvent(session, event)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
