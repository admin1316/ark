/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * vendored Loader mounts the webserver row, and every assertion observes the
 * user-visible HTTP surface of the running server (routing precedence, index
 * taps, fallback-seat semantics, per-request error containment, teardown).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import type { Server } from 'node:http'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer, { renderIndexInjections } from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Write a cordis.yml with one webserver row, then boot it through the real Loader. */
async function loadComposition(port = 0, host: '127.0.0.1' | '0.0.0.0' = '127.0.0.1', apiOnly = false, apiPort?: number): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-webserver-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    `    host: '${host}'`,
    `    port: ${String(port)}`,
    `    apiOnly: ${String(apiOnly)}`,
    ...(apiPort === undefined ? [] : [`    apiPort: ${String(apiPort)}`]),
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/** Reserve a free port by binding once and releasing it. */
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => { probe.listen(0, '127.0.0.1', resolve) })
  const port = (probe.address() as { port: number }).port
  await new Promise<void>((resolve) => { probe.close(() =>{  resolve() }) })
  return port
}

/** GET (by default) one path against the running server; returns status plus a body prefix. */
async function request(port: number, path: string, init?: RequestInit): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, init)
  return { status: response.status, body: (await response.text()).slice(0, 160) }
}

/** Open one raw upgrade request and return after the handler writes its response. */
async function upgrade(port: number, path: string): Promise<ReturnType<typeof connect>> {
  const socket = connect(port, '127.0.0.1')
  await once(socket, 'connect')
  const response = once(socket, 'data')
  socket.write([
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${String(port)}`,
    'Connection: Upgrade',
    'Upgrade: dsh-test',
    '',
    '',
  ].join('\r\n'))
  const [data] = await response as [Buffer]
  expect(String(data)).toContain('101 Switching Protocols')
  return socket
}

/** Open one raw upgrade request with extra headers; returns the first response chunk. */
async function rawUpgrade(
  port: number,
  path: string,
  extraHeaders: Record<string, string> = {},
  hostHeader = `127.0.0.1:${String(port)}`,
): Promise<Buffer> {
  const socket = connect(port, '127.0.0.1')
  await once(socket, 'connect')
  const response = once(socket, 'data')
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: ${hostHeader}`,
    'Connection: Upgrade',
    'Upgrade: dsh-test',
    ...Object.entries(extraHeaders).map(([name, value]) => `${name}: ${value}`),
    '',
    '',
  ]
  socket.write(lines.join('\r\n'))
  const [data] = await response as [Buffer]
  socket.destroy()
  return data
}

/** Send an upgrade whose only contract is that the server rejects and closes it. */
async function closedUpgrade(port: number, path: string): Promise<void> {
  const socket = connect(port, '127.0.0.1')
  socket.on('error', () => undefined)
  await once(socket, 'connect')
  const closed = once(socket, 'close')
  socket.write([
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${String(port)}`,
    'Connection: Upgrade',
    'Upgrade: dsh-test',
    '',
    '',
  ].join('\r\n'))
  await closed
}

/** One raw HTTP request with a caller-supplied Host header; returns the first response line. */
async function rawRequest(port: number, path: string, hostHeader: string): Promise<string> {
  const socket = connect(port, '127.0.0.1')
  await once(socket, 'connect')
  const response = once(socket, 'data')
  socket.write([
    `GET ${path} HTTP/1.1`,
    `Host: ${hostHeader}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n'))
  const [data] = await response as [Buffer]
  socket.destroy()
  return String(data)
}

describe('real Loader composition', () => {
  // Real-Loader composition resolves workspace packages through tsx at test
  // time; first resolution after the host/client program split is slow enough
  // to trip the default 5s budget on cold caches.
  it('serves registered routes, index taps, and the fallback-seat semantics', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    const server = loaded.webServer
    expect(server).toBeInstanceOf(HttpServer)
    const port = server.port
    expect(port).toBeGreaterThan(0)

    // Routing precedence: exact beats prefix, longest prefix wins, a prefix
    // route answers its own path, and routes own their method handling
    // (POST reaches a registered prefix; 405 is fallback-only semantics).
    server.register({ kind: 'exact', path: '/probe', handler: (_req, res) => { res.writeHead(200); res.end('EXACT') } })
    server.register({ kind: 'prefix', path: '/api', handler: (_req, res) => { res.writeHead(200); res.end('API') } })
    server.register({ kind: 'prefix', path: '/api/deep', handler: (_req, res) => { res.writeHead(200); res.end('DEEP') } })
    // Register longest first so the later shorter match proves it cannot
    // replace the already-selected route during the same table walk.
    server.register({ kind: 'prefix', path: '/rank/deep', handler: (_req, res) => { res.writeHead(200); res.end('RANK-DEEP') } })
    server.register({ kind: 'prefix', path: '/rank', handler: (_req, res) => { res.writeHead(200); res.end('RANK-SHALLOW') } })
    // The API gate mints a launch-scoped token even without DSH_API_TOKEN, so
    // authenticated requests carry it as a bearer; non-API routes are open.
    const auth = { headers: { Authorization: `Bearer ${server.apiToken}` } }
    expect(await request(port, '/probe')).toMatchObject({ status: 200, body: 'EXACT' })
    expect(await request(port, '/api/anything', auth)).toMatchObject({ status: 200, body: 'API' })
    expect(await request(port, '/api/deep/leaf', auth)).toMatchObject({ status: 200, body: 'DEEP' })
    expect(await request(port, '/api', auth)).toMatchObject({ status: 200, body: 'API' })
    expect(await request(port, '/api/anything', { ...auth, method: 'POST' })).toMatchObject({ status: 200, body: 'API' })
    expect(await request(port, '/rank/deep/leaf')).toMatchObject({ status: 200, body: 'RANK-DEEP' })

    // Fallback seat: 404 while unclaimed; the owner answers everything no
    // named route matches; index taps are the owner's to apply; the seat
    // admits exactly one owner and the disposer releases it.
    expect((await request(port, '/no/such/route')).status).toBe(404)
    const untap = server.tapIndex(html => html.replace('<head>', '<head><script>window.__T__=1</script>'))
    expect(server.applyIndexTaps('<head></head>')).toContain('__T__')
    const releaseFallback = server.registerFallback((req, res) => {
      // Decode like a real static server would — a malformed %-escape throws
      // here, probing the webserver's per-request error containment.
      decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(server.applyIndexTaps('<head></head><body>shell</body>'))
    })
    expect(() => server.registerFallback(() => {})).toThrow(/fallback already registered/)
    expect((await request(port, '/no/such/route')).body).toContain('__T__')
    untap()
    expect((await request(port, '/no/such/route')).body).not.toContain('__T__')
    // A stale cleanup cannot remove a later transform by reusing its callback.
    untap()
    // The minted token cookie script precedes the shell body in the 80-char
    // truncation, so probe the fallback output past it.
    const fallbackBody = (await fetch(`http://127.0.0.1:${String(port)}/no/such/route`)).text()
    expect(await fallbackBody).toContain('shell')

    // Per-request error containment: a malformed %-escape answers 400 and the
    // server keeps serving afterwards (no process-level failure path).
    expect((await request(port, '/%zz')).status).toBe(400)
    expect(await request(port, '/probe')).toMatchObject({ status: 200, body: 'EXACT' })

    // Duplicate (kind, path) is a misconfiguration and throws; the disposer
    // restores registrability (register/disposer symmetry).
    expect(() => server.register({ kind: 'exact', path: '/probe', handler: () => {} }))
      .toThrow(/duplicate exact route/)
    const disposeOnce = server.register({ kind: 'exact', path: '/once', handler: (_req, res) => { res.writeHead(200); res.end('ONCE') } })
    expect(await request(port, '/once')).toMatchObject({ status: 200, body: 'ONCE' })
    disposeOnce()
    expect((await (await fetch(`http://127.0.0.1:${String(port)}/once`)).text())).toContain('shell') // back to the fallback owner
    expect(() => server.register({ kind: 'exact', path: '/once', handler: () => {} })).not.toThrow()

    // Releasing the seat restores the unclaimed 404 and registrability.
    releaseFallback()
    expect((await request(port, '/no/such/route')).status).toBe(404)
    expect(() => server.registerFallback(() => {})).not.toThrow()

    // Upgrade routes match exact pathnames, reject duplicate ownership, and
    // become registrable again after disposal. The accepted socket stays open
    // so the teardown assertion also covers upgraded-connection ownership.
    let upgradedServerClosed = false
    const disposeUpgrade = server.registerUpgrade({
      path: '/events',
      handler: (_req, socket) => {
        socket.once('close', () => { upgradedServerClosed = true })
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
      },
    })
    expect(() => server.registerUpgrade({ path: '/events', handler: () => {} }))
      .toThrow(/duplicate upgrade route/)
    const upgraded = await upgrade(port, '/events?stream=mux')
    disposeUpgrade()
    expect(() => server.registerUpgrade({ path: '/events', handler: () => {} })).not.toThrow()

    // The webserver contains raw-socket errors even before an upgrade handler
    // has installed its protocol implementation.
    server.registerUpgrade({
      path: '/upgrade-error',
      handler: async (_req, socket) => {
        await Promise.resolve()
        socket.destroy(new Error('test upgrade transport failure'))
      },
    })
    const failedUpgrade = connect(port, '127.0.0.1')
    failedUpgrade.on('error', () => { /* The server-side reset is the fixture outcome. */ })
    await once(failedUpgrade, 'connect')
    const failedUpgradeClosed = once(failedUpgrade, 'close')
    failedUpgrade.write([
      'GET /upgrade-error HTTP/1.1',
      `Host: 127.0.0.1:${String(port)}`,
      'Connection: Upgrade',
      'Upgrade: dsh-test',
      '',
      '',
    ].join('\r\n'))
    await failedUpgradeClosed
    expect(await request(port, '/probe')).toMatchObject({ status: 200, body: 'EXACT' })

    // Teardown closes both ordinary and upgraded sockets before it resolves.
    await loaded.fiber.dispose()
    expect(upgradedServerClosed).toBe(true)
    upgraded.destroy()
    await expect(request(port, '/probe')).rejects.toThrow()
  })

  it('collects injection rows fresh per render and layers taps over the rendered rows', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const server = loaded.webServer
    let flag = 'dark'
    loaded.on('webserver/index-inject', (table) => {
      table.push(
        { kind: 'script', placement: 'head', text: 'window.__Q__=1' },
        { kind: 'script-src', placement: 'head', src: '/plugins/a.js?rev="1"&x=<y>' },
        { kind: 'global', name: '__DSH_BOOT__', value: { rev: '</script><b>' } },
        { kind: 'style', text: 'body{margin:0}' },
        { kind: 'html', placement: 'head', html: '<meta name="probe">' },
        { kind: 'script', placement: 'body', text: `window.__P__=${JSON.stringify(flag)}` },
      )
    })

    const html = server.renderIndex('<html><head></head><body>shell</body></html>')
    // Head rows land right after the opening head tag in table order; the body
    // row lands right after the opening body tag.
    const order = [
      '<head>',
      '<script>window.__Q__=1</script>',
      '<script src="/plugins/a.js?rev=&quot;1&quot;&amp;x=&lt;y&gt;"></script>',
      'globalThis["__DSH_BOOT__"] = {"rev":"\\u003c/script>\\u003cb>"}',
      '<style>body{margin:0}</style>',
      '<meta name="probe">',
      '<body>',
      '<script>window.__P__="dark"</script>',
      'shell',
    ].map(part => html.indexOf(part))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(order.every(at => at !== -1)).toBe(true)

    // Fresh collection per render: the listener reads live state at emit time.
    flag = 'light'
    expect(server.renderIndex('<head></head><body></body>')).toContain('window.__P__="light"')

    // Raw taps still run, over the already-rendered rows.
    const untap = server.tapIndex(h => h.replace('window.__Q__=1', 'window.__Q__=2'))
    expect(server.renderIndex('<head></head><body></body>')).toContain('window.__Q__=2')
    untap()

    // Tag-less fragments: head rows prepend, body rows append.
    expect(renderIndexInjections('<main>x</main>', [
      { kind: 'script', placement: 'head', text: 'H' },
      { kind: 'script', placement: 'body', text: 'B' },
    ])).toBe('<script>H</script><main>x</main><script>B</script>')

    expect(renderIndexInjections('<head></head><body></body>', [
      { kind: 'global', name: '__UNDEFINED__', value: undefined },
    ])).toContain('globalThis["__UNDEFINED__"] = undefined')
    expect(renderIndexInjections('<main>unchanged</main>', [])).toBe('<main>unchanged</main>')
    expect(() => renderIndexInjections('<head></head>', [
      { kind: 'corrupt' } as never,
    ])).toThrow(/unknown index injection row/u)
  })

  it('fails the fiber when the port is already taken (fail-loud at activation)', { timeout: 60_000 }, async () => {
    const first = await loadComposition()
    const takenPort = first.webServer.port
    const firstRoot = root
    root = undefined // keep the first composition's files until the end

    let second: Context | undefined
    try {
      let failure: unknown
      try {
        await loadComposition(takenPort)
      } catch (error) {
        failure = error
      }
      second = context
      expect(String(failure)).toMatch(/failed to apply loader entry.*EADDRINUSE/)
    } finally {
      await second?.fiber.dispose()
      context = first
      if (root !== undefined) await rm(root, { recursive: true, force: true })
      root = firstRoot
    }
  })
})

describe('launch-scoped API token gate', () => {
  it('plants the SameSite cookie and rejects /api without it', { timeout: 60_000 }, async () => {
    vi.stubEnv('DSH_API_TOKEN', 'test-token-abcdef0123456789')
    try {
      const loaded = await loadComposition()
      const server = loaded.webServer
      const port = server.port
      server.register({ kind: 'prefix', path: '/api', handler: (_req, res) => { res.writeHead(200); res.end('API') } })
      server.registerFallback((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html', ...server.indexSecurityHeaders() })
        res.end(server.applyIndexTaps('<head></head><body>shell</body>'))
      })

      // The index response plants the SameSite cookie (the request helper
      // truncates bodies at 80 characters, so assert the token, Path and the
      // HttpOnly flag that keeps it out of page JS).
      expect((await request(port, '/no/such/route')).body).toContain('dsh_api_token=test-token-abcdef0123456789;Path=/;SameSite=Strict;HttpOnly')

      // /api without the token answers 401; with cookie or bearer it passes.
      expect((await request(port, '/api/anything')).status).toBe(401)
      expect((await request(port, '/api', {
        headers: { Cookie: 'dsh_api_token=test-token-abcdef0123456789' },
      }))).toMatchObject({ status: 200, body: 'API' })
      expect((await request(port, '/api', {
        headers: { Authorization: 'Bearer test-token-abcdef0123456789' },
      }))).toMatchObject({ status: 200, body: 'API' })
      expect((await request(port, '/api', {
        method: 'OPTIONS',
      })).status).toBe(200)

      // A wrong token stays rejected.
      expect((await request(port, '/api', {
        headers: { Cookie: 'dsh_api_token=wrong-token' },
      })).status).toBe(401)

      // Non-API paths are unaffected.
      expect((await request(port, '/no/such/route')).status).toBe(200)

      // The index response carries a Content-Security-Policy admitting the
      // planted cookie script by hash, never 'unsafe-inline'.
      const index = await fetch(`http://127.0.0.1:${String(port)}/index.html`)
      const csp = index.headers.get('content-security-policy')
      expect(csp).toContain("default-src 'self'")
      expect(csp).toContain("script-src 'self' 'unsafe-eval' 'sha256-")
      expect(csp!.split(';').find(directive => directive.trim().startsWith('script-src'))).not.toContain("'unsafe-inline'")
      expect(csp).toContain("frame-ancestors 'none'")
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('gates /api WebSocket upgrades with the same token as HTTP', { timeout: 60_000 }, async () => {
    vi.stubEnv('DSH_API_TOKEN', 'test-token-abcdef0123456789')
    try {
      const loaded = await loadComposition()
      const server = loaded.webServer
      const port = server.port
      server.registerUpgrade({
        path: '/api/events/mux',
        handler: (_req, socket) => {
          socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
        },
      })
      server.registerUpgrade({
        path: '/events',
        handler: (_req, socket) => {
          socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
        },
      })

      // Without the token the upgrade is answered 401 and the socket closed.
      expect(String(await rawUpgrade(port, '/api/events/mux'))).toContain('401 Unauthorized')
      expect(String(await rawUpgrade(port, '/api/events/mux', { Cookie: 'dsh_api_token=wrong-token' }))).toContain('401 Unauthorized')
      expect(String(await rawUpgrade(port, '/api/events/mux', { Authorization: 'Bearer wrong-token' }))).toContain('401 Unauthorized')

      // With the cookie or the bearer token the upgrade proceeds.
      expect(String(await rawUpgrade(port, '/api/events/mux', { Cookie: 'dsh_api_token=test-token-abcdef0123456789' }))).toContain('101 Switching Protocols')
      expect(String(await rawUpgrade(port, '/api/events/mux', { Authorization: 'Bearer test-token-abcdef0123456789' }))).toContain('101 Switching Protocols')
      // Browser sockets cannot set headers, so the token may ride the query.
      expect(String(await rawUpgrade(port, '/api/events/mux?token=test-token-abcdef0123456789'))).toContain('101 Switching Protocols')
      expect(String(await rawUpgrade(port, '/api/events/mux?token=wrong-token'))).toContain('401 Unauthorized')

      // Non-API upgrade paths are unaffected, mirroring the HTTP rule.
      expect(String(await rawUpgrade(port, '/events'))).toContain('101 Switching Protocols')
      expect(String(await rawUpgrade(port, '/events', {}, 'attacker.example'))).toContain('401 Unauthorized')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('generates a launch-scoped token and rejects /api without it when none is exported', { timeout: 60_000 }, async () => {
    vi.stubEnv('DSH_API_TOKEN', '')
    try {
      const loaded = await loadComposition()
      const server = loaded.webServer
      const port = server.port
      server.register({ kind: 'prefix', path: '/api', handler: (_req, res) => { res.writeHead(200); res.end('API') } })
      server.registerFallback((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html', ...server.indexSecurityHeaders() })
        res.end(server.applyIndexTaps('<head></head><body>shell</body>'))
      })
      // The gate is never disabled by default: a fresh random token is
      // minted per launch, and unauthenticated /api requests are rejected.
      expect(server.apiToken).toBeTruthy()
      expect((await request(port, '/api')).status).toBe(401)
      expect((await request(port, '/api', { headers: { Cookie: 'dsh_api_token=nope' } })).status).toBe(401)
      // The index response plants the minted SameSite cookie, which the
      // browser then attaches to same-origin /api requests.
      const token = server.apiToken
      expect((await request(port, '/api', { headers: { Cookie: `dsh_api_token=${token}` } }))).toMatchObject({ status: 200, body: 'API' })
      expect((await request(port, '/api', { headers: { Authorization: `Bearer ${token}` } }))).toMatchObject({ status: 200, body: 'API' })
      server.registerUpgrade({
        path: '/api/events/mux',
        handler: (_req, socket) => {
          socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
        },
      })
      expect(String(await rawUpgrade(port, '/api/events/mux'))).toContain('401 Unauthorized')
      expect(String(await rawUpgrade(port, '/api/events/mux', { Cookie: `dsh_api_token=${token}` }))).toContain('101 Switching Protocols')
      // The generated token is unknown to the CSP: no inline script hash.
      const index = await fetch(`http://127.0.0.1:${String(port)}/`)
      const csp = index.headers.get('content-security-policy')
      expect(csp).toContain("script-src 'self' 'unsafe-eval' 'sha256-")
      expect(csp!.split(';').find(directive => directive.trim().startsWith('script-src'))).not.toContain("'unsafe-inline'")
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('refuses binding 0.0.0.0 without an explicit token', async () => {
    vi.stubEnv('DSH_API_TOKEN', '')
    try {
      await expect(loadComposition(0, '0.0.0.0')).rejects.toThrow(/requires an explicit apiToken/)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('rejects foreign Host headers on loopback binding (DNS-rebinding fence)', { timeout: 60_000 }, async () => {
    vi.stubEnv('DSH_API_TOKEN', 'test-token-abcdef0123456789')
    try {
      const loaded = await loadComposition()
      const server = loaded.webServer
      const port = server.port
      server.register({ kind: 'prefix', path: '/api', handler: (_req, res) => { res.writeHead(200); res.end('API') } })
      server.registerFallback((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html', ...server.indexSecurityHeaders() })
        res.end(server.applyIndexTaps('<head></head><body>shell</body>'))
      })

      // A DNS-rebinding page arrives with its own origin as the Host header;
      // every path (index included — it carries the token-planting script)
      // is refused before routing.
      expect(await rawRequest(port, '/', 'attacker.example')).toContain('403')
      expect(await rawRequest(port, '/api', 'attacker.example')).toContain('403')
      expect(await rawRequest(port, '/api', '127.0.0.1.evil.test:80')).toContain('403')
      expect(await rawRequest(port, '/', '')).toContain('403')

      // Loopback aliases pass, including IPv6 literal syntax.
      expect(await rawRequest(port, '/no/such/route', `localhost:${String(port)}`)).toContain('200')
      expect(await rawRequest(port, '/no/such/route', `[::1]:${String(port)}`)).toContain('200')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('API-only service mode and health probe', () => {
  it('answers / with a status document and every other page with JSON 404', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition(0, '127.0.0.1', true)
    const server = loaded.webServer
    const port = server.port

    const untouchedIndex = '<html><head></head><body>native-api-only</body></html>'
    expect(server.indexSecurityHeaders()).toEqual({})
    expect(server.applyIndexTaps(untouchedIndex)).toBe(untouchedIndex)
    expect(server.applyIndexTaps(untouchedIndex)).not.toContain('dsh_api_token')
    expect(server.applyIndexTaps(untouchedIndex)).not.toContain('__DSH_API_TOKEN__')

    expect((await request(port, '/'))).toMatchObject({ status: 200, body: '{"service":"Planet API","status":"running"}' })
    expect((await request(port, '/no/such/page'))).toMatchObject({ status: 404, body: '{"error":"not found"}' })

    // The SPA fallback seat is unreachable even when a fallback owner exists.
    server.registerFallback((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>fallback</html>')
    })
    server.registerUpgrade({
      path: '/sidebar/ws/terminal',
      handler: (_req, socket) => {
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
      },
    })
    expect((await request(port, '/index.html')).status).toBe(404)
    expect(String(await rawUpgrade(port, '/sidebar/ws/terminal'))).toContain('404 Not Found')
  })

  it('keeps /api routes fully functional in API-only mode', { timeout: 60_000 }, async () => {
    vi.stubEnv('DSH_API_TOKEN', 'test-token-abcdef0123456789')
    try {
      const loaded = await loadComposition(0, '127.0.0.1', true)
      const server = loaded.webServer
      const port = server.port
      server.register({ kind: 'prefix', path: '/api', handler: (_req, res) => { res.writeHead(200); res.end('API') } })

      expect((await request(port, '/api')).status).toBe(401)
      expect((await request(port, '/api', { headers: { Authorization: 'Bearer test-token-abcdef0123456789' } }))).toMatchObject({ status: 200, body: 'API' })
      // The health probe is the one gate exemption, for credential-free readiness checks.
      expect((await request(port, '/api/health'))).toMatchObject({ status: 200, body: '{"status":"ok"}' })
      expect((await request(port, '/api/health?x=1')).status).toBe(200)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('fixed API-only listener (apiPort)', () => {
  it('serves the API surface on the fixed port while the primary keeps the UI', { timeout: 60_000 }, async () => {
    vi.stubEnv('DSH_API_TOKEN', 'test-token-abcdef0123456789')
    try {
      const apiPort = await freePort()
      const loaded = await loadComposition(0, '127.0.0.1', false, apiPort)
      const server = loaded.webServer
      const port = server.port
      // The primary listener still serves the fallback UI (apiOnly stays off).
      server.registerFallback((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html>fallback</html>')
      })
      server.register({ kind: 'prefix', path: '/api', handler: (_req, res) => { res.writeHead(200); res.end('API') } })

      // Fixed listener: API-only semantics — JSON status at /, JSON 404 for pages,
      // even though the fallback seat exists.
      expect((await request(apiPort, '/'))).toMatchObject({ status: 200, body: '{"service":"Planet API","status":"running"}' })
      expect((await request(apiPort, '/index.html'))).toMatchObject({ status: 404, body: '{"error":"not found"}' })
      // The token gate binds the fixed listener exactly like the primary.
      expect((await request(apiPort, '/api')).status).toBe(401)
      expect((await request(apiPort, '/api', { headers: { Authorization: 'Bearer test-token-abcdef0123456789' } }))).toMatchObject({ status: 200, body: 'API' })
      expect((await request(apiPort, '/api/health'))).toMatchObject({ status: 200, body: '{"status":"ok"}' })

      // Primary listener: untouched UI surface on its own port.
      expect((await request(port, '/index.html'))).toMatchObject({ status: 200, body: '<html>fallback</html>' })
      expect((await request(port, '/'))).toMatchObject({ status: 200, body: '<html>fallback</html>' })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('gates WebSocket upgrades on the fixed listener with the same token', { timeout: 60_000 }, async () => {
    vi.stubEnv('DSH_API_TOKEN', 'test-token-abcdef0123456789')
    try {
      const apiPort = await freePort()
      const loaded = await loadComposition(0, '127.0.0.1', false, apiPort)
      const server = loaded.webServer
      server.registerUpgrade({
        path: '/api/events/mux',
        handler: (_req, socket) => {
          socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
        },
      })
      server.registerUpgrade({
        path: '/sidebar/ws/terminal',
        handler: (_req, socket) => {
          socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
        },
      })

      expect(String(await rawUpgrade(apiPort, '/api/events/mux'))).toContain('401 Unauthorized')
      expect(String(await rawUpgrade(apiPort, '/api/events/mux', { Authorization: 'Bearer test-token-abcdef0123456789' }))).toContain('101 Switching Protocols')
      expect(String(await rawUpgrade(apiPort, '/api/events/mux?token=test-token-abcdef0123456789'))).toContain('101 Switching Protocols')
      expect(String(await rawUpgrade(apiPort, '/sidebar/ws/terminal'))).toContain('404 Not Found')
      expect(String(await rawUpgrade(apiPort, '/sidebar/ws/terminal', { Authorization: 'Bearer test-token-abcdef0123456789' }))).toContain('404 Not Found')
      expect(String(await rawUpgrade(apiPort, '/api/%2e%2e/sidebar/ws/terminal', { Authorization: 'Bearer test-token-abcdef0123456789' }))).toContain('404 Not Found')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('network fault containment and explicit network binding', () => {
  it('accepts an explicit all-interface listener, contains a partial-response error, and logs later server errors', { timeout: 60_000 }, async () => {
    vi.stubEnv('DSH_API_TOKEN', 'test-token-abcdef0123456789')
    try {
      const loaded = await loadComposition(0, '0.0.0.0')
      const server = loaded.webServer
      const port = server.port
      expect(server.host).toBe('0.0.0.0')
      server.registerFallback((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.write('partial')
        throw 'fallback write failure'
      })
      // An all-interface listener is intentionally outside the loopback Host
      // fence; the explicit launch token is the required exposure boundary.
      const broken = await fetch(`http://127.0.0.1:${String(port)}/broken`, {
        headers: { Host: 'attacker.example' },
      })
      await expect(broken.text()).rejects.toThrow()

      const error = vi.spyOn(loaded.logger, 'error').mockImplementation(() => undefined)
      try {
        const raw = (server as unknown as { server: Server }).server
        raw.emit('error', new Error('post-listen transport failure'))
        expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'post-listen transport failure' }))
      } finally {
        error.mockRestore()
      }
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('contains unmatched, rejected, synchronous-throwing, and malformed upgrade requests without taking down HTTP', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const server = loaded.webServer
    const port = server.port
    server.register({ kind: 'exact', path: '/still-alive', handler: (_req, res) => { res.writeHead(200); res.end('alive') } })
    server.registerUpgrade({ path: '/async-reject', handler: async () => { throw new Error('async upgrade failure') } })
    server.registerUpgrade({ path: '/sync-throw', handler: () => { throw new Error('sync upgrade failure') } })
    server.registerUpgrade({ path: '/async-reject-value', handler: async () => { throw 'async upgrade value failure' } })
    server.registerUpgrade({ path: '/sync-throw-value', handler: () => { throw 'sync upgrade value failure' } })

    await closedUpgrade(port, '/no-upgrade-owner')
    await closedUpgrade(port, '/async-reject')
    await closedUpgrade(port, '/sync-throw')
    await closedUpgrade(port, '/async-reject-value')
    await closedUpgrade(port, '/sync-throw-value')
    await closedUpgrade(port, 'http://[')

    // Node's server-side IncomingMessage type permits an absent url even
    // though ordinary node:http requests always set it. The listener's
    // defensive fallback must still reject this non-routable upgrade safely.
    const raw = (server as unknown as { server: Server }).server
    const fakeSocket = {
      on: () => fakeSocket,
      once: () => fakeSocket,
      off: () => fakeSocket,
      destroy: vi.fn(),
      end: vi.fn(),
    }
    raw.emit('upgrade', { headers: { host: `127.0.0.1:${String(port)}` }, url: undefined } as never, fakeSocket as never, Buffer.alloc(0))
    expect(fakeSocket.destroy).toHaveBeenCalledOnce()

    let urlReads = 0
    const changingUrlRequest = {
      headers: { host: `127.0.0.1:${String(port)}` },
      get url(): string | undefined {
        urlReads += 1
        return urlReads === 1 ? '/api/events?token=wrong' : undefined
      },
    }
    const tokenSocket = {
      on: () => tokenSocket,
      once: () => tokenSocket,
      off: () => tokenSocket,
      destroy: vi.fn(),
      end: vi.fn(),
    }
    raw.emit('upgrade', changingUrlRequest as never, tokenSocket as never, Buffer.alloc(0))
    expect(urlReads).toBe(2)
    expect(tokenSocket.end).toHaveBeenCalledOnce()

    const normalized = vi.spyOn(loaded.logger, 'warn').mockImplementation(() => undefined)
    const throwingRequest = {
      headers: { host: `127.0.0.1:${String(port)}` },
      get url(): never { throw 'malformed URL accessor' },
    }
    const errorSocket = {
      on: () => errorSocket,
      once: () => errorSocket,
      off: () => errorSocket,
      destroy: vi.fn(),
      end: vi.fn(),
    }
    try {
      raw.emit('upgrade', throwingRequest as never, errorSocket as never, Buffer.alloc(0))
      expect(normalized).toHaveBeenCalledWith(expect.objectContaining({ message: 'malformed URL accessor' }))
      expect(errorSocket.destroy).toHaveBeenCalledOnce()
    } finally {
      normalized.mockRestore()
    }

    expect(await request(port, '/still-alive')).toMatchObject({ status: 200, body: 'alive' })
  })
})
