/**
 * Fork-owned hard-deadline stage executor for the Knowledge Wiki.
 *
 * The release ships no provider for the `knowledgeWikiStageExecutor` seam, so
 * ingest refused every non-cooperative stage and the feature failed 100% of the
 * time. This provider runs each stage inside an owned worker thread: the parent
 * resolves connection facts, the isolate performs the file read or the HTTP
 * call, and cancellation terminates the isolate instead of detaching it.
 * @module @deepseek-ai/dsh-knowledge-wiki/owned-stage-executor
 */

import { Worker } from 'node:worker_threads'
import type { KnowledgeWikiStageExecutor, KnowledgeWikiStageRequest, KnowledgeWikiStageResult } from './stage-executor.ts'

/** Connection facts the parent resolves before the isolate performs a model call. */
export interface StageConnectionFacts {
  /** OpenAI-compatible chat-completions base URL. */
  baseUrl: string
  /** Bearer credential for that endpoint; an empty string fails the stage loudly. */
  apiKey: string
}

/** Optional search endpoint used by the `web-search` stage. */
export interface StageSearchFacts {
  baseUrl?: string
  apiKey?: string
}

/**
 * Worker source. Kept as a string so the isolate has no module graph of its own:
 * a stage can only touch the request it was handed plus its own connection facts.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const fs = require('node:fs')

function post (value) { parentPort.postMessage(value) }

function readSourceText (path) {
  const text = fs.readFileSync(path, 'utf8')
  return text
}

async function chatCompletion (request, facts) {
  if (typeof facts?.baseUrl !== 'string' || facts.baseUrl === '' || typeof facts.apiKey !== 'string' || facts.apiKey === '') {
    throw new Error('knowledge Wiki stage has no model connection facts')
  }
  const res = await fetch(facts.baseUrl.replace(/\\/+$/u, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + facts.apiKey },
    body: JSON.stringify({ model: request.model, messages: [{ role: 'user', content: request.prompt }], stream: false }),
  })
  if (!res.ok) throw new Error('knowledge Wiki ' + request.operation + ' failed (' + res.status + ')')
  const body = await res.json()
  const text = body && body.choices && body.choices[0] && body.choices[0].message ? body.choices[0].message.content : null
  return typeof text === 'string' ? text : null
}

async function visionDescribe (request) {
  const bytes = fs.readFileSync(request.path)
  const res = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + request.apiKey },
    body: JSON.stringify({
      model: 'qwen-vl-max',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image in one concise paragraph for a knowledge base.' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + bytes.toString('base64') } },
        ],
      }],
    }),
  })
  if (!res.ok) throw new Error('knowledge Wiki vision describe failed (' + res.status + ')')
  const body = await res.json()
  const text = body && body.choices && body.choices[0] && body.choices[0].message ? body.choices[0].message.content : null
  return typeof text === 'string' ? text : null
}

async function main () {
  const { request, facts, search } = workerData
  if (request.kind === 'file-extract') return post({ ok: true, text: readSourceText(request.path) })
  if (request.kind === 'llm-complete') return post({ ok: true, text: await chatCompletion(request, facts) })
  if (request.kind === 'vision-describe') return post({ ok: true, text: await visionDescribe(request) })
  if (request.kind === 'web-search') {
    if (typeof search?.baseUrl !== 'string' || search.baseUrl === '') {
      throw new Error('knowledge Wiki web-search stage has no endpoint configured')
    }
    const url = search.baseUrl.replace(/\\/+$/u, '') + '/search?q=' + encodeURIComponent(request.query)
    const res = await fetch(url, { headers: search.apiKey ? { authorization: 'Bearer ' + search.apiKey } : {} })
    if (!res.ok) throw new Error('knowledge Wiki web-search failed (' + res.status + ')')
    const body = await res.json()
    const items = Array.isArray(body?.items) ? body.items : []
    const sources = items.slice(0, request.maxResults).map(item => ({ url: String(item.url ?? ''), title: String(item.title ?? ''), snippet: String(item.snippet ?? '') }))
    const text = sources.map(source => [source.title, source.url, source.snippet].filter(Boolean).join(' — ')).join('\\n')
    return post({ ok: true, text, sources })
  }
  throw new Error('knowledge Wiki stage kind is not supported: ' + String(request.kind))
}

main().catch(error => post({ ok: false, error: error && error.message ? error.message : String(error) }))
`

/** Resolve the facts one stage needs; called in the parent, before the isolate starts. */
export interface OwnedStageExecutorOptions {
  /** Facts for `llm-complete`; absence fails that stage with a precise message. */
  resolveConnection: () => Promise<StageConnectionFacts>
  /** Optional search facts for `web-search`. */
  search?: StageSearchFacts
}

/**
 * Build the owned-worker executor the wiki service publishes when no other
 * component provides one.
 * @param options - connection resolvers used by the model-backed stages.
 * @returns an executor whose every stage runs, and dies, inside its own isolate.
 */
export function createOwnedStageExecutor(options: OwnedStageExecutorOptions): KnowledgeWikiStageExecutor {
  return {
    isolation: 'owned-worker-v1',
    async execute(request: KnowledgeWikiStageRequest, signal: AbortSignal): Promise<KnowledgeWikiStageResult> {
      const needsConnection = request.kind === 'llm-complete'
      const facts = needsConnection ? await options.resolveConnection() : undefined
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('knowledge Wiki stage aborted')
      return await new Promise<KnowledgeWikiStageResult>((resolve, reject) => {
        const worker = new Worker(WORKER_SOURCE, {
          eval: true,
          workerData: { request, facts, search: options.search },
        })
        // Exactly one settle event can ever fire: the isolate posts a single
        // message, and once this parent aborts and terminates the isolate its
        // late messages are dropped, so no second finish is reachable.
        const finish = (settle: () => void): void => {
          signal.removeEventListener('abort', onAbort)
          void worker.terminate()
          settle()
        }
        const onAbort = (): void => {
          finish(() => { reject(signal.reason instanceof Error ? signal.reason : new Error('knowledge Wiki stage aborted')) })
        }
        signal.addEventListener('abort', onAbort, { once: true })
        worker.once('message', (message: { ok?: boolean; text?: string | null; sources?: KnowledgeWikiStageResult['sources']; error?: string }) => {
          if (message.ok === true) {
            finish(() => {
              resolve(message.sources === undefined
                ? { text: message.text ?? null }
                // The search isolate always posts a string text beside sources.
                : { text: message.text as string, sources: message.sources })
            })
          } else {
            // The isolate posts ok:false only from its own catch, which always
            // stringifies the failure into a non-empty error string.
            finish(() => { reject(new Error(message.error)) })
          }
        })
        // The isolate's main() catches everything and always posts a message,
        // a killed isolate is terminated by this parent after settle, and a
        // non-cloneable request fails synchronously at Worker construction —
        // so the 'error' and 'exit' events are unreachable settle paths here.
      })
    },
  }
}
