/** Durable checkpoints and backpressure before model and tool production. */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { TOOL_ABORTED_BEFORE_DISPATCH, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { SessionStorageUnavailable, waitForPersistenceOperation } from '@deepseek-ai/dsh-session-persistence'

export const name = 'session-checkpoint-policy'
export const inject = ['llm', 'sessionPersistence', 'sessions', 'tools']

/** Stop only the exact producer whose logged session this checkpoint owns. */
function stopProducer(ctx: Context, session: Session, error: unknown): never {
  const agent = ctx.get('agents')?.get(session.id)
  if (agent?.session === session) agent.cancel({ kind: 'hook', reason: 'session storage is unavailable' }, { keepInbox: true })
  throw error
}

/** Await a bounded producer checkpoint while the writer keeps its own barrier. */
async function checkpoint(ctx: Context, session: Session, signal?: AbortSignal): Promise<void> {
  const persistence = ctx.sessionPersistence
  const health = persistence.writeState(session)
  const deadline = new AbortController()
  const timer = setTimeout(() =>{  deadline.abort(new SessionStorageUnavailable('storage-stalled')) }, health.waitTimeoutMs)
  const waitSignal = signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal])
  try {
    if (health.phase === 'failed' || health.phase === 'closing') {
      throw new SessionStorageUnavailable(health.phase === 'closing' ? 'storage-closing' : health.errorCode)
    }
    waitSignal.throwIfAborted()
    if (health.phase === 'pressured') await persistence.waitForCapacity(session, waitSignal)
    await waitForPersistenceOperation(ctx.sessions.flush(session), waitSignal)
    waitSignal.throwIfAborted()
  } catch (error: unknown) {
    if (signal?.aborted === true) throw error
    stopProducer(ctx, session, deadline.signal.aborted ? new SessionStorageUnavailable('storage-stalled') : error)
  } finally {
    clearTimeout(timer)
  }
}

function afterCheckpoint(
  ctx: Context, session: Session, signal: AbortSignal | undefined, next: () => AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  return (async function* (): AsyncIterable<StreamChunk> {
    await checkpoint(ctx, session, signal)
    for await (const chunk of next()) {
      yield chunk
      try {
        const health = ctx.sessionPersistence.writeState(session)
        if (health.phase === 'healthy') continue
        if (signal !== undefined) await ctx.sessionPersistence.waitForCapacity(session, signal)
        else {
          const controller = new AbortController()
          await ctx.sessionPersistence.waitForCapacity(session, controller.signal)
        }
      } catch (error: unknown) {
        if (signal?.aborted === true) throw error
        stopProducer(ctx, session, error)
      }
    }
  })()
}

function abortedBeforeDispatchResult(): ToolExecutionResult {
  return { content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }], isError: true,
    error: { message: 'tool call aborted before dispatch', info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH } } }
}

/**
 * Install lossless write checkpoints and controlled stream consumption.
 * @param ctx - plugin lifecycle owning the listeners.
 */
export function apply(ctx: Context): void {
  ctx.on('llm/stream', (options, next): AsyncIterable<StreamChunk> => {
    if (options.sessionId === undefined) return next()
    const session = ctx.sessions.get(options.sessionId)
    return session === undefined ? next() : afterCheckpoint(ctx, session, options.signal, next)
  })
  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    if (exec.agent === undefined || exec.parent !== undefined) return next()
    try { await checkpoint(ctx, exec.agent.session, exec.signal) }
    catch (error: unknown) {
      if (exec.signal.aborted) return abortedBeforeDispatchResult()
      throw error
    }
    return next()
  })
  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    await checkpoint(ctx, agent.session, signal)
    return next()
  })
}
