import { describe, expect, it, vi } from 'vitest'
import type { McpServer } from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import type { Config as McpClientConfig } from '@deepseek-ai/dsh-mcp-client'
import { AcpMcpConfigError, mountAcpMcpServers } from '../src/mcp.ts'

function capturingContext(configs: McpClientConfig[]): Context {
  return {
    plugin: vi.fn(async (_plugin: unknown, config: McpClientConfig) => {
      configs.push(config)
      return undefined
    }),
  } as unknown as Context
}

async function reject(server: McpServer, message: RegExp): Promise<void> {
  await expect(mountAcpMcpServers(capturingContext([]), [server], process.cwd()))
    .rejects.toThrow(message)
}

describe('ACP standard MCP declarations', () => {
  it('maps ordered stdio env and HTTP headers without prototype mutation', async () => {
    const configs: McpClientConfig[] = []
    await mountAcpMcpServers(capturingContext(configs), [
      {
        name: 'local tools',
        command: process.execPath,
        args: ['fixture.mjs'],
        env: [
          { name: 'TOKEN', value: 'secret' },
          { name: '__proto__', value: 'literal' },
        ],
      },
      {
        type: 'http',
        name: 'remote',
        url: 'https://example.test/mcp',
        headers: [
          { name: 'Authorization', value: 'Bearer token' },
          { name: '__proto__', value: 'literal' },
        ],
      },
    ], process.cwd())

    expect(configs).toHaveLength(2)
    expect(configs[0]).toMatchObject({
      transport: 'stdio',
      command: process.execPath,
      args: ['fixture.mjs'],
      cwd: process.cwd(),
      toolCallTimeoutMs: 60_000,
      failOnStartupError: true,
    })
    expect(configs[0]?.serverName).toMatch(/^local_tools_[0-9a-f]{8}$/)
    if (configs[0]?.transport !== 'stdio') throw new Error('expected stdio config')
    expect(Object.getPrototypeOf(configs[0].env)).toBeNull()
    expect(configs[0].env.TOKEN).toBe('secret')
    expect(Object.hasOwn(configs[0].env, '__proto__')).toBe(true)
    expect(configs[0].env.__proto__).toBe('literal')

    expect(configs[1]).toMatchObject({
      transport: 'streamable-http',
      serverName: 'remote',
      url: 'https://example.test/mcp',
      toolCallTimeoutMs: 60_000,
      failOnStartupError: true,
    })
    if (configs[1]?.transport !== 'streamable-http') throw new Error('expected HTTP config')
    expect(Object.getPrototypeOf(configs[1].headers)).toBeNull()
    expect(configs[1].headers.Authorization).toBe('Bearer token')
    expect(Object.hasOwn(configs[1].headers, '__proto__')).toBe(true)
    expect(configs[1].headers.__proto__).toBe('literal')
  })

  it('normalizes long or symbol-only server names and rejects duplicates', async () => {
    const configs: McpClientConfig[] = []
    await mountAcpMcpServers(capturingContext(configs), [
      { name: '***', command: process.execPath, args: [], env: [] },
      { name: `${'long '.repeat(10)}name`, command: process.execPath, args: [], env: [] },
    ], process.cwd())
    expect(configs.map(config => config.serverName)).toEqual([
      expect.stringMatching(/^server_[0-9a-f]{8}$/),
      expect.stringMatching(/^long_long_long_long_.*_[0-9a-f]{8}$/),
    ])

    await expect(mountAcpMcpServers(capturingContext([]), [
      { name: 'same', command: process.execPath, args: [], env: [] },
      { name: 'same', command: process.execPath, args: [], env: [] },
    ], process.cwd())).rejects.toThrow(/duplicate normalized name/)
  })

  it('rejects invalid names, unsupported transports, commands, and URLs', async () => {
    await reject({ name: ' ', command: process.execPath, args: [], env: [] }, /invalid server name/)
    await reject({ name: 'bad\u0000name', command: process.execPath, args: [], env: [] }, /invalid server name/)
    await reject({ name: 'relative', command: 'node', args: [], env: [] }, /absolute path/)
    await reject({ type: 'http', name: 'bad-url', url: 'not a URL', headers: [] }, /absolute HTTP/)
    await reject({ type: 'http', name: 'ftp', url: 'ftp://example.test/mcp', headers: [] }, /absolute HTTP/)
    await reject({ type: 'sse', name: 'old', url: 'https://example.test/sse', headers: [] }, /not supported/)
    await reject({ type: 'acp', name: 'nested', id: 'id' }, /not supported/)
  })

  it('rejects each invalid or duplicate environment entry', async () => {
    const invalid = [
      { name: '', value: 'x' },
      { name: 'A=B', value: 'x' },
      { name: 'A\u0000B', value: 'x' },
      { name: 'A', value: 'x\u0000y' },
    ]
    for (const entry of invalid) {
      await reject({ name: 'env', command: process.execPath, args: [], env: [entry] }, /invalid environment entry/)
    }
    await reject({
      name: 'env',
      command: process.execPath,
      args: [],
      env: [{ name: 'A', value: '1' }, { name: 'A', value: '2' }],
    }, /duplicate name/)
  })

  it('validates HTTP header syntax and case-insensitive uniqueness', async () => {
    await reject({
      type: 'http', name: 'header', url: 'https://example.test/mcp', headers: [{ name: 'bad header', value: 'x' }],
    }, /invalid header entry/)
    await reject({
      type: 'http', name: 'header', url: 'https://example.test/mcp', headers: [{ name: 'X-Test', value: 'bad\u0000value' }],
    }, /invalid header entry/)
    await reject({
      type: 'http',
      name: 'header',
      url: 'https://example.test/mcp',
      headers: [{ name: 'X-Test', value: 'one' }, { name: 'x-test', value: 'two' }],
    }, /duplicate name/)
  })

  it('maps the MCP client schema failure to a caller-correctable error', async () => {
    const invalid = {
      name: 'schema',
      command: process.execPath,
      args: [1],
      env: [],
    } as unknown as McpServer
    const error = await mountAcpMcpServers(capturingContext([]), [invalid], process.cwd())
      .then(() => undefined, (cause: unknown) => cause)
    expect(error).toBeInstanceOf(AcpMcpConfigError)
    expect(error).toMatchObject({ name: 'AcpMcpConfigError' })
    expect(String(error)).toContain('mcpServers[0] is invalid')
  })
})
