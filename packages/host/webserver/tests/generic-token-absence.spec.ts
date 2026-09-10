import { once } from 'node:events'
import { connect } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

const cryptoState = vi.hoisted(() => ({
  token: '' as string | undefined,
  hash: 'mock-index-script-hash' as string | undefined,
}))

// The public generic server helpers explicitly support a no-token caller. A
// controlled crypto carrier drives that contract without weakening the real
// launch path, whose normal randomBytes(32) result is always non-empty.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    randomBytes: () => ({ toString: () => cryptoState.token }) as unknown as Buffer,
    createHash: () => ({ update: () => ({ digest: () => cryptoState.hash }) }),
  }
})

import HttpServer from '../src/index.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  cryptoState.token = ''
  cryptoState.hash = 'mock-index-script-hash'
})

async function mount(): Promise<HttpServer> {
  context = new Context()
  await context.plugin(HttpServer, { host: '127.0.0.1', port: 0 })
  return context.webServer
}

async function apiUpgrade(port: number): Promise<string> {
  const socket = connect(port, '127.0.0.1')
  await once(socket, 'connect')
  const response = once(socket, 'data')
  socket.write([
    'GET /api/events HTTP/1.1',
    `Host: 127.0.0.1:${String(port)}`,
    'Connection: Upgrade',
    'Upgrade: dsh-test',
    '',
    '',
  ].join('\r\n'))
  const [data] = await response as [Buffer]
  socket.destroy()
  return String(data)
}

describe('generic no-token WebServer contract', () => {
  it('keeps HTTP and upgrade routes available when a generic caller supplies an empty token', async () => {
    cryptoState.token = ''
    const server = await mount()
    server.register({ kind: 'prefix', path: '/api', handler: (_req, res) => { res.writeHead(200); res.end('API') } })
    server.registerUpgrade({ path: '/api/events', handler: (_req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
    } })
    expect((server as unknown as { apiToken: unknown }).apiToken).toBe('')
    expect((await fetch(`http://127.0.0.1:${String(server.port)}/api`)).status).toBe(200)
    expect(await apiUpgrade(server.port)).toContain('101 Switching Protocols')
  })

  it('keeps the undefined-token and absent-index-hash defensive arms explicit', async () => {
    cryptoState.token = undefined
    cryptoState.hash = undefined
    const server = await mount()
    server.register({ kind: 'prefix', path: '/api', handler: (_req, res) => { res.writeHead(200); res.end('API') } })
    server.registerFallback((_req, res) => {
      res.writeHead(200, server.indexSecurityHeaders())
      res.end(server.applyIndexTaps('<head></head><body>generic</body>'))
    })
    expect((server as unknown as { apiToken: unknown }).apiToken).toBeUndefined()
    expect((await fetch(`http://127.0.0.1:${String(server.port)}/api`)).status).toBe(200)
    const index = await fetch(`http://127.0.0.1:${String(server.port)}/`)
    expect(index.headers.get('content-security-policy')).not.toContain('sha256-')
  })
})
