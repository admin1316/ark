/** Test-only direct Remote face over the Session Controller's internal controllers. */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection as AgentModelSelection } from '@deepseek-ai/dsh-agent'
import { isJsonValue, SessionPromptInvocationId, type JsonValue, type SessionId, type SessionRemoteUpdateQueueRequest } from '@deepseek-ai/dsh-session'
import { installModelSelectionProjection } from '@deepseek-ai/dsh-agent-default-model/session-selection'
import SessionRemoteOperationsService from '@deepseek-ai/dsh-host-session-remote-operations'
import {
  SessionPersistenceCorruptionError,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  type BorrowedSessionSource,
  type SessionInspection,
} from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { vi } from 'vitest'
import {
  TypertRemoteFailure,
  type RemoteResult,
} from '@deepseek-ai/dsh-typert-protocol'
import SessionController from '../src/index.ts'
import type {
  SessionAttachmentRequest,
  SessionCancelRequest,
  SessionCreateRequest,
  SessionForkRequest,
  SessionFollowRequest,
  SessionListRequest,
  SessionOpenWorkspacePathRequest,
  SessionPageRequest,
  SessionPromptRequest,
  SessionRenameRequest,
  SessionSearchRequest,
  SessionSelectModelRequest,
  SessionUpdateQueueRequest,
} from '../src/types.ts'

/** Direct domain face; the generated transport adds its independent outer result. */
export type TestSessionRemote = ReturnType<typeof createSessionTestRemote>

/** Dependencies and policy supplied by a Session Controller unit harness. */
export interface TestSessionRemoteDefaults {
  readonly defaultModelSelection: () => AgentModelSelection
  readonly cwd: string
  readonly coldBlankProbeMaxBytes?: number
  readonly nativeOpen?: boolean
  readonly saveDefaultModelSelection?: (selection: AgentModelSelection) => void | Promise<void>
  readonly openPath?: (path: string, signal: AbortSignal) => Promise<void>
  readonly canOpenPath?: () => boolean
}

const installed = new WeakMap<Context, SessionController>()

type LegacyTestPersistence = Record<string, unknown> & {
  readonly inspect?: (
    sessionId: SessionId,
    signal?: AbortSignal,
  ) => Promise<SessionInspection | undefined>
  readonly borrowSession?: (
    sessionId: SessionId,
    signal?: AbortSignal,
  ) => Promise<BorrowedSessionSource>
}

/** Add the preparation-backed point-read contract to compact persistence doubles. */
export function testSessionPersistence(
  ctx: Context,
  persistence: LegacyTestPersistence,
): LegacyTestPersistence {
  if (persistence.borrowSession !== undefined) return persistence
  return {
    ...persistence,
    borrowSession: async (sessionId, signal) => {
      signal?.throwIfAborted()
      const inspection = await persistence.inspect?.(sessionId, signal)
      signal?.throwIfAborted()
      if (inspection === undefined) throw new SessionPersistenceNotFoundError(sessionId)
      try {
        const preparedSession = ctx.sessions.prepare(inspection.meta.id, {
          seed: [...inspection.events],
          meta: inspection.meta,
          seedSource: 'persistence',
        })
        return {
          source: 'prepared',
          inspection: {
            meta: preparedSession.header,
            events: Object.freeze([...inspection.events]),
          },
          revision: SessionPersistenceRevision(`test:${sessionId}:${String(preparedSession.seq)}`),
          preparedSession,
          [Symbol.dispose]: () => {},
        }
      } catch (error: unknown) {
        throw new SessionPersistenceCorruptionError(
          `test session "${sessionId}" failed validation: ${String(error)}`,
          { cause: error },
        )
      }
    },
  }
}

/** Concrete point-read query used by Session Controller tests that do not exercise search. */
class TestSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not configured in this test'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not configured in this test'))
  }
}

/** Install the required projection and point-query services for direct controller tests. */
export function installSessionReadTestServices(ctx: Context): void {
  if (ctx.get('sessionProjections') === undefined) new SessionProjectionRegistry(ctx)
  if (ctx.get('sessionQuery') === undefined) new TestSessionQuery(ctx)
}

function installControllers(
  ctx: Context,
  defaults: TestSessionRemoteDefaults,
): SessionController {
  const found = installed.get(ctx)
  if (found !== undefined) return found

  if (ctx.get('typert') === undefined) {
    const dispose = (): void => {}
    ctx.provide('typert', {
      lookups: { configure: () => dispose },
      contexts: { configureHost: () => dispose },
    } as never)
  }
  if (ctx.get('agentDefaultModel') === undefined) {
    ctx.provide('agentDefaultModel', {
      currentSelection: defaults.defaultModelSelection,
      saveSelection: async (selection: AgentModelSelection) => {
        await defaults.saveDefaultModelSelection?.(selection)
      },
    } as never)
  }
  if (ctx.get('llm') === undefined) {
    ctx.provide('llm', {
      listProviders: () => {
        const selection = defaults.defaultModelSelection()
        return [{ id: selection.provider, name: selection.provider }]
      },
    } as never)
  }
  installSessionReadTestServices(ctx)
  installModelSelectionProjection(ctx)
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(defaults.cwd)
  let controller: SessionController
  try {
    controller = new SessionController(
      ctx,
      {
        ...defaults.nativeOpen === undefined ? {} : { nativeOpen: defaults.nativeOpen },
      },
      {
        ...defaults.openPath === undefined ? {} : { openPath: defaults.openPath },
        ...defaults.canOpenPath === undefined ? {} : { canOpenPath: defaults.canOpenPath },
      },
    )
  } finally {
    cwd.mockRestore()
  }
  installed.set(ctx, controller)
  return controller
}

/** Build or return the production Session Controller for a direct unit harness. */
export function createSessionTestController(
  ctx: Context,
  defaults: TestSessionRemoteDefaults,
): SessionController {
  return installControllers(ctx, defaults)
}

function remoteResult<T>(
  operation: () => T | Promise<T>,
  signal?: AbortSignal,
): Promise<RemoteResult<T>> {
  return Promise.resolve()
    .then(operation)
    .then(value => ({ ok: true as const, value }))
    .catch((error: unknown) => ({
      ok: false as const,
      error: signal?.aborted === true
        ? { code: 'cancelled', message: 'request was aborted', details: {} }
        : error instanceof TypertRemoteFailure
          ? error.failure
          : {
            code: 'internal',
            message: error instanceof Error ? error.message : String(error),
            details: {},
          },
    }))
}

/** Narrow using the Session owner's actual lossless JSON validator. */
function isQueueWireContent(content: unknown): content is JsonValue[] {
  return Array.isArray(content) && isJsonValue(content)
}

/** Preserve every queue block while enforcing the generated lossless JSON boundary. */
function queueWireRequest(request: SessionUpdateQueueRequest): SessionRemoteUpdateQueueRequest {
  if (request.action.kind !== 'edit') return { ...request, action: request.action }
  const content = [...request.action.content]
  if (!isQueueWireContent(content)) throw new TypeError('queue content must be lossless JSON')
  return { ...request, action: { kind: 'edit', content } }
}

/** Build the generated Session Remote's unary result semantics without a carrier. */
export function createSessionTestRemote(
  ctx: Context,
  defaults: TestSessionRemoteDefaults,
) {
  const direct = createSessionTestController(ctx, defaults)
  const workspace = ctx.get('workspaceRegistry')
  if (workspace === undefined) {
    ctx.provide('workspaceRegistry', {
      get: () => undefined, list: () => [], archivedSessionIds: [],
      sessionAdmissionRevision: () => 0, assertSessionAdmission: () => {},
    } as never)
  } else {
    // Earlier controller fixtures omitted the canonical admission capability.
    if (typeof workspace.sessionAdmissionRevision !== 'function') Object.assign(workspace, {
      sessionAdmissionRevision: () => 0, assertSessionAdmission: () => {},
    })
  }
  const core = ctx.get('sessionRemoteOperations') ?? new SessionRemoteOperationsService(ctx, {
    cwd: defaults.cwd,
    ...(defaults.coldBlankProbeMaxBytes === undefined ? {} : { coldBlankProbeMaxBytes: defaults.coldBlankProbeMaxBytes }),
  })
  return {
    canOpenWorkspacePath: () => remoteResult(() => direct.canOpenWorkspacePath()),
    list: (request: SessionListRequest, signal = new AbortController().signal) => Promise.resolve().then(() => core.list(request, signal)),
    search: (request: SessionSearchRequest, signal = new AbortController().signal) => Promise.resolve().then(() => core.search(request, signal)),
    create: (request: SessionCreateRequest) => Promise.resolve().then(() => core.create(request, new AbortController().signal)),
    selectModel: (request: SessionSelectModelRequest) => Promise.resolve().then(() => core.selectModel(request, new AbortController().signal)),
    modelCatalog: () => remoteResult(() => direct.modelCatalog()),
    rename: (request: SessionRenameRequest) => Promise.resolve().then(() => core.rename(request, new AbortController().signal)),
    fork: (request: SessionForkRequest) => Promise.resolve().then(() => core.fork(request, new AbortController().signal)),
    prompt: ({ requestId, ...request }: SessionPromptRequest, signal = new AbortController().signal) =>
      Promise.resolve().then(() => core.prompt({ ...request, invocationId: SessionPromptInvocationId(requestId) }, signal)),
    attachment: (request: SessionAttachmentRequest) => Promise.resolve().then(() => core.attachment(request, new AbortController().signal)),
    updateQueue: (request: SessionUpdateQueueRequest) => Promise.resolve().then(() => core.updateQueue(queueWireRequest(request), new AbortController().signal)),
    cancel: (request: SessionCancelRequest) => Promise.resolve().then(() => core.cancel(request, new AbortController().signal)),
    openWorkspacePath: (request: SessionOpenWorkspacePathRequest, signal = new AbortController().signal) => remoteResult(
      () => direct.openWorkspacePath(request, signal),
      signal,
    ),
    page: (request: SessionPageRequest, signal = new AbortController().signal) => remoteResult(
      () => direct.page(request, signal),
      signal,
    ),
    follow: (request: SessionFollowRequest, signal = new AbortController().signal) => direct.follow(request, signal),
    control: (signal = new AbortController().signal) => direct.control(signal),
  }
}
