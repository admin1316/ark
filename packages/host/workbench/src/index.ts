/** Domain-owned Typert Remote service for the Native Ark Workbench. */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertLookupFailure, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { formatFetchOutputState } from '@deepseek-ai/dsh-tool-web'
import type { WebError } from '@deepseek-ai/dsh-web'
import { z } from 'zod'
import type {
  WorkbenchRemoteFailure,
  WorkbenchWebDocument,
  WorkbenchWebReadRequest,
} from './types.ts'

export type * from './types.ts'

type WorkbenchMethod = 'workbench/webRead'
const WORKBENCH_WEB_READER_MAX_CHARS = 100_000

const workbenchWebReadRequestSchema: z.ZodType<WorkbenchWebReadRequest> = z.object({
  url: z.string().min(1),
})

/** Validate a strict slash-Remote request before any filesystem access. */
function parseRequest<Output>(schema: z.ZodType<Output>, input: unknown, method: WorkbenchMethod): Output {
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    throw new TypertLookupFailure<WorkbenchRemoteFailure>({
      code: 'bad-request',
      message: `invalid payload for ${method}`,
      details: { issues: parsed.error.issues },
    })
  }
  return parsed.data
}

/** Construct the stable cancellation result for one Workbench operation. */
function cancelled(message: string): TypertLookupFailure<WorkbenchRemoteFailure> {
  return new TypertLookupFailure({ code: 'cancelled', message, details: {} })
}

/** Read a mutable AbortSignal without retaining an earlier control-flow narrowing. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/** Native Workbench Remote owner for the browser-free Host Web reader. */
export class WorkbenchRemoteService extends TypertRemoteService {
  static inject = ['web']

  constructor(ctx: Context) {
    super(ctx, 'workbench')
  }

  /**
   * Fetch one public HTTP(S) page through the existing SSRF-safe Host provider
   * and convert it to bounded Markdown for the Native Workbench reader.
   * @param request - strict request containing the public HTTP(S) URL.
   * @param signal - caller cancellation propagated through WebFetch.
   * @returns the bounded body-only Markdown document and structured fetch facts.
   */
  @Remote('webRead')
  async webRead(request: WorkbenchWebReadRequest, signal: AbortSignal): Promise<WorkbenchWebDocument> {
    const payload = parseRequest(workbenchWebReadRequestSchema, request, 'workbench/webRead')
    if (isAborted(signal)) throw cancelled('workbench web read was aborted')
    try {
      const result = await this.ctx.web.fetch({ url: payload.url }, signal)
      const formatted = formatFetchOutputState(result, WORKBENCH_WEB_READER_MAX_CHARS)
      return {
        url: result.url,
        title: new URL(result.url).hostname,
        statusCode: result.statusCode,
        markdown: formatted.markdown,
        truncated: formatted.markdownTruncated,
      }
    } catch (error: unknown) {
      if (isAborted(signal)) throw cancelled('workbench web read was aborted')
      const webError = error as Partial<WebError>
      throw new TypertLookupFailure<WorkbenchRemoteFailure>({
        code: 'web-reader-error',
        message: error instanceof Error ? error.message : String(error),
        details: {
          url: payload.url,
          reason: typeof webError.code === 'string' ? webError.code : 'unexpected',
        },
      })
    }
  }
}

export default WorkbenchRemoteService
