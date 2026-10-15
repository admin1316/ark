import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { Profile } from '@deepseek-ai/dsh-app-boot'

// The fixture home patch path, built with the platform separator via join().
const homePatch = join('/home/dsh', 'cordis.patch.yml')

const testDoubles = vi.hoisted(() => ({
  writeFileSync: vi.fn<typeof import('node:fs').writeFileSync>(),
  resolveDshHome: vi.fn<typeof import('@deepseek-ai/dsh-home-paths').resolveDshHome>(),
  healProfilesModuleFallback: vi.fn<typeof import('@deepseek-ai/dsh-app-boot').healProfilesModuleFallback>(),
  loadProfile: vi.fn<typeof import('@deepseek-ai/dsh-app-boot').loadProfile>(),
  loadOptionalPatches: vi.fn<typeof import('@deepseek-ai/dsh-app-boot').loadOptionalPatches>(),
  loadOverlayPatches: vi.fn<typeof import('@deepseek-ai/dsh-app-boot').loadOverlayPatches>(),
  composeEntries: vi.fn<typeof import('@deepseek-ai/dsh-app-boot').composeEntries>(),
  boot: vi.fn<typeof import('@deepseek-ai/dsh-app-boot').boot>(),
  watchUserPatches: vi.fn<typeof import('@deepseek-ai/dsh-app-boot').watchUserPatches>(),
  installFailLoud: vi.fn<typeof import('@deepseek-ai/dsh-app-boot').installFailLoud>(),
  isSnapshotServedDirectory: vi.fn<typeof import('@deepseek-ai/dsh-app-boot').isSnapshotServedDirectory>(),
  provideCmdline: vi.fn<typeof import('@deepseek-ai/dsh-cmdline').provideCmdline>(),
  createProcessShutdown: vi.fn<typeof import('../src/process-shutdown.ts').createProcessShutdown>(),
  onSignal: vi.fn<(signal: 'SIGTERM' | 'SIGINT', handler: () => void) => void>(),
  parentIPC: undefined as undefined | {
    connected: boolean | undefined
    channelPresent: boolean
    unref: () => void
    listeners: Set<() => void>
  },
}))

vi.mock('node:process', async (importOriginal) => {
  const actual = await importOriginal<{ default: NodeJS.Process }>()
  return {
    ...actual,
    default: new Proxy(actual.default, {
      get(target, key) {
        const ipc = testDoubles.parentIPC
        if (ipc !== undefined && key === 'connected') return ipc.connected
        if (ipc !== undefined && key === 'channel') return ipc.channelPresent ? { unref: ipc.unref } : undefined
        if (ipc !== undefined && (key === 'on' || key === 'off')) {
          return (event: string, listener: () => void) => {
            if (event === 'disconnect') {
              if (key === 'on') ipc.listeners.add(listener)
              else ipc.listeners.delete(listener)
              return target
            }
            return target[key](event, listener)
          }
        }
        return Reflect.get(target, key) as unknown
      },
    }),
  }
})

vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  writeFileSync: testDoubles.writeFileSync,
}))
vi.mock('@deepseek-ai/dsh-home-paths', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-home-paths')>(),
  resolveDshHome: testDoubles.resolveDshHome,
}))
vi.mock('@deepseek-ai/dsh-app-boot', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-app-boot')>(),
  healProfilesModuleFallback: testDoubles.healProfilesModuleFallback,
  loadProfile: testDoubles.loadProfile,
  loadOptionalPatches: testDoubles.loadOptionalPatches,
  loadOverlayPatches: testDoubles.loadOverlayPatches,
  composeEntries: testDoubles.composeEntries,
  boot: testDoubles.boot,
  watchUserPatches: testDoubles.watchUserPatches,
  installFailLoud: testDoubles.installFailLoud,
  isSnapshotServedDirectory: testDoubles.isSnapshotServedDirectory,
}))
vi.mock('@deepseek-ai/dsh-cmdline', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-cmdline')>(),
  provideCmdline: testDoubles.provideCmdline,
}))
vi.mock('../src/process-shutdown.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/process-shutdown.ts')>(),
  createProcessShutdown: testDoubles.createProcessShutdown,
}))

import {
  homePatchPath,
  prepareProfile,
  runProfile,
  SHIPPED_PRESET_ROOT,
  type RunProfileOptions,
} from '../src/index.ts'

type ProfileRunnerInternals = typeof testDoubles
type Shutdown = ReturnType<ProfileRunnerInternals['createProcessShutdown']>
type WatchUserPatches = typeof import('@deepseek-ai/dsh-app-boot').watchUserPatches
type Environment = RunProfileOptions['environment']

beforeEach(() => {
  vi.resetAllMocks()
  testDoubles.parentIPC = undefined
  vi.spyOn(process, 'on').mockImplementation(((signal, listener) => {
    if (signal === 'SIGTERM' || signal === 'SIGINT') {
      testDoubles.onSignal(signal, listener as () => void)
    }
    return process
  }) as typeof process.on)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  testDoubles.parentIPC = undefined
})

function profile(overrides: Record<string, unknown> = {}): Profile {
  return {
    dir: '/profiles/sdk',
    patchPath: '/profiles/sdk/cordis.patch.yml',
    patches: [{ id: 'profile-patch' }],
    layers: [{ patches: [{ id: 'bundle-patch' }] }],
    ...overrides,
  } as Profile
}

interface LifecycleFixture {
  ctx: Context
  host: Context
  hostProvide: ReturnType<typeof vi.fn>
  loader: { create: ReturnType<typeof vi.fn> }
  loaderCreate: ReturnType<typeof vi.fn>
  ctxDispose: ReturnType<typeof vi.fn<() => Promise<void>>>
  hostDispose: ReturnType<typeof vi.fn<() => Promise<void>>>
}

function lifecycleFixture(services: Record<string, unknown> = {}, state = FiberState.ACTIVE): LifecycleFixture {
  const loaderCreate = vi.fn(async () => undefined)
  const ctxDispose = vi.fn<() => Promise<void>>(async () => {})
  const hostDispose = vi.fn<() => Promise<void>>(async () => {})
  const loader = { create: loaderCreate }
  const ctx = {
    fiber: { state, dispose: ctxDispose },
    loader,
    get: (service: string) => service === 'loader' ? loader : services[service],
  } as unknown as Context
  const hostProvide = vi.fn()
  const host = {
    fiber: { dispose: hostDispose },
    provide: hostProvide,
  } as unknown as Context
  return { ctx, host, hostProvide, loader, loaderCreate, ctxDispose, hostDispose }
}

function installProfileDefaults(currentProfile: Profile) {
  const heal = testDoubles.healProfilesModuleFallback
  const load = testDoubles.loadProfile.mockReturnValue(currentProfile)
  const write = testDoubles.writeFileSync
  const overlay = testDoubles.loadOverlayPatches.mockReturnValue([{ id: 'caller-patch' }])
  const compose = testDoubles.composeEntries.mockReturnValue([
    { id: 'agent-presets', name: 'agent-presets', config: { existing: true } },
    { id: 'session-telemetry-otel', name: 'telemetry' },
  ] as EntryOptions[])
  const provideCmdline = testDoubles.provideCmdline
  const failLoud = testDoubles.installFailLoud
  testDoubles.resolveDshHome.mockReturnValue('/home/dsh')
  return { heal, load, write, overlay, compose, provideCmdline, failLoud }
}

function installRunStubs(
  fixture: LifecycleFixture,
  watchImplementation: WatchUserPatches = async () => async () => {},
) {
  const shutdown: Shutdown = { shutdown: async () => undefined, interrupt: () => {} }
  const createProcessShutdown = testDoubles.createProcessShutdown.mockReturnValue(shutdown)
  const onSignal = testDoubles.onSignal
  const boot = testDoubles.boot.mockImplementation(async (_name, _root, _patches, beforeMount) => {
    await beforeMount?.(fixture.host)
    return fixture.ctx
  })
  const watchUserPatches = testDoubles.watchUserPatches.mockImplementation(watchImplementation)
  return { createProcessShutdown, onSignal, boot, watchUserPatches }
}

describe('profile runner lifecycle', () => {
  it('resolves and prepares profile roots without retaining caller defaults', () => {
    const currentProfile = profile()
    const defaults = installProfileDefaults(currentProfile)

    expect(homePatchPath()).toBe(homePatch)
    expect(prepareProfile('sdk', '/app/package.json')).toBe(currentProfile)
    expect(prepareProfile('managed', '/app/package.json', false)).toBe(currentProfile)

    expect(defaults.heal).toHaveBeenCalledTimes(2)
    expect(defaults.load).toHaveBeenNthCalledWith(
      1, 'dsh', 'sdk', '/app/package.json', undefined, { userLayer: true },
    )
    expect(defaults.load).toHaveBeenNthCalledWith(
      2, 'dsh', 'managed', '/app/package.json', undefined, { userLayer: false },
    )
    expect(defaults.write).toHaveBeenCalledWith(
      join('/profiles/sdk', 'cordis.yml'),
      expect.stringContaining('dsh profile root'),
    )
  })

  it('hands the installed bare-module base to boot only for a snapshot-served installation', async () => {
    const currentProfile = profile({ layers: [] })
    installProfileDefaults(currentProfile)
    const fixture = lifecycleFixture({ hmr: {}, timer: {} })
    installRunStubs(fixture)

    const ordinaryAnchor = join('app', 'package.json')
    testDoubles.isSnapshotServedDirectory.mockReturnValue(false)
    await runProfile({
      installAnchor: ordinaryAnchor,
      environment: {} as Environment,
      profile: 'sdk',
      patchFiles: [],
      args: [],
    })
    expect(testDoubles.isSnapshotServedDirectory).toHaveBeenLastCalledWith(dirname(ordinaryAnchor))
    expect(testDoubles.boot.mock.calls.at(-1)?.[4]).toBeUndefined()

    const packagedAnchor = join('snapshot', 'project', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    testDoubles.isSnapshotServedDirectory.mockReturnValue(true)
    await runProfile({
      installAnchor: packagedAnchor,
      environment: {} as Environment,
      profile: 'sdk',
      patchFiles: [],
      args: [],
    })
    expect(testDoubles.isSnapshotServedDirectory).toHaveBeenLastCalledWith(dirname(packagedAnchor))
    expect(testDoubles.boot.mock.calls.at(-1)?.[4]).toEqual({
      url: pathToFileURL(packagedAnchor).href,
      order: 'configuration-first',
    })
  })

  it('freezes a startup-only profile: no live watcher and no reload rows', async () => {
    const currentProfile = profile({ layers: [], patchReload: 'startup' })
    installProfileDefaults(currentProfile)
    const fixture = lifecycleFixture()
    const stubs = installRunStubs(fixture)

    await runProfile({
      installAnchor: '/app/package.json',
      environment: {} as Environment,
      profile: 'sdk-minimal',
      patchFiles: [],
      args: [],
    })

    expect(stubs.watchUserPatches).not.toHaveBeenCalled()
    expect(fixture.loaderCreate).not.toHaveBeenCalled()
  })

  it('composes ordered layers, watches both user patch files, and routes all launch facts through the booted tree', async () => {
    const currentProfile = profile()
    installProfileDefaults(currentProfile)
    vi.stubEnv('DSH_TELEMETRY_DISABLED', '0')
    const fixture = lifecycleFixture()
    const signals = new Map<string, () => void>()
    const liveCompositions: unknown[] = []
    let disposeTree: (() => Promise<void>) | undefined
    let failLoud: (() => Promise<void>) | undefined
    let cmdlineHost: { exit(code: number): void } | undefined
    const shutdownCall = vi.fn<Shutdown['shutdown']>(async () => undefined)
    const interrupt = vi.fn<Shutdown['interrupt']>()
    const shutdown: Shutdown = {
      shutdown: shutdownCall,
      interrupt,
    }

    testDoubles.loadOptionalPatches.mockImplementation((_name, path) =>
      path === homePatch
        ? [{ id: 'home-patch' }]
        : [{ id: 'profile-user-patch' }])
    testDoubles.createProcessShutdown.mockImplementation((dispose) => {
      disposeTree = dispose
      return shutdown
    })
    testDoubles.onSignal.mockImplementation((signal, handler) => {
      signals.set(signal, () => { handler() })
    })
    testDoubles.installFailLoud.mockImplementation((_name, _process, handler) => {
      failLoud = async () => { await handler?.() }
      return () => {}
    })
    const boot = testDoubles.boot.mockImplementation(async (_name, _root, _patches, beforeMount) => {
      await beforeMount?.(fixture.host)
      return fixture.ctx
    })
    const watchUserPatches = testDoubles.watchUserPatches.mockImplementation(async (_ctx, options) => {
      if (options.compose === undefined) throw new Error('expected a live patch composer')
      liveCompositions.push(options.compose([]))
      return async () => {}
    })
    const provideCmdline = testDoubles.provideCmdline.mockImplementation((_ctx, host) => {
      cmdlineHost = host
    })

    const result = await runProfile({
      installAnchor: '/app/package.json',
      environment: { source: 'launcher' } as unknown as Environment,
      profile: 'sdk',
      patchFiles: ['caller.yml'],
      args: ['--serve', 'stdio'],
      additionalSystemPresetRoots: ['/app/presets', '/app/presets'],
    })

    expect(result.ctx).toBe(fixture.ctx)
    expect(result.shutdown).toBe(shutdown)
    const firstBoot = boot.mock.calls[0]
    expect(firstBoot?.[0]).toBe('dsh')
    expect(firstBoot?.[1]).toBe(join('/profiles/sdk', 'cordis.yml'))
    expect(firstBoot?.[2]).toEqual(expect.arrayContaining([
      { id: 'bundle-patch' },
      { id: 'profile-patch' },
      { id: 'home-patch' },
      { id: 'caller-patch' },
      expect.objectContaining({ id: 'agent-presets' }),
      { id: 'session-telemetry-otel', disabled: true },
    ]))
    expect(firstBoot?.[3]).toBeTypeOf('function')
    expect(fixture.hostProvide).toHaveBeenCalledWith('launchEnvironment', { source: 'launcher' })
    const providedCmdline = provideCmdline.mock.calls[0]
    expect(providedCmdline?.[0]).toBe(fixture.host)
    expect(providedCmdline?.[1]?.args).toEqual(['--serve', 'stdio'])
    expect(providedCmdline?.[1]?.exit).toBeTypeOf('function')
    expect(fixture.loaderCreate).toHaveBeenCalledWith({ name: '@deepseek-ai/cordis-plugin-timer' })
    expect(fixture.loaderCreate).toHaveBeenCalledWith({ name: '@deepseek-ai/cordis-plugin-hmr', config: { root: [] } })
    expect(watchUserPatches).toHaveBeenCalledTimes(2)
    expect(liveCompositions).toHaveLength(2)

    expect(cmdlineHost).toBeDefined()
    cmdlineHost?.exit(7)
    signals.get('SIGTERM')?.()
    signals.get('SIGINT')?.()
    await disposeTree?.()
    await failLoud?.()

    expect(shutdownCall).toHaveBeenNthCalledWith(1, 7)
    expect(shutdownCall).toHaveBeenNthCalledWith(2, 1)
    expect(interrupt).toHaveBeenNthCalledWith(1, 0)
    expect(interrupt).toHaveBeenNthCalledWith(2, 130)
    expect(fixture.ctxDispose).toHaveBeenCalledOnce()
  })

  it('skips live watching when the caller requests immutable managed profiles', async () => {
    const currentProfile = profile({ layers: [] })
    installProfileDefaults(currentProfile)
    const fixture = lifecycleFixture({ hmr: {}, timer: {} })
    testDoubles.loadOptionalPatches.mockReturnValue(undefined)
    const stubs = installRunStubs(fixture)

    await runProfile({
      installAnchor: '/app/package.json',
      environment: {} as Environment,
      profile: 'sdk',
      patchFiles: [],
      args: [],
      watchLiveConfig: false,
    })

    expect(fixture.loaderCreate).not.toHaveBeenCalled()
    expect(stubs.watchUserPatches).not.toHaveBeenCalled()
  })

  it('loads an application-managed profile layer without either user patch layer', async () => {
    const currentProfile = profile()
    installProfileDefaults(currentProfile)
    const fixture = lifecycleFixture({ hmr: {}, timer: {} })
    const managedPatch = { id: 'managed-profile-patch' }
    testDoubles.loadOverlayPatches.mockImplementation((_name, path) =>
      path === currentProfile.patchPath ? [managedPatch] : [{ id: 'unexpected-overlay' }])
    testDoubles.loadOptionalPatches.mockImplementation((_name, path) =>
      path === homePatch ? [{ id: 'home-patch' }] : [{ id: 'profile-user-patch' }])
    const stubs = installRunStubs(fixture)

    await runProfile({
      installAnchor: '/app/package.json',
      environment: {} as Environment,
      profile: 'managed',
      patchFiles: [],
      args: [],
      watchLiveConfig: false,
      profilePatchMode: 'managed',
      homePatchMode: 'none',
    })

    expect(testDoubles.loadProfile).toHaveBeenCalledWith(
      'dsh', 'managed', '/app/package.json', undefined, { userLayer: false },
    )
    expect(testDoubles.loadOverlayPatches).toHaveBeenCalledWith('dsh', currentProfile.patchPath)
    expect(testDoubles.loadOptionalPatches).not.toHaveBeenCalled()
    expect(stubs.boot.mock.calls[0]?.[2]).toEqual(expect.arrayContaining([
      { id: 'bundle-patch' },
      managedPatch,
    ]))
    expect(stubs.boot.mock.calls[0]?.[2]).not.toEqual(expect.arrayContaining([
      { id: 'profile-patch' },
      { id: 'home-patch' },
    ]))
    expect(stubs.watchUserPatches).not.toHaveBeenCalled()
  })

  it.each(['managed profile', 'disabled home'] as const)('recomposes only the enabled user layer with %s', async (mode) => {
    const currentProfile = profile()
    installProfileDefaults(currentProfile)
    vi.stubEnv('DSH_TELEMETRY_DISABLED', '')
    const fixture = lifecycleFixture({ hmr: {}, timer: {} })
    const managedProfile = mode === 'managed profile'
    const managedPatch = { id: 'managed-profile-patch' }
    testDoubles.loadOverlayPatches.mockImplementation((_name, path) =>
      path === currentProfile.patchPath ? [managedPatch] : [{ id: 'caller-patch' }])
    testDoubles.loadOptionalPatches.mockImplementation((_name, path) =>
      path === currentProfile.patchPath ? [{ id: 'profile-user-patch' }] : [{ id: 'home-user-patch' }])
    const compositions: unknown[] = []
    const stubs = installRunStubs(fixture, async (_ctx, options) => {
      if (options.compose === undefined) throw new Error('missing live composer')
      compositions.push(options.compose([]))
      return async () => {}
    })

    await runProfile({
      installAnchor: '/app/package.json',
      environment: {} as Environment,
      profile: 'sdk',
      patchFiles: ['caller.yml'],
      args: [],
      profilePatchMode: managedProfile ? 'managed' : 'user',
      homePatchMode: managedProfile ? 'user' : 'none',
    })

    expect(stubs.watchUserPatches).toHaveBeenCalledOnce()
    expect(stubs.watchUserPatches.mock.calls[0]?.[1].filename)
      .toBe(managedProfile ? homePatch : currentProfile.patchPath)
    expect(compositions).toEqual([[
      { id: 'bundle-patch' },
      managedProfile ? managedPatch : { id: 'profile-user-patch' },
      ...(managedProfile ? [{ id: 'home-user-patch' }] : []),
      { id: 'caller-patch' },
      { id: 'agent-presets', config: { existing: true, roots: [{ path: SHIPPED_PRESET_ROOT, trust: 'system' }] } },
    ]])
    expect(testDoubles.loadOptionalPatches.mock.calls.every(([, path]) =>
      path === (managedProfile ? homePatch : currentProfile.patchPath))).toBe(true)
  })

  it('keeps watcher setup live when HMR already exists and skips a duplicate timer when only HMR is absent', async () => {
    const currentProfile = profile()
    installProfileDefaults(currentProfile)
    const existingHmr = lifecycleFixture({ hmr: {}, timer: {} })
    installRunStubs(existingHmr)
    await runProfile({
      installAnchor: '/app/package.json',
      environment: {} as Environment,
      profile: 'sdk',
      patchFiles: [],
      args: [],
    })
    expect(existingHmr.loaderCreate).not.toHaveBeenCalled()

    const timerOnly = lifecycleFixture({ timer: {} })
    testDoubles.boot.mockImplementation(async (_name, _root, _patches, beforeMount) => {
      await beforeMount?.(timerOnly.host)
      return timerOnly.ctx
    })
    await runProfile({
      installAnchor: '/app/package.json',
      environment: {} as Environment,
      profile: 'sdk',
      patchFiles: [],
      args: [],
    })
    expect(timerOnly.loaderCreate).toHaveBeenCalledTimes(1)
    expect(timerOnly.loaderCreate).toHaveBeenCalledWith({ name: '@deepseek-ai/cordis-plugin-hmr', config: { root: [] } })
  })

  it('covers untyped entry rows, an agent preset row without config, and missing live patch files', async () => {
    const currentProfile = profile()
    installProfileDefaults(currentProfile)
    const fixture = lifecycleFixture()
    const agentPresetWithoutConfig: EntryOptions[] = [
      { id: 99 } as unknown as EntryOptions,
      { id: 'agent-presets', name: 'agent-presets' },
    ]
    testDoubles.composeEntries.mockReturnValue(agentPresetWithoutConfig)
    testDoubles.loadOptionalPatches.mockReturnValue(undefined)
    const stubs = installRunStubs(fixture, async (_ctx, options) => {
      if (options.compose === undefined) throw new Error('expected a live patch composer')
      expect(options.compose([])).toEqual(expect.arrayContaining([
        { id: 'bundle-patch' },
        expect.objectContaining({ id: 'agent-presets' }),
      ]))
      return async () => {}
    })

    await runProfile({
      installAnchor: '/app/package.json',
      environment: {} as Environment,
      profile: 'sdk',
      patchFiles: [],
      args: [],
    })
    const firstPatches = stubs.boot.mock.calls[0]?.[2] ?? []
    expect(firstPatches.some(patch => patch.id === 'agent-presets')).toBe(true)

    testDoubles.composeEntries.mockReturnValue([{ id: 99 } as unknown as EntryOptions])
    testDoubles.watchUserPatches.mockImplementation(async (_ctx, options) => {
      if (options.compose === undefined) throw new Error('expected a live patch composer')
      expect(options.compose([])).toEqual([{ id: 'bundle-patch' }])
      return async () => {}
    })
    await runProfile({
      installAnchor: '/app/package.json',
      environment: {} as Environment,
      profile: 'sdk',
      patchFiles: [],
      args: [],
    })
    const secondPatches = stubs.boot.mock.calls[1]?.[2] ?? []
    expect(secondPatches.filter(patch => patch.id === 'agent-presets')).toEqual([])
  })

  it.each(['signal-aborted', 'disposed-tree', 'missing-loader'])('suppresses watch setup failures only for an exiting %s tree', async (mode) => {
    const currentProfile = profile()
    installProfileDefaults(currentProfile)
    const fixture = lifecycleFixture()
    let signal: (() => void) | undefined
    let loaderReads = 0
    const ctx = mode !== 'missing-loader' ? fixture.ctx : ({
      fiber: fixture.ctx.fiber,
      loader: fixture.loader,
      get: (service: string) => service === 'loader' && ++loaderReads === 1 ? fixture.loader : undefined,
    } as unknown as Context)
    testDoubles.loadOptionalPatches.mockReturnValue([])
    const stubs = installRunStubs(fixture)
    stubs.onSignal.mockImplementation((_signal, handler) => { signal = () => { handler() } })
    testDoubles.boot.mockImplementation(async (_name, _root, _patches, beforeMount) => {
      await beforeMount?.(fixture.host)
      return ctx
    })
    testDoubles.watchUserPatches.mockImplementation(async () => {
      if (mode === 'signal-aborted') signal?.()
      if (mode === 'disposed-tree') (fixture.ctx.fiber as unknown as { state: FiberState }).state = FiberState.DISPOSED
      throw new Error('watch failed while exiting')
    })

    await expect(runProfile({
      installAnchor: '/app/package.json',
      environment: {} as Environment,
      profile: 'sdk',
      patchFiles: [],
      args: [],
    })).resolves.toMatchObject({ ctx })
  })

  it('rethrows a live watch failure instead of hiding a broken profile reload path', async () => {
    const currentProfile = profile()
    installProfileDefaults(currentProfile)
    const fixture = lifecycleFixture()
    testDoubles.loadOptionalPatches.mockReturnValue([])
    installRunStubs(fixture, async () => { throw new Error('live watch failed') })

    await expect(runProfile({
      installAnchor: '/app/package.json',
      environment: {} as Environment,
      profile: 'sdk',
      patchFiles: [],
      args: [],
    })).rejects.toThrow('live watch failed')
  })
})

function lifecycleGate() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

async function parentLifecycle(connected: boolean | undefined) {
  installProfileDefaults(profile({ layers: [] }))
  const fixture = lifecycleFixture()
  const stubs = installRunStubs(fixture)
  const signals = new Map<string, () => void>()
  stubs.onSignal.mockImplementation((signal, handler) => { signals.set(signal, handler) })
  const ipc = { connected, channelPresent: true, unref: vi.fn(), listeners: new Set<() => void>() }
  testDoubles.parentIPC = ipc
  const actual = await vi.importActual<typeof import('../src/process-shutdown.ts')>('../src/process-shutdown.ts')
  const exit = vi.fn<(code: number) => void>()
  const complete = vi.fn<(code: number) => void>()
  const reportFailure = vi.fn<(error: unknown) => void>()
  stubs.createProcessShutdown.mockImplementation(dispose => actual.createProcessShutdown(
    dispose, exit, complete, actual.PROCESS_SHUTDOWN_TIMEOUT_MS, reportFailure,
  ))
  const options: RunProfileOptions = {
    installAnchor: '/app/package.json', environment: {} as Environment,
    profile: 'managed', patchFiles: [], args: [], watchLiveConfig: false,
    shutdownOnParentDisconnect: true,
  }
  const disconnect = () => {
    ipc.connected = false
    for (const listener of [...ipc.listeners]) listener()
  }
  return { fixture, stubs, ipc, signals, exit, complete, reportFailure, options, disconnect, actual }
}

describe('Native parent IPC lifetime', () => {
  it.each(['ordinary CLI', 'direct Native without IPC'] as const)('leaves %s outside parent ownership', async (mode) => {
    const f = await parentLifecycle(mode === 'ordinary CLI' ? true : undefined)
    const options = { ...f.options }
    if (mode === 'ordinary CLI') delete options.shutdownOnParentDisconnect
    const result = await runProfile(options)
    expect(f.ipc.listeners.size).toBe(0)
    expect(f.ipc.unref).not.toHaveBeenCalled()
    await result.shutdown.shutdown(0)
    expect(f.complete).toHaveBeenCalledExactlyOnceWith(0)
    expect(f.exit).not.toHaveBeenCalled()
  })

  it.each(['present', 'released'] as const)('refuses already-disconnected startup with its IPC channel %s', async (channel) => {
    const f = await parentLifecycle(false)
    f.ipc.channelPresent = channel === 'present'
    await expect(runProfile(f.options)).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.stubs.boot).not.toHaveBeenCalled()
    expect(testDoubles.healProfilesModuleFallback).not.toHaveBeenCalled()
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(0)
    expect(f.ipc.listeners.size).toBe(0)
    expect(f.ipc.unref).toHaveBeenCalledTimes(channel === 'present' ? 1 : 0)
  })

  it.each(['queued', 'delivered'] as const)('refuses pre-mount parent loss with its disconnect event %s', async (event) => {
    const f = await parentLifecycle(true)
    f.stubs.boot.mockImplementation(async (_name, _root, _patches, beforeMount) => {
      if (event === 'queued') f.ipc.connected = false
      else f.disconnect()
      await beforeMount?.(f.fixture.host)
      return f.fixture.ctx
    })
    await expect(runProfile(f.options)).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.fixture.hostProvide).not.toHaveBeenCalled()
    expect(testDoubles.provideCmdline).not.toHaveBeenCalled()
    const owner = f.stubs.createProcessShutdown.mock.results[0]
    if (owner?.type !== 'return') throw new Error('startup did not create its shutdown owner')
    await owner.value.shutdown(0)
    expect(f.fixture.hostDispose).toHaveBeenCalledOnce()
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(0)
  })

  it('disposes the startup root when the parent disconnects while boot is pending', async () => {
    const f = await parentLifecycle(true)
    const entered = lifecycleGate()
    const bootGate = lifecycleGate()
    const disposal = lifecycleGate()
    f.fixture.hostDispose.mockImplementation(() => disposal.promise)
    f.stubs.boot.mockImplementation(async (_name, _root, _patches, beforeMount) => {
      await beforeMount?.(f.fixture.host)
      entered.resolve()
      await bootGate.promise
      return f.fixture.ctx
    })
    const pending = runProfile(f.options)
    // Observe startup until its original promise can be asserted after the owned shutdown.
    void pending.catch(() => {})
    try {
      await entered.promise
      f.disconnect()
      await Promise.resolve()
      expect(f.fixture.hostDispose).toHaveBeenCalledOnce()
      expect(f.exit).not.toHaveBeenCalled()
      expect(f.ipc.listeners.size).toBe(0)
    } finally {
      disposal.resolve()
      bootGate.resolve()
    }
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(0)
    expect(f.stubs.createProcessShutdown).toHaveBeenCalledOnce()
  })

  it('does not count disconnect after SIGTERM as a second interrupt', async () => {
    const f = await parentLifecycle(true)
    const disposal = lifecycleGate()
    f.fixture.ctxDispose.mockImplementation(() => disposal.promise)
    const result = await runProfile(f.options)
    const queuedDisconnect = [...f.ipc.listeners][0]
    try {
      f.signals.get('SIGTERM')?.()
      f.disconnect()
      queuedDisconnect?.()
      await Promise.resolve()
      expect(f.fixture.ctxDispose).toHaveBeenCalledOnce()
      expect(f.exit).not.toHaveBeenCalled()
    } finally {
      disposal.resolve()
      await result.shutdown.shutdown(0)
    }
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(0)
  })

  it('joins appExit disposal before forcing exit after parent loss', async () => {
    const f = await parentLifecycle(true)
    const disposal = lifecycleGate()
    f.fixture.ctxDispose.mockImplementation(() => disposal.promise)
    const result = await runProfile(f.options)
    const queuedDisconnect = [...f.ipc.listeners][0]
    const host = testDoubles.provideCmdline.mock.calls.at(-1)?.[1]
    try {
      expect(host).toBeDefined()
      host?.exit(0)
      expect(f.ipc.listeners.size).toBe(1)
      f.disconnect()
      queuedDisconnect?.()
      await Promise.resolve()
      expect(f.exit).not.toHaveBeenCalled()
      expect(f.complete).not.toHaveBeenCalled()
      expect(f.ipc.listeners.size).toBe(0)
      expect(f.ipc.unref).toHaveBeenCalledOnce()
    } finally {
      disposal.resolve()
      await result.shutdown.shutdown(0)
    }
    expect(f.complete).toHaveBeenCalledExactlyOnceWith(0)
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(0)
    expect(f.fixture.ctxDispose).toHaveBeenCalledOnce()
  })

  it('retains parent ownership after natural disposal while another referenced handle remains', async () => {
    const f = await parentLifecycle(true)
    const result = await runProfile(f.options)
    const remainingHandle = setInterval(() => {}, 1_000)
    try {
      await result.shutdown.shutdown(0)
      expect(f.complete).toHaveBeenCalledExactlyOnceWith(0)
      expect(f.exit).not.toHaveBeenCalled()
      expect(f.ipc.listeners.size).toBe(1)
      f.disconnect()
      await result.shutdown.shutdown(0)
      expect(f.exit).toHaveBeenCalledExactlyOnceWith(0)
      expect(f.fixture.ctxDispose).toHaveBeenCalledOnce()
      expect(f.ipc.listeners.size).toBe(0)
    } finally {
      clearInterval(remainingHandle)
    }
  })

  it('preserves immediate escalation only for a second explicit signal', async () => {
    const f = await parentLifecycle(true)
    const disposal = lifecycleGate()
    f.fixture.ctxDispose.mockImplementation(() => disposal.promise)
    const result = await runProfile(f.options)
    try {
      f.signals.get('SIGTERM')?.()
      await Promise.resolve()
      expect(f.exit).not.toHaveBeenCalled()
      f.signals.get('SIGINT')?.()
      expect(f.exit).toHaveBeenCalledExactlyOnceWith(130)
      expect(f.fixture.ctxDispose).toHaveBeenCalledOnce()
    } finally {
      disposal.resolve()
      await result.shutdown.shutdown(0)
    }
    expect(f.exit).toHaveBeenCalledOnce()
  })

  it.each(['failure', 'timeout'] as const)('preserves a nonzero parent-loss shutdown on disposal %s', async (mode) => {
    vi.useFakeTimers()
    const f = await parentLifecycle(true)
    const disposal = lifecycleGate()
    const failure = new Error('owned root disposal failed')
    f.fixture.ctxDispose.mockImplementation(() => disposal.promise)
    const result = await runProfile(f.options)
    try {
      f.disconnect()
      await Promise.resolve()
      if (mode === 'failure') disposal.reject(failure)
      else await vi.advanceTimersByTimeAsync(f.actual.PROCESS_SHUTDOWN_TIMEOUT_MS)
      if (mode === 'failure') await result.shutdown.shutdown(0)
      expect(f.exit).toHaveBeenCalledExactlyOnceWith(1)
      expect(f.reportFailure).toHaveBeenCalledExactlyOnceWith(mode === 'failure'
        ? failure : expect.objectContaining({ name: 'ProcessShutdownTimeoutError' }))
      expect(f.complete).not.toHaveBeenCalled()
      expect(f.ipc.listeners.size).toBe(0)
    } finally {
      disposal.resolve()
      await result.shutdown.shutdown(0)
    }
    expect(f.fixture.ctxDispose).toHaveBeenCalledOnce()
  })
})
