import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readResponseBounded, requestPinned } from '../src/index.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('pinned local TLS transport', () => {
  it('uses the validated address while retaining the original SNI and Host', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-pinned-tls-'))
    roots.push(root)
    const keyPath = join(root, 'key.pem')
    const certPath = join(root, 'cert.pem')
    const configPath = join(root, 'openssl.cnf')
    writeFileSync(configPath, [
      '[req]',
      'prompt = no',
      'distinguished_name = dn',
      'x509_extensions = ext',
      '[dn]',
      'CN = example.test',
      '[ext]',
      'subjectAltName = DNS:example.test',
    ].join('\n'))
    execFileSync('/usr/bin/openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-config', configPath, '-keyout', keyPath, '-out', certPath,
    ], { stdio: 'ignore' })
    const key = readFileSync(keyPath)
    const cert = readFileSync(certPath)
    let host = ''
    let servername: string | false | null | undefined
    const server = createServer({ key, cert }, (request, response) => {
      host = request.headers.host ?? ''
      response.end('pinned')
    })
    server.on('secureConnection', (socket) => { servername = socket.servername })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('missing TLS listener')
      const response = await requestPinned(
        new URL(`https://example.test:${address.port}/resource`),
        { address: '127.0.0.1', family: 4 },
        new AbortController().signal,
        cert,
      )
      await expect(readResponseBounded(response, 1024, new AbortController().signal))
        .resolves.toEqual(Buffer.from('pinned'))
      expect(host).toBe(`example.test:${address.port}`)
      expect(servername).toBe('example.test')
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve() })
      })
    }
  })
})
