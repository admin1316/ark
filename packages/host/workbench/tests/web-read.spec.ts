import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime, {
  WebError,
  type WebFetchProvider,
  type WebFetchRequest,
  type WebFetchResult,
} from '@deepseek-ai/dsh-web'
import { isTypertRemoteFailure, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import WorkbenchRemoteService from '../src/index.ts'
import type { WorkbenchRemoteFailure } from '../src/types.ts'

/**
 * The real Workbench Remote is mounted on the real web seam; only the network
 * backend is scripted, so every case runs through the strict request parse, the
 * cancellation checks, and the typed failure mapping the Host ships.
 */
interface Harness {
  service: WorkbenchRemoteService
  /** Every request the scripted backend actually received. */
  requests: WebFetchRequest[]
  /** Abort the controller handed to the next call. */
  controller: AbortController
  dispose(): Promise<void>
}

async function harness(fetch: WebFetchProvider['fetch']): Promise<Harness> {
  const requests: WebFetchRequest[] = []
  const controller = new AbortController()
  const ctx = new Context()
  await ctx.plugin(WebRuntime)
  ctx.web.registerFetchProvider({
    id: 'workbench-spec',
    available: () => true,
    fetch: (request, signal) => {
      requests.push(request)
      return fetch(request, signal)
    },
  })
  await ctx.plugin(WorkbenchRemoteService)
  return {
    service: ctx.get('workbench') as WorkbenchRemoteService,
    requests,
    controller,
    dispose: () => ctx.fiber.dispose(),
  }
}

/** Resolve one fetched document from a scripted backend result. */
function backend(result: WebFetchResult): WebFetchProvider['fetch'] {
  return () => Promise.resolve(result)
}

/** Await the strict Remote and return the typed failure payload it rejected with. */
async function failureOf(call: Promise<unknown>): Promise<WorkbenchRemoteFailure> {
  try {
    await call
  } catch (error: unknown) {
    if (!isTypertRemoteFailure(error)) throw error
    return error.failure as WorkbenchRemoteFailure
  }
  throw new Error('the workbench Remote call was expected to reject')
}

describe('WorkbenchRemoteService webRead', () => {
  it('publishes exactly one direct webRead method under the workbench namespace', async () => {
    const harnessed = await harness(backend({
      url: 'https://example.com',
      statusCode: 200,
      body: { kind: 'text', content: 'body' },
      truncated: false,
    }))
    const { service } = harnessed
    try {
      expect(service.typertRemote).toMatchObject({ serviceKey: 'workbench', namespace: 'workbench' })
      expect(remoteMethods(service)).toEqual([{ method: 'webRead', invocation: { kind: 'direct' } }])
    } finally {
      await harnessed.dispose()
    }
  })

  it('returns the bounded body-only Markdown document and the structured fetch facts', async () => {
    const harnessed = await harness(backend({
      url: 'https://docs.example.com/final',
      statusCode: 200,
      body: { kind: 'text', content: 'page body' },
      truncated: false,
    }))
    const { service, requests, controller } = harnessed
    try {
      await expect(service.webRead({ url: 'https://example.com/redirect' }, controller.signal)).resolves.toEqual({
        url: 'https://docs.example.com/final',
        title: 'docs.example.com',
        statusCode: 200,
        markdown: 'page body',
        truncated: false,
      })
      expect(requests).toEqual([{ url: 'https://example.com/redirect' }])
    } finally {
      await harnessed.dispose()
    }
  })

  it('converts an HTML body to Markdown and propagates provider truncation', async () => {
    const harnessed = await harness(backend({
      url: 'https://example.com/guide',
      statusCode: 200,
      body: { kind: 'html', content: '<h1>Guide</h1><p>Hello <strong>world</strong></p>' },
      truncated: true,
    }))
    const { service, controller } = harnessed
    try {
      const document = await service.webRead({ url: 'https://example.com/guide' }, controller.signal)
      expect(document.markdown).toContain('# Guide')
      expect(document.markdown).toContain('Hello **world**')
      // The Native document carries the body only: model framing never leaks in.
      expect(document.markdown).not.toContain('Fetched ')
      expect(document.truncated).toBe(true)
    } finally {
      await harnessed.dispose()
    }
  })

  it('rejects an invalid payload as bad-request before reaching the web seam', async () => {
    const harnessed = await harness(backend({
      url: 'https://example.com',
      statusCode: 200,
      body: { kind: 'text', content: 'body' },
      truncated: false,
    }))
    const { service, requests, controller } = harnessed
    try {
      const failure = await failureOf(service.webRead({ url: '' }, controller.signal))
      expect(failure).toMatchObject({ code: 'bad-request', message: 'invalid payload for workbench/webRead' })
      expect((failure.details as { issues: readonly unknown[] }).issues.length).toBeGreaterThan(0)
      expect(requests).toEqual([])
    } finally {
      await harnessed.dispose()
    }
  })

  it('rejects an already-aborted call as cancelled without fetching', async () => {
    const harnessed = await harness(backend({
      url: 'https://example.com',
      statusCode: 200,
      body: { kind: 'text', content: 'body' },
      truncated: false,
    }))
    const { service, requests, controller } = harnessed
    try {
      controller.abort()
      await expect(failureOf(service.webRead({ url: 'https://example.com' }, controller.signal))).resolves.toEqual({
        code: 'cancelled',
        message: 'workbench web read was aborted',
        details: {},
      })
      expect(requests).toEqual([])
    } finally {
      await harnessed.dispose()
    }
  })

  it('keeps the cancelled outcome when the caller aborts while the fetch is in flight', async () => {
    const harnessed = await harness(async () => {
      harnessed.controller.abort()
      throw new Error('transport closed')
    })
    try {
      await expect(failureOf(harnessed.service.webRead({ url: 'https://example.com' }, harnessed.controller.signal)))
        .resolves.toEqual({
          code: 'cancelled',
          message: 'workbench web read was aborted',
          details: {},
        })
      expect(harnessed.requests).toEqual([{ url: 'https://example.com' }])
    } finally {
      await harnessed.dispose()
    }
  })

  it('reports a typed WebError code as the structured web-reader reason', async () => {
    const harnessed = await harness(() => {
      throw new WebError('the URL is blocked by policy', 'WEB_URL_BLOCKED')
    })
    const { service, controller } = harnessed
    try {
      await expect(failureOf(service.webRead({ url: 'https://example.com/blocked' }, controller.signal))).resolves.toEqual({
        code: 'web-reader-error',
        message: 'the URL is blocked by policy',
        details: { url: 'https://example.com/blocked', reason: 'WEB_URL_BLOCKED' },
      })
    } finally {
      await harnessed.dispose()
    }
  })

  it('falls back to the unexpected reason for a failure that carries no string code', async () => {
    const harnessed = await harness(() => {
      throw new TypeError('fetch failed')
    })
    const { service, controller } = harnessed
    try {
      await expect(failureOf(service.webRead({ url: 'https://example.com' }, controller.signal))).resolves.toEqual({
        code: 'web-reader-error',
        message: 'fetch failed',
        details: { url: 'https://example.com', reason: 'unexpected' },
      })
    } finally {
      await harnessed.dispose()
    }
  })

  it('stringifies a non-Error rejection instead of leaking an empty message', async () => {
    const harnessed = await harness(() => {
      // The Remote must classify a provider that rejects with any value, not only Error.
      throw 'provider exploded'
    })
    const { service, controller } = harnessed
    try {
      await expect(failureOf(service.webRead({ url: 'https://example.com' }, controller.signal))).resolves.toEqual({
        code: 'web-reader-error',
        message: 'provider exploded',
        details: { url: 'https://example.com', reason: 'unexpected' },
      })
    } finally {
      await harnessed.dispose()
    }
  })
})
