/** Owned file isolates and cancellation-aware calls through the existing LLM/web owners. */
import { Worker } from 'node:worker_threads'
import type { LlmRuntime, ContentBlock, PreparedLlmCall } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { WebRuntime } from '@deepseek-ai/dsh-web'
import type { AttachmentStore, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { basename, extname } from 'node:path'
import { decodeKnowledgeText } from './file-extract.ts'
import { readRegularFileBounded } from './filesystem.ts'
import type { KnowledgeWikiStageExecutor, KnowledgeWikiStageRequest, KnowledgeWikiStageResult } from './stage-executor.ts'

/** Provider services remain authoritative for endpoints, credentials, protocols, and cancellation. */
export interface OwnedStageExecutorOptions {
  readonly llm: LlmRuntime
  readonly web: () => WebRuntime | undefined
  readonly attachments: () => AttachmentStore | undefined
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('knowledge Wiki stage aborted')
}

const FILE_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const fs = require('node:fs')
const decode = (${decodeKnowledgeText.toString()})
try {
  const admitted = decode(workerData.path, new Uint8Array())
  if (admitted === null) throw new Error('unsupported knowledge source format; original file was preserved')
  else {
    const fd = fs.openSync(workerData.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    try {
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 5 * 1024 * 1024) throw new Error('knowledge source is not a bounded regular text file')
      const bytes = Buffer.alloc(stat.size + 1)
      let count = 0
      while (count < bytes.length) {
        const read = fs.readSync(fd, bytes, count, bytes.length - count, null)
        if (read === 0) break
        count += read
      }
      if (count > stat.size) throw new Error('knowledge source changed during extraction')
      parentPort.postMessage({ ok: true, text: decode(workerData.path, bytes.subarray(0, count)) })
    } finally { fs.closeSync(fd) }
  }
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
}
`

async function extractOwned(path: string, signal: AbortSignal): Promise<KnowledgeWikiStageResult> {
  signal.throwIfAborted()
  const worker = new Worker(FILE_WORKER_SOURCE, { eval: true, workerData: { path } })
  try {
    return await new Promise((resolve, reject) => {
      let settled = false
      const finish = (operation: () => void): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        operation()
      }
      const onAbort = (): void => { finish(() => { reject(abortError(signal)) }) }
      signal.addEventListener('abort', onAbort, { once: true })
      worker.once('message', (message: { ok: boolean; text: string | null; error?: string }) => {
        finish(() => {
          if (message.ok) resolve({ text: message.text })
          else reject(new Error(message.error))
        })
      })
      worker.once('error', (error) => { finish(() => { reject(error) }) })
      worker.once('exit', (code) => {
        finish(() => { reject(new Error(`knowledge file worker exited without a result (${code})`)) })
      })
      if (signal.aborted) onAbort()
    })
  } finally {
    // Terminate is idempotent after exit; every outcome awaits actual isolate quiescence.
    await worker.terminate()
  }
}

/**
 * Build the service-owned executor without duplicating provider HTTP protocols.
 * @param options - Registered provider services and optional image admission owner.
 * @returns Executor whose file work terminates and whose providers settle before return.
 */
export function createOwnedStageExecutor(options: OwnedStageExecutorOptions): KnowledgeWikiStageExecutor {
  const executor: KnowledgeWikiStageExecutor = {
    isolation: 'owned-worker-v1',
    assertSearchAvailable() {
      const web = options.web()
      if (web === undefined) throw new Error('knowledge web search is unavailable')
      web.assertSearchAvailable()
    },
    async prepareOperation(route, signal) {
      signal.throwIfAborted()
      // Both shipping adapters synchronously capture endpoint and credential-reference
      // settings inside prepareCall, before any analysis/expansion can run.
      const calls = await Promise.all(Array.from({ length: route.modelCalls }, () =>
        options.llm.prepareCall({ provider: route.provider, model: route.model }, signal)))
      signal.throwIfAborted()
      return {
        isolation: executor.isolation,
        assertSearchAvailable: () => executor.assertSearchAvailable?.(),
        execute(request, stageSignal) {
          if (request.kind !== 'llm-complete') return execute(request, stageSignal)
          const call = calls.shift()
          if (call === undefined || request.provider !== call.config.provider || request.model !== call.config.model) {
            return Promise.reject(new Error('knowledge operation exceeded or changed its prepared model route'))
          }
          return execute(request, stageSignal, call)
        },
      }
    },
    execute,
  }
  return executor
  async function execute(
    request: KnowledgeWikiStageRequest,
    signal: AbortSignal,
    captured?: PreparedLlmCall,
  ): Promise<KnowledgeWikiStageResult> {
    signal.throwIfAborted()
    if (request.kind === 'file-extract') return extractOwned(request.path, signal)
    if (request.kind === 'web-search') {
      const web = options.web()
      if (web === undefined) throw new Error('knowledge web search is unavailable')
      const result = await web.search({ query: request.query, maxResults: request.maxResults }, signal)
      signal.throwIfAborted()
      return { text: result.content ?? null, sources: [...result.sources] }
    }
    const content: ContentBlock[] = [{
      type: 'text',
      text: request.kind === 'llm-complete'
        ? request.prompt
        : 'Describe this image in one concise paragraph for a knowledge base.',
    }]
    const prepared = captured ?? await options.llm.prepareCall({ provider: request.provider, model: request.model }, signal)
    signal.throwIfAborted()
    if (request.kind === 'vision-describe') {
      if (!prepared.inputModalities?.includes('image')) throw new Error('selected knowledge vision model does not accept images')
      const attachments = options.attachments()
      if (attachments === undefined) throw new Error('knowledge image admission is unavailable')
      const mediaTypes: Record<string, ImageMediaType> = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.webp': 'image/webp',
      }
      const mediaType = mediaTypes[extname(request.path).toLowerCase()]
      if (mediaType === undefined) throw new Error('knowledge vision requires a supported raster image')
      const attachment = await attachments.saveImage({
        data: readRegularFileBounded(request.path, attachments.imageLimits.maxImageBytes),
        mediaType, name: basename(request.path),
      })
      signal.throwIfAborted()
      content.push({ type: 'image', attachment })
    }
    let text = ''
    for await (const chunk of prepared.stream({
      ...prepared.config,
      messages: [createUserMessage({ content, source: { kind: 'plugin', plugin: 'knowledge-wiki' } })], signal,
    })) {
      signal.throwIfAborted()
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
        throw new Error('knowledge model stage failed (' + chunk.reason.kind + ')')
      }
    }
    signal.throwIfAborted()
    return { text }
  }
}
