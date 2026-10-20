import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { embed } from '../src/search.ts'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => { resolve() })
  })))
})
async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => { resolve() }))
  return 'http://127.0.0.1:' + String((server.address() as { port: number }).port)
}

describe('embedding endpoint authority', () => {
  it('never follows a redirect with a credential or source text', async () => {
    let redirectedRequests = 0
    const target = await listen(createServer((_request, response) => {
      redirectedRequests += 1
      response.end('{}')
    }))
    let expectedRequests = 0
    const source = await listen(createServer((request, response) => {
      expectedRequests += 1
      expect(request.headers.authorization).toBe('Bearer synthetic-embedding-route-key')
      response.writeHead(307, { location: target + '/must-not-receive' })
      response.end()
    }))
    await expect(embed(['synthetic source'], {
      provider: 'fixture-embedding', baseUrl: source, model: 'fixture-model', apiKey: 'synthetic-embedding-route-key',
    })).rejects.toThrow()
    expect(expectedRequests).toBe(1)
    expect(redirectedRequests).toBe(0)
  })

  it('settles an in-flight embedding fetch when its owner cancels', async () => {
    const arrived = Promise.withResolvers<undefined>()
    const source = await listen(createServer(() => { arrived.resolve(undefined) }))
    const controller = new AbortController()
    const operation = embed(['synthetic source'], {
      provider: 'fixture-embedding', baseUrl: source, model: 'fixture-model', apiKey: 'synthetic-embedding-route-key',
      signal: controller.signal,
    })
    const rejected = expect(operation).rejects.toThrow('embedding owner stopped')
    await arrived.promise
    controller.abort(new Error('embedding owner stopped'))
    await rejected
  })
})

import { Context } from '@deepseek-ai/cordis'
import KnowledgeWikiService from '../src/index.ts'
import { wikiTestConfig } from './config-fixture.ts'
import type { KnowledgeConnections } from '../src/connections.ts'
import type { EmbeddingConnection } from '../src/search.ts'

describe('embedding route snapshots', () => {
  it('keeps endpoint and credential reference together while credential lookup is pending', async () => {
    const ctx = new Context()
    const credential = Promise.withResolvers<{ value: string }>()
    const reads: string[] = []
    ctx.provide('credentials', {
      resolve(ref: string) { reads.push(ref); return credential.promise },
    })
    const service = new KnowledgeWikiService(ctx, wikiTestConfig({ wikiRoot: '/synthetic/wiki', mainRoot: '/synthetic' }))
    let config: KnowledgeConnections = {
      textProvider: 'fixture', textModel: 'fixture', visionProvider: '', visionModel: '',
      embeddingProvider: 'fixture-a', embeddingBaseUrl: 'https://a.fixture.test/v1',
      embeddingModel: 'a-model', embeddingCredential: 'EMBED_A_FIXTURE_KEY',
    }
    Object.assign(service, { connections: () => config })
    const read = (service as unknown as { embeddingConnection(): Promise<EmbeddingConnection | undefined> }).embeddingConnection()
    config = { ...config, embeddingProvider: 'fixture-b', embeddingBaseUrl: 'https://b.fixture.test/v1', embeddingCredential: 'EMBED_B_FIXTURE_KEY' }
    credential.resolve({ value: 'synthetic-only-for-a' })
    try {
      await expect(read).resolves.toMatchObject({
        provider: 'fixture-a', baseUrl: 'https://a.fixture.test/v1', model: 'a-model', apiKey: 'synthetic-only-for-a',
      })
      expect(reads).toEqual(['EMBED_A_FIXTURE_KEY'])
    } finally { await ctx.fiber.dispose() }
  })
})
