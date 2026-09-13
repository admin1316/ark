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
import { Worker } from 'node:worker_threads';
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
`;
/**
 * Build the owned-worker executor the wiki service publishes when no other
 * component provides one.
 * @param options - connection resolvers used by the model-backed stages.
 * @returns an executor whose every stage runs, and dies, inside its own isolate.
 */
export function createOwnedStageExecutor(options) {
    return {
        isolation: 'owned-worker-v1',
        async execute(request, signal) {
            const needsConnection = request.kind === 'llm-complete';
            const facts = needsConnection ? await options.resolveConnection() : undefined;
            if (signal.aborted)
                throw signal.reason instanceof Error ? signal.reason : new Error('knowledge Wiki stage aborted');
            return await new Promise((resolve, reject) => {
                const worker = new Worker(WORKER_SOURCE, {
                    eval: true,
                    workerData: { request, facts, search: options.search },
                });
                let settled = false;
                const finish = (settle) => {
                    if (settled)
                        return;
                    settled = true;
                    signal.removeEventListener('abort', onAbort);
                    void worker.terminate();
                    settle();
                };
                const onAbort = () => {
                    finish(() => { reject(signal.reason instanceof Error ? signal.reason : new Error('knowledge Wiki stage aborted')); });
                };
                signal.addEventListener('abort', onAbort, { once: true });
                worker.once('message', (message) => {
                    if (message?.ok === true) {
                        finish(() => {
                            resolve(message.sources === undefined ? { text: message.text ?? null } : { text: message.text ?? null, sources: message.sources });
                        });
                    }
                    else {
                        finish(() => { reject(new Error(message?.error ?? 'knowledge Wiki stage failed')); });
                    }
                });
                worker.once('error', (error) => { finish(() => { reject(error); }); });
                worker.once('exit', (code) => {
                    if (code !== 0)
                        finish(() => { reject(new Error(`knowledge Wiki stage isolate exited with ${String(code)}`)); });
                });
            });
        },
    };
}
//# sourceMappingURL=owned-stage-executor.js.map