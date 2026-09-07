import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as WebserverInvariant from '../src/invariant.ts'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'

interface ProbeServer {
  register(route: { kind: 'exact'; path: string; handler: () => void }): () => void
  registerUpgrade(route: { path: string; handler: () => void }): () => void
}

function symmetricProbeServer(): ProbeServer {
  const routes = new Set<string>()
  const upgrades = new Set<string>()
  const reserve = (rows: Set<string>, path: string): (() => void) => {
    if (rows.has(path)) throw new Error(`duplicate ${path}`)
    rows.add(path)
    return () => { rows.delete(path) }
  }
  return {
    register: (route) => {
      route.handler()
      return reserve(routes, route.path)
    },
    registerUpgrade: (route) => {
      route.handler()
      return reserve(upgrades, route.path)
    },
  }
}

function leakingRouteProbeServer(): ProbeServer {
  const routes = new Set<string>()
  return {
    register: (route) => {
      route.handler()
      if (routes.has(route.path)) throw new Error(`duplicate ${route.path}`)
      routes.add(route.path)
      return () => undefined
    },
    registerUpgrade: (route) => {
      route.handler()
      return () => undefined
    },
  }
}

async function mount(server: ProbeServer | undefined): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry, { enabled: true })
  if (server !== undefined) ctx.provide('webServer', server)
  await ctx.plugin(WebserverInvariant)
  return ctx
}

describe('webserver route lifecycle invariant', () => {
  it('does nothing when the composition has no webserver and accepts symmetric route disposers', async () => {
    const absent = await mount(undefined)
    const present = await mount(symmetricProbeServer())
    try {
      expect(() => { absent.emit('internal/plugin', absent.fiber) }).not.toThrow()
      expect(() => { present.emit('internal/plugin', present.fiber) }).not.toThrow()
    } finally {
      await Promise.all([absent.fiber.dispose(), present.fiber.dispose()])
    }
  })

  it('attributes a non-symmetric route disposer to the webserver package', async () => {
    const ctx = await mount(leakingRouteProbeServer())
    try {
      expect(() => { ctx.emit('internal/plugin', ctx.fiber) }).toThrow(expect.objectContaining<Partial<InvariantError>>({
        code: 'INVARIANT',
        packageName: '@deepseek-ai/dsh-host-webserver',
      }))
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
