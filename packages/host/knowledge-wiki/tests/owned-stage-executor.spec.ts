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
})
