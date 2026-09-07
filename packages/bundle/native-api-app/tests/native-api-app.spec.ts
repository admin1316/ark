/** API-only bundle structure and its real Loader startup/readiness path. */

import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as yaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include, { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as HostConnection from '@deepseek-ai/dsh-host-connection'
import ApiGateway from '@deepseek-ai/dsh-api-gateway'
import PluginInventory from '@deepseek-ai/dsh-host-plugin-inventory'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import * as NativeApiApp from '../src/index.ts'
import * as NativeApiStartup from '../src/startup.ts'

interface PluginInventoryEnvelope {
  type: 'server-response'
  rpcId: string
  result: {
    ok: true
    value: {
      ok: true
      value: { entries: Array<{ moduleName: string; enabled: boolean }> }
    }
  }
}

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const hostRowIds = [
  'code-runtime',
  'storage',
  'storage-json',
  'storage-domain',
  'message-feedback',
  'workspace',
  'session-projection-cache',
  'session-reference',
  'file-reference-local',
  'session-stats',
  'directory-picker',
  'plugin-inventory',
  'knowledge-wiki',
  'workbench-remote',
  'api-gateway',
  'webserver',
  'host-connection',
  'agent-presets',
  'session-remote-operations',
  'native-events',
] as const

let context: Context | undefined
let fixtureRoot: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (fixtureRoot !== undefined) rmSync(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = undefined
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function bundlePatches(): PatchOptions[] {
  const parsed = yaml.load(
    readFileSync(resolve(packageRoot, 'cordis.patch.yml'), 'utf8'),
    { schema: entryListSchema },
  )
  if (!Array.isArray(parsed)) throw new TypeError('native API bundle patch must be a patch list')
  return parsed as PatchOptions[]
}

describe('native API bundle', () => {
  it('accepts only an optional 0...65535 listener port', () => {
    expect(NativeApiStartup.parseNativeApiPort(undefined)).toBeUndefined()
    expect(NativeApiStartup.parseNativeApiPort('0')).toBe(0)
    expect(NativeApiStartup.parseNativeApiPort('65535')).toBe(65_535)
    expect(() => NativeApiStartup.parseNativeApiPort('-1')).toThrow(/must be a number/)
    expect(() => NativeApiStartup.parseNativeApiPort('65536')).toThrow(/between 0 and 65535/)
    expect(() => NativeApiStartup.parseNativeApiPort('999999999999999999999')).toThrow(/between 0 and 65535/)
  })

  it('contains only direct native Host owners and no browser or legacy API dependency', () => {
    const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const rows = bundlePatches().flatMap(layer => layer.insert ?? [])
    expect(rows.map(row => row.id)).toEqual([
      ...hostRowIds.slice(0, 15),
      'native-api-startup',
      'webserver',
      'native-api-runtime',
      ...hostRowIds.slice(16),
    ])
    expect(manifest.dependencies).toMatchObject({
      '@deepseek-ai/dsh-host-native-events': 'workspace:^',
      '@deepseek-ai/dsh-host-session-remote-operations': 'workspace:^',
      '@deepseek-ai/dsh-host-workbench': 'workspace:^',
    })
    expect(manifest.dependencies).not.toHaveProperty('@deepseek-ai/dsh-host-apiproxy')
    const names = rows.map(row => row.name)
    expect(names.filter(name => name?.startsWith('@deepseek-ai/dsh-client-'))).toEqual([])
    for (const forbidden of [
      '@deepseek-ai/dsh-web-app',
      '@deepseek-ai/dsh-web-frontend',
      '@deepseek-ai/dsh-host-frontend-static',
      '@deepseek-ai/dsh-client-modules',
      '@deepseek-ai/dsh-cordis-client-runner',
    ]) {
      expect(manifest.dependencies).not.toHaveProperty(forbidden)
      expect(names).not.toContain(forbidden)
    }
    expect(names.some(name => name?.startsWith('@deepseek-ai/dsh-client-ui-'))).toBe(false)
  })

  it('keeps public WebFetch providers on the Host but leaves tool-web to Agent presets', () => {
    const webToolPatch = bundlePatches().find(patch => patch.id === 'tool-web')
    expect(webToolPatch).toMatchObject({
      disabled: true,
      config: { fetch: true, searchTimeoutMs: 60_000 },
    })
  })

  it('loads Service Definition descriptors for provider-backed Native Remotes', () => {
    const loader = bundlePatches().find(patch => patch.id === 'typert-loader')
    expect(loader?.config).toEqual({
      packages: [
        '@deepseek-ai/dsh-credentials',
        '@deepseek-ai/dsh-file-reference',
        '@deepseek-ai/dsh-settings',
      ],
    })
  })

  it('ships Schedule and Team only through standard/code Agent preset scopes', () => {
    const preset = (id: 'standard' | 'minimal' | 'code') => readFileSync(
      resolve(packageRoot, `../../boot/profile-runner/config/agent-presets/${id}/agent.cordis.yml`),
      'utf8',
    )
    for (const id of ['standard', 'code'] as const) {
      const source = preset(id)
      expect(source).toContain("- id: schedule\n  name: '@deepseek-ai/dsh-schedule'")
      expect(source).toContain('- id: agent-teams\n  name: cordis:group\n  group: true\n  isolate:\n    agentTeams: true')
      expect(source).toContain("- id: team-tools\n      name: '@deepseek-ai/dsh-tool-agent-team'")
      expect(source).toContain("- id: tool-web\n  name: '@deepseek-ai/dsh-tool-web'")
    }
    const minimal = preset('minimal')
    expect(minimal).not.toContain('@deepseek-ai/dsh-schedule')
    expect(minimal).not.toContain('@deepseek-ai/dsh-agent-team')
    expect(minimal).not.toContain('@deepseek-ai/dsh-tool-agent-team')
    expect(minimal).not.toContain('@deepseek-ai/dsh-tool-web')
    const manifest = JSON.parse(readFileSync(resolve(packageRoot, '../../boot/profile-runner/package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(manifest.dependencies).toMatchObject({
      '@deepseek-ai/dsh-schedule': 'workspace:^',
      '@deepseek-ai/dsh-agent-team': 'workspace:^',
      '@deepseek-ai/dsh-tool-agent-team': 'workspace:^',
    })
  })

  it('boots --port 0 through the real Loader, prints native readiness, and serves no frontend route', { timeout: 60_000 }, async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'dsh-native-api-loader-'))
    const configPath = join(fixtureRoot, 'cordis.yml')
    writeFileSync(configPath, '[]\n')
    vi.stubEnv('DSH_API_TOKEN', 'native-api-loader-token')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    context = new Context()
    context.baseUrl = pathToFileURL(fixtureRoot).href + '/'
    await context.plugin(TypertRegistry)
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    provideCmdline(context, { args: ['--port', '0'], exit: () => {} })
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-native-api-app/startup', NativeApiStartup],
      ['@deepseek-ai/dsh-host-webserver', WebServer],
      ['@deepseek-ai/dsh-native-api-app', NativeApiApp],
      ['@deepseek-ai/dsh-host-connection', HostConnection],
      ['@deepseek-ai/dsh-api-gateway', ApiGateway],
      ['@deepseek-ai/dsh-host-plugin-inventory', PluginInventory],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>

    const retained = new Set([
      'native-api-startup',
      'webserver',
      'native-api-runtime',
      'host-connection',
      'plugin-inventory',
      'api-gateway',
    ])
    const patches = bundlePatches()
    for (const id of hostRowIds) {
      if (!retained.has(id)) patches.push({ id, disabled: true })
    }
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href, patches },
    })
    await context.loader.await()
    await Promise.resolve()

    // Keep the strict carrier owners intact. The narrow empty-root fixture
    // registers only the generated descriptor that the complete profile's
    // Typert Loader supplies; there is deliberately no legacy fallback.
    const pluginInventoryDescriptor: InvocationDescriptor = {
      id: '@fixture/native-api#pluginInventory/list',
      service: 'pluginInventory',
      namespace: 'pluginInventory',
      method: 'list',
      invocation: { kind: 'direct' },
      parameters: [],
      result: {
        mode: 'strict',
        typeSymbol: '@deepseek-ai/dsh-host-plugin-inventory#PluginInventorySnapshot',
        schema: { parse: value => value },
      },
    }
    context.typert.register({
      package: '@fixture/native-api',
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: [pluginInventoryDescriptor],
    })
    await Promise.resolve()

    const port = context.webServer.port
    expect(port).toBeGreaterThan(0)
    expect(log).toHaveBeenCalledWith(`dsh native-api: http://127.0.0.1:${String(port)}`)
    const root = await fetch(`http://127.0.0.1:${String(port)}/`)
    expect(root.status).toBe(200)
    expect(await root.json()).toEqual({ service: 'Planet API', status: 'running' })
    expect(await fetch(`http://127.0.0.1:${String(port)}/index.html`).then(response => response.status)).toBe(404)
    expect(await fetch(`http://127.0.0.1:${String(port)}/plugins/example/client.js`).then(response => response.status)).toBe(404)
    expect(await fetch(`http://127.0.0.1:${String(port)}/api/host.describe`).then(response => response.status)).toBe(401)
    const request = async (method: string, payload: unknown, token: string | null = 'native-api-loader-token') => fetch(
      `http://127.0.0.1:${String(port)}/api/${method}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: `native-api-loader-${method.replaceAll('/', '-')}`,
          method,
          payload,
        }),
      },
    )
    const inventory = await request('pluginInventory/list', { args: {} })
    expect(inventory.status).toBe(200)
    const inventoryEnvelope = await inventory.json() as PluginInventoryEnvelope
    expect(inventoryEnvelope).toMatchObject({
      type: 'server-response',
      rpcId: 'native-api-loader-pluginInventory-list',
      result: {
        ok: true,
        value: {
          ok: true,
        },
      },
    })
    expect(inventoryEnvelope.result.value.value.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        moduleName: '@deepseek-ai/dsh-host-plugin-inventory',
        enabled: true,
      }),
    ]))
    expect((await request('host.describe', {})).status).toBe(404)
    expect((await request('unknown.route', {})).status).toBe(404)
    expect((await request('pluginInventory/list', { args: {} }, null)).status).toBe(401)
    const activeNames = [...context.loader.entries()]
      .filter(entry => entry.fiber !== undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(activeNames).not.toContain('@deepseek-ai/dsh-web-app')
    expect(activeNames).not.toContain('@deepseek-ai/dsh-host-frontend-static')
    expect(activeNames).not.toContain('@deepseek-ai/dsh-client-modules')
    expect(activeNames.some(name => name?.startsWith('@deepseek-ai/dsh-client-'))).toBe(false)
    expect(activeNames).not.toContain('@deepseek-ai/dsh-tool-web')
    expect(activeNames).not.toContain('@deepseek-ai/dsh-host-apiproxy')
    expect(activeNames).toContain('@deepseek-ai/dsh-host-plugin-inventory')
    expect(activeNames).toContain('@deepseek-ai/dsh-api-gateway')
  })
})

describe('native API startup and readiness edges', () => {
  const startupValues = (ctx: Context): NativeApiStartup.NativeApiStartupValues | undefined =>
    (ctx as unknown as { get(key: string): unknown })
      .get(NativeApiStartup.NATIVE_API_STARTUP_SERVICE) as NativeApiStartup.NativeApiStartupValues | undefined

  it('announces only after an available Loader settles successfully', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const server = { port: 4312 }
    const settled = Promise.withResolvers<undefined>()
    const ctx = {
      get(key: string) {
        if (key === 'webServer') return server
        if (key === 'loader') return { await: () => settled.promise }
        return undefined
      },
    } as unknown as Context

    NativeApiApp.apply(ctx)
    expect(log).not.toHaveBeenCalled()
    settled.resolve(undefined)
    await settled.promise
    await Promise.resolve()
    expect(log).toHaveBeenCalledWith('dsh native-api: http://127.0.0.1:4312')

    log.mockClear()
    const rejected = Promise.reject(new Error('loader failed'))
    NativeApiApp.apply({
      get(key: string) {
        if (key === 'webServer') return server
        if (key === 'loader') return { await: () => rejected }
        return undefined
      },
    } as unknown as Context)
    await rejected.catch(() => undefined)
    await Promise.resolve()
    expect(log).not.toHaveBeenCalled()
  })

  it('handles an absent Loader or WebServer without publishing false readiness', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    NativeApiApp.apply({
      get: (key: string) => key === 'webServer' ? { port: 0 } : undefined,
    } as unknown as Context)
    expect(log).toHaveBeenCalledWith('dsh native-api: http://127.0.0.1:0')

    log.mockClear()
    NativeApiApp.apply({ get: () => undefined } as unknown as Context)
    expect(log).not.toHaveBeenCalled()
  })

  it('publishes immutable default and explicit port startup values', async () => {
    const defaultCtx = new Context()
    provideCmdline(defaultCtx, { args: [], exit: () => {} })
    NativeApiStartup.apply(defaultCtx)
    const defaults = startupValues(defaultCtx)
    expect(defaults).toEqual({})
    expect(Object.isFrozen(defaults)).toBe(true)
    await defaultCtx.fiber.dispose()

    const explicitCtx = new Context()
    provideCmdline(explicitCtx, { args: ['--port', '0'], exit: () => {} })
    NativeApiStartup.apply(explicitCtx)
    const explicit = startupValues(explicitCtx)
    expect(explicit).toEqual({ port: 0 })
    expect(Object.isFrozen(explicit)).toBe(true)
    await explicitCtx.fiber.dispose()
  })

  it('reports invalid port errors from both Error and non-Error failures', async () => {
    const exits: number[] = []
    const invalid = new Context()
    provideCmdline(invalid, { args: ['--port', '-1'], exit: (code) => { exits.push(code) } })
    NativeApiStartup.apply(invalid)
    expect(exits).toEqual([1])
    expect(startupValues(invalid)).toBeUndefined()
    await invalid.fiber.dispose()

    const OriginalNumber = Number
    const throwingNumber = Object.assign(
      () => { throw Object.freeze({ reason: 'non-error port failure' }) },
      { isSafeInteger: OriginalNumber.isSafeInteger },
    )
    vi.stubGlobal('Number', throwingNumber)
    const nonError = new Context()
    provideCmdline(nonError, { args: ['--port', '1'], exit: (code) => { exits.push(code) } })
    NativeApiStartup.apply(nonError)
    expect(exits).toEqual([1, 1])
    expect(startupValues(nonError)).toBeUndefined()
    await nonError.fiber.dispose()
    vi.unstubAllGlobals()
  })
})
