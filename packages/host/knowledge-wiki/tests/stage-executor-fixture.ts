import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { WebRuntime } from '@deepseek-ai/dsh-web'
import { extractFileText } from '../src/file-extract.ts'
import { completeText } from '../src/ingest.ts'
import type { KnowledgeWikiStageExecutor } from '../src/stage-executor.ts'

/** Test-only in-process adapter; production requires an injected owned isolate. */
export function stageExecutorFor(llm: LlmRuntime, web?: WebRuntime): KnowledgeWikiStageExecutor {
  return {
    isolation: 'owned-worker-v1',
    async execute(request, signal) {
      signal.throwIfAborted()
      if (request.kind === 'file-extract') {
        return { text: await extractFileText(request.path) }
      }
      if (request.kind === 'llm-complete') {
        return {
          text: await completeText(
            llm,
            request.provider,
            request.model,
            request.prompt,
            request.operation,
            signal,
          ),
        }
      }
      if (request.kind === 'web-search') {
        if (web === undefined) throw new Error('web service unavailable')
        const result = await web.search({ query: request.query, maxResults: request.maxResults }, signal)
        return { text: null, sources: [...result.sources] }
      }
      return { text: null }
    },
  }
}
