import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createOwnedStageExecutor } from '../src/owned-stage-executor.ts'

const servers: Array<ReturnType<typeof createServer>> = []
const roots: string[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function executorFor (baseUrl: string, apiKey = 'k') {
  return createOwnedStageExecutor({ resolveConnection: async () => ({ baseUrl, apiKey }) })
}

describe('owned stage executor', () => {
  it('extracts a source file inside the isolate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stage-extract-'))
    roots.push(root)
    const file = join(root, 'note.md')
    writeFileSync(file, '# title\n\nbody text')
    const result = await executorFor('http://127.0.0.1:1').execute(
      { kind: 'file-extract', path: file, timeoutMs: 10_000 },
      new AbortController().signal,
    )
    expect(result.text).toBe('# title\n\nbody text')
  })

  it('runs the model call from the isolate and returns its text', async () => {
    let seenBody = ''
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        seenBody = Buffer.concat(chunks).toString('utf8')
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ choices: [{ message: { content: 'a summary' } }] }))
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => { resolve() }))
    servers.push(server)
    const port = (server.address() as { port: number }).port
    const result = await executorFor(`http://127.0.0.1:${String(port)}`).execute(
      { kind: 'llm-complete', provider: 'deepseek-official', model: 'deepseek-v4-flash', prompt: 'summarise', operation: 'ingest analysis', timeoutMs: 10_000 },
      new AbortController().signal,
    )
    expect(result.text).toBe('a summary')
    expect(JSON.parse(seenBody)).toEqual({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'summarise' }], stream: false })
  })

  it('surfaces an upstream failure instead of a silent empty stage', async () => {
    const server = createServer((_request, response) => { response.statusCode = 401; response.end('no') })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => { resolve() }))
    servers.push(server)
    const port = (server.address() as { port: number }).port
    await expect(executorFor(`http://127.0.0.1:${String(port)}`).execute(
      { kind: 'llm-complete', provider: 'deepseek-official', model: 'm', prompt: 'p', operation: 'ingest analysis', timeoutMs: 10_000 },
      new AbortController().signal,
    )).rejects.toThrow('ingest analysis failed (401)')
  })

  it('terminates the isolate when the owner aborts', async () => {
    const server = createServer(() => { /* never answers: the stage must be cancelled, not awaited */ })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => { resolve() }))
    servers.push(server)
    const port = (server.address() as { port: number }).port
    const controller = new AbortController()
    const pending = executorFor(`http://127.0.0.1:${String(port)}`).execute(
      { kind: 'llm-complete', provider: 'deepseek-official', model: 'm', prompt: 'p', operation: 'ingest analysis', timeoutMs: 60_000 },
      controller.signal,
    )
    setTimeout(() => { controller.abort(new Error('cancelled by owner')) }, 80)
    await expect(pending).rejects.toThrow('cancelled by owner')
  })

  it('kills the isolate on abort so its in-flight upstream connection closes', async () => {
    let markArrived: (() => void) | undefined
    const arrived = new Promise<void>((resolve) => { markArrived = resolve })
    let markClosed: (() => void) | undefined
    const socketClosed = new Promise<void>((resolve) => { markClosed = resolve })
    const server = createServer((request) => {
      markArrived?.()
      request.socket.once('close', () => { markClosed?.() })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => { resolve() }))
    servers.push(server)
    const port = (server.address() as { port: number }).port
    const controller = new AbortController()
    const pending = executorFor(`http://127.0.0.1:${String(port)}`).execute(
      { kind: 'llm-complete', provider: 'deepseek-official', model: 'm', prompt: 'p', operation: 'ingest analysis', timeoutMs: 60_000 },
      controller.signal,
    )
    await arrived
    controller.abort(new Error('cancelled by owner'))
    await expect(pending).rejects.toThrow('cancelled by owner')
    // The owned isolate dies with the stage: a detached worker would hold the socket open.
    await socketClosed
  })

  it('refuses an owner signal aborted before the isolate starts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stage-preabort-'))
    roots.push(root)
    // The path exists, so an ENOENT rejection would prove the isolate ran: the
    // pre-flight abort check must win instead.
    const file = join(root, 'note.md')
    writeFileSync(file, 'body')
    const controller = new AbortController()
    controller.abort(new Error('cancelled before start'))
    await expect(executorFor('http://127.0.0.1:1').execute(
      { kind: 'file-extract', path: file, timeoutMs: 10_000 },
      controller.signal,
    )).rejects.toThrow('cancelled before start')
  })

  it('reports the fixed abort error for a non-Error reason before the isolate starts', async () => {
    const controller = new AbortController()
    controller.abort('owner said stop')
    await expect(executorFor('http://127.0.0.1:1').execute(
      { kind: 'file-extract', path: join(tmpdir(), 'never-read.md'), timeoutMs: 10_000 },
      controller.signal,
    )).rejects.toThrow('knowledge Wiki stage aborted')
  })

  it('reports the fixed abort error when a running stage is cancelled with a non-Error reason', async () => {
    const server = createServer(() => { /* never answers: the isolate must be terminated */ })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => { resolve() }))
    servers.push(server)
    const port = (server.address() as { port: number }).port
    const controller = new AbortController()
    const pending = executorFor(`http://127.0.0.1:${String(port)}`).execute(
      { kind: 'llm-complete', provider: 'deepseek-official', model: 'm', prompt: 'p', operation: 'ingest analysis', timeoutMs: 60_000 },
      controller.signal,
    )
    setTimeout(() => { controller.abort('stop') }, 80)
    await expect(pending).rejects.toThrow('knowledge Wiki stage aborted')
  })

  it('returns a null text when the model answers without content', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ choices: [{ message: {} }] }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => { resolve() }))
    servers.push(server)
    const port = (server.address() as { port: number }).port
    const result = await executorFor(`http://127.0.0.1:${String(port)}`).execute(
      { kind: 'llm-complete', provider: 'deepseek-official', model: 'm', prompt: 'p', operation: 'ingest analysis', timeoutMs: 10_000 },
      new AbortController().signal,
    )
    expect(result.text).toBeNull()
    expect(result.sources).toBeUndefined()
  })

  it('runs the web-search stage inside the isolate and returns its bounded sources', async () => {
    const seen: Array<{ url: string | undefined; authorization: string | undefined }> = []
    const server = createServer((request, response) => {
      seen.push({ url: request.url, authorization: request.headers.authorization })
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ items: [
        { url: 'https://a.example/1', title: 'Alpha', snippet: 'first' },
        { url: 'https://b.example/2', title: 'Beta' },
        { url: 'https://c.example/3', title: 'Gamma', snippet: 'third' },
      ] }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => { resolve() }))
    servers.push(server)
    const port = (server.address() as { port: number }).port
    let resolvedFacts = 0
    const executor = createOwnedStageExecutor({
      resolveConnection: async () => { resolvedFacts += 1; return { baseUrl: 'http://127.0.0.1:1', apiKey: 'k' } },
      search: { baseUrl: `http://127.0.0.1:${String(port)}/`, apiKey: 'search-key' },
    })
    const result = await executor.execute(
      { kind: 'web-search', query: 'orphan 归因', maxResults: 2, timeoutMs: 10_000 },
      new AbortController().signal,
    )
    expect(seen).toEqual([{ url: '/search?q=orphan%20%E5%BD%92%E5%9B%A0', authorization: 'Bearer search-key' }])
    expect(result.sources).toEqual([
      { url: 'https://a.example/1', title: 'Alpha', snippet: 'first' },
      { url: 'https://b.example/2', title: 'Beta', snippet: '' },
    ])
    expect(result.text).toBe('Alpha — https://a.example/1 — first\nBeta — https://b.example/2')
    // A search-only stage must not resolve model connection facts.
    expect(resolvedFacts).toBe(0)
  })

  it('omits authorization when the search endpoint declares no key', async () => {
    let authorization: string | undefined = 'unset'
    const server = createServer((request, response) => {
      authorization = request.headers.authorization
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ items: [] }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => { resolve() }))
    servers.push(server)
    const port = (server.address() as { port: number }).port
    const executor = createOwnedStageExecutor({
      resolveConnection: async () => ({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k' }),
      search: { baseUrl: `http://127.0.0.1:${String(port)}` },
    })
    const result = await executor.execute(
      { kind: 'web-search', query: 'nothing', maxResults: 5, timeoutMs: 10_000 },
      new AbortController().signal,
    )
    expect(authorization).toBeUndefined()
    expect(result).toEqual({ text: '', sources: [] })
  })

  it('fails the web-search stage when no endpoint is configured', async () => {
    await expect(executorFor('http://127.0.0.1:1').execute(
      { kind: 'web-search', query: 'orphan', maxResults: 5, timeoutMs: 10_000 },
      new AbortController().signal,
    )).rejects.toThrow('knowledge Wiki web-search stage has no endpoint configured')
  })

  it('surfaces a web-search upstream failure', async () => {
    const server = createServer((_request, response) => { response.statusCode = 503; response.end('no') })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => { resolve() }))
    servers.push(server)
    const port = (server.address() as { port: number }).port
    const executor = createOwnedStageExecutor({
      resolveConnection: async () => ({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k' }),
      search: { baseUrl: `http://127.0.0.1:${String(port)}` },
    })
    await expect(executor.execute(
      { kind: 'web-search', query: 'orphan', maxResults: 5, timeoutMs: 10_000 },
      new AbortController().signal,
    )).rejects.toThrow('knowledge Wiki web-search failed (503)')
  })

  it('fails the model stage when the connection facts are empty', async () => {
    const executor = createOwnedStageExecutor({ resolveConnection: async () => ({ baseUrl: '', apiKey: '' }) })
    await expect(executor.execute(
      { kind: 'llm-complete', provider: 'deepseek-official', model: 'm', prompt: 'p', operation: 'ingest analysis', timeoutMs: 10_000 },
      new AbortController().signal,
    )).rejects.toThrow('knowledge Wiki stage has no model connection facts')
  })

  it('reports a source file the isolate cannot read instead of an empty stage', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stage-missing-'))
    roots.push(root)
    await expect(executorFor('http://127.0.0.1:1').execute(
      { kind: 'file-extract', path: join(root, 'absent.md'), timeoutMs: 10_000 },
      new AbortController().signal,
    )).rejects.toThrow('ENOENT')
  })
})
