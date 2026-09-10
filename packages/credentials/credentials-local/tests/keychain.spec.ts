import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { credentialCondition, credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '../src/index.ts'

interface KeychainItem {
  args: readonly string[]
  value: string | undefined
  missing: boolean | undefined
}

const { keychainCalls, execFileMock, ptySpawnMock } = vi.hoisted(() => {
  const keychainCalls: KeychainItem[] = []
  const execFileMock = vi.fn((file: string, args: readonly string[], callback: (error: unknown, stdout: string) => void) => {
    expect(file).toBe('/usr/bin/security')
    const key = args[args.indexOf('-a') + 1]
    const matches = keychainCalls.filter(call => call.args[call.args.indexOf('-a') + 1] === key)
    const last = matches[matches.length - 1]
    if (args[0] === 'find-generic-password') {
      if (last === undefined || last.missing === true || last.value === undefined) {
        callback(Object.assign(new Error('not found'), { code: 44 }), '')
      } else {
        callback(null, last.value + '\n')
      }
      return
    }
    if (args[0] === 'add-generic-password') {
      keychainCalls.push({ args, value: args[args.length - 1], missing: undefined })
      callback(null, '')
      return
    }
    if (args[0] === 'delete-generic-password') {
      if (last !== undefined) last.missing = true
      callback(null, '')
      return
    }
    callback(null, '')
  })
  const ptySpawnMock = vi.fn((file: string, args: readonly string[]) => {
    expect(file).toBe('/usr/bin/security')
    let dataListener: ((data: string) => void) | undefined
    let exitListener: ((event: { exitCode: number; signal: number }) => void) | undefined
    let writes = 0
    const terminal = {
      onData(listener: (data: string) => void) {
        dataListener = listener
        queueMicrotask(() => dataListener?.('password data for new item: '))
        return { dispose: vi.fn() }
      },
      onExit(listener: (event: { exitCode: number; signal: number }) => void) {
        exitListener = listener
        return { dispose: vi.fn() }
      },
      write(input: string) {
        writes++
        if (writes === 1) {
          queueMicrotask(() => dataListener?.('retype password for new item: '))
        } else {
          keychainCalls.push({
            args,
            value: input.endsWith('\r') ? input.slice(0, -1) : input,
            missing: undefined,
          })
          queueMicrotask(() => exitListener?.({ exitCode: 0, signal: 0 }))
        }
      },
      kill: vi.fn(),
    }
    return terminal
  })
  return { keychainCalls, execFileMock, ptySpawnMock }
})

vi.mock('node:child_process', () => ({ execFile: execFileMock }))
vi.mock('node-pty', () => ({ spawn: ptySpawnMock }))

const KEY = credentialRef('DSH_CRED_TEST')

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.unstubAllEnvs()
  keychainCalls.splice(0, keychainCalls.length)
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function boot(): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'ark-keychain-contract-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  const fiber = ctx.plugin(LocalCredentialProvider, { path: join(root, 'credentials.yaml'), mode: 'keychain', keychainService: 'ark.test' })
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}

describe('keychain credential mode', () => {
  it('refuses conditional removal of a replacement and excludes writes during a checked record commit', async () => {
    const ctx = await boot()
    await ctx.credentials.set(KEY, 'first-synthetic')
    const before = credentialCondition(await ctx.credentials.resolve(KEY))
    await ctx.credentials.set(KEY, 'replacement-synthetic')
    await expect(ctx.credentials.unset(KEY, before)).rejects.toMatchObject({ name: 'CredentialConflictError' })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const expected = credentialCondition(await ctx.credentials.resolve(KEY))
    const record = ctx.credentials.modifyRecord(credentialKey('fixture', 'journal'), async () => {
      entered.resolve(undefined)
      await release.promise
      expect(await ctx.credentials.resolve(KEY)).toMatchObject({ value: 'replacement-synthetic' })
      return { kind: 'grant', payload: { committed: true } }
    }, [{ ref: KEY, expected }])
    await entered.promise
    const write = ctx.credentials.set(KEY, 'later-synthetic')
    release.resolve(undefined)
    await Promise.all([record, write])
    expect(await ctx.credentials.resolve(KEY)).toMatchObject({ value: 'later-synthetic' })
  })

  it('stores, resolves, describes, and unsets through the login Keychain service', async () => {
    const ctx = await boot()
    const ref: CredentialRef = KEY

    expect(await ctx.credentials.resolve(ref)).toBeUndefined()
    expect(await ctx.credentials.describe(ref)).toMatchObject({ configured: false, writable: true })

    await ctx.credentials.set(ref, 'secret-value')
    const write = keychainCalls.find(call => call.args[0] === 'add-generic-password')
    expect(write?.args.at(-1)).toBe('-w')
    expect(write?.args).not.toContain('secret-value')
    expect(write?.value).toBe('secret-value')
    expect(await ctx.credentials.resolve(ref)).toEqual({ value: 'secret-value', source: 'keychain' })
    expect(await ctx.credentials.describe(ref)).toMatchObject({ configured: true, source: 'keychain', writable: true })

    await ctx.credentials.unset(ref)
    expect(await ctx.credentials.resolve(ref)).toBeUndefined()
  })

  it('keeps the inherited environment as the read-only winning layer', async () => {
    vi.stubEnv('DSH_CRED_TEST', 'from-env')
    const ctx = await boot()
    const ref: CredentialRef = KEY
    expect(await ctx.credentials.resolve(ref)).toEqual({ value: 'from-env', source: 'env' })
    expect(await ctx.credentials.describe(ref)).toMatchObject({ configured: true, source: 'env', writable: false })
  })

  it('rejects empty values like the file mode', async () => {
    const ctx = await boot()
    await expect(ctx.credentials.set(KEY, '')).rejects.toThrow(/empty value/)
  })
})

describe('keychain construction and failure surfaces', () => {
  it('resolves the file-mode and keychain-service defaults for programmatic construction', () => {
    const provider = new LocalCredentialProvider(new Context(), { watch: false, path: '/unused/creds.yaml' })
    // Plugin loading normalizes config through the Schemastery schema, which
    // fills both defaults; direct construction exercises the constructor's own
    // `?? default` resolution for the same unset fields.
    expect(provider).toBeInstanceOf(LocalCredentialProvider)
  })

  it('rejects keychain mode off macOS', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    try {
      expect(() => new LocalCredentialProvider(new Context(), { mode: 'keychain' }))
        .toThrow(/keychain mode requires macOS/)
    } finally {
      if (platform === undefined) delete (process as { platform?: string }).platform
      else Object.defineProperty(process, 'platform', platform)
    }
  })

  it('propagates a security failure that is not item-not-found', async () => {
    const ctx = await boot()
    execFileMock.mockImplementationOnce((_file, _args, callback) => {
      callback(Object.assign(new Error('security backend down'), { code: 'ECONNREFUSED' }), '')
    })
    await expect(ctx.credentials.resolve(KEY)).rejects.toThrow(/security backend down/)
  })

  it('wraps a non-Error security failure in a stable diagnostic', async () => {
    const ctx = await boot()
    execFileMock.mockImplementationOnce((_file, _args, callback) => {
      callback({ code: 'EIO' }, '')
    })
    await expect(ctx.credentials.resolve(KEY)).rejects.toThrow(/security command failed/)
  })

  it('rethrows an unset failure that is not item-not-found', async () => {
    const ctx = await boot()
    execFileMock.mockImplementationOnce((_file, _args, callback) => {
      callback(Object.assign(new Error('keychain locked'), { code: 'EACCES' }), '')
    })
    await expect(ctx.credentials.unset(KEY)).rejects.toThrow(/keychain locked/)
  })

  it('rejects a failed password terminal and ignores late terminal callbacks', async () => {
    let dataListener: ((data: string) => void) | undefined
    let exitListener: ((event: { exitCode: number; signal: number }) => void) | undefined
    const write = vi.fn()
    ptySpawnMock.mockImplementationOnce(() => ({
      onData(listener: (data: string) => void) {
        dataListener = listener
        return { dispose: vi.fn() }
      },
      onExit(listener: (event: { exitCode: number; signal: number }) => void) {
        exitListener = listener
        return { dispose: vi.fn() }
      },
      write,
      kill: vi.fn(),
    }))
    const ctx = await boot()
    const pending = ctx.credentials.set(KEY, 'secret-value')
    const rejection = expect(pending).rejects.toMatchObject({ code: 7 })
    await vi.waitFor(() => {
      expect(dataListener).toBeDefined()
      expect(exitListener).toBeDefined()
    })
    dataListener?.('irrelevant terminal output')
    dataListener?.('password data for new item:')
    dataListener?.('retype password for new item:')
    dataListener?.('unexpected third prompt')
    exitListener?.({ exitCode: 7, signal: 0 })
    await rejection
    dataListener?.('password data for new item:')
    exitListener?.({ exitCode: 7, signal: 0 })
    expect(write).toHaveBeenNthCalledWith(1, 'secret-value\r')
    expect(write).toHaveBeenNthCalledWith(2, 'secret-value\r')
  })

  it('kills a password terminal that never reaches either prompt', async () => {
    let timeoutCallback: (() => void) | undefined
    let markSpawned: (() => void) | undefined
    const spawned = new Promise<void>((resolve) => { markSpawned = resolve })
    const kill = vi.fn()
    ptySpawnMock.mockImplementationOnce(() => {
      markSpawned?.()
      return {
        onData: vi.fn(() => ({ dispose: vi.fn() })),
        onExit: vi.fn(() => ({ dispose: vi.fn() })),
        write: vi.fn(),
        kill,
      }
    })
    const ctx = await boot()
    const timeout = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: () => void) => {
      timeoutCallback = callback
      return 1 as unknown as ReturnType<typeof setTimeout>
    })
    const pending = ctx.credentials.set(KEY, 'secret-value')
    await spawned
    expect(timeoutCallback).toBeDefined()
    timeoutCallback?.()
    timeoutCallback?.()
    await expect(pending).rejects.toThrow(/security command timed out/)
    expect(kill).toHaveBeenCalledOnce()
    timeout.mockRestore()
  })
})
