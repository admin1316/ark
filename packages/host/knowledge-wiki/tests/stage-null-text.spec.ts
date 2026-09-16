import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createOwnedStageExecutor } from '../src/owned-stage-executor.ts'

const servers: Array<ReturnType<typeof createServer>> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

describe('owned stage executor null model text', () => {
  it('presents a model answer without content as a null stage text', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ choices: [{ message: {} }] }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => { resolve() }))
    servers.push(server)
    const port = (server.address() as { port: number }).port
    const executor = createOwnedStageExecutor({
      resolveConnection: async () => ({ baseUrl: `http://127.0.0.1:${String(port)}`, apiKey: 'k' }),
    })
    const result = await executor.execute(
      { kind: 'llm-complete', provider: 'deepseek-official', model: 'm', prompt: 'p', operation: 'ingest analysis', timeoutMs: 10_000 },
      new AbortController().signal,
    )
    expect(result.text).toBeNull()
  })
})
