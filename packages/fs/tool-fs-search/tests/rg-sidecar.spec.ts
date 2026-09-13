import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { dependencyRgPath, existsSync } = vi.hoisted(() => ({
  dependencyRgPath: '/node_modules/@vscode/ripgrep/bin/rg',
  existsSync: vi.fn(),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, existsSync }
})

vi.mock('@vscode/ripgrep', () => ({ rgPath: dependencyRgPath }))

const originalExecPath = process.execPath

/** Point the resolver at one platform-shaped executable path for a case. */
function stubExecPath(value: string): void {
  Reflect.defineProperty(process, 'execPath', { configurable: true, value })
}

/** The sidecar rule the packaging script and the Python launcher both use. */
function expectedSidecar(execPath: string): string {
  return process.platform === 'win32'
    ? `${execPath.slice(0, -'.exe'.length)}-rg.exe`
    : `${execPath}-rg`
}

beforeEach(() => {
  vi.resetModules()
  existsSync.mockReset()
  Reflect.deleteProperty(process, 'pkg')
})

afterEach(() => {
  Reflect.deleteProperty(process, 'pkg')
  Reflect.defineProperty(process, 'execPath', { configurable: true, value: originalExecPath })
})

describe('ripgrep resolution', () => {
  it('uses the native sidecar beside the current executable', async () => {
    Reflect.defineProperty(process, 'pkg', { configurable: true, value: {} })
    existsSync.mockReturnValue(true)
    const sidecar = expectedSidecar(process.execPath)
    const { resolveRgPath } = await import('@deepseek-ai/dsh-tool-fs-search')

    await expect(resolveRgPath()).resolves.toBe(sidecar)
    expect(existsSync).toHaveBeenCalledWith(sidecar)
  })

  it('names the Windows sidecar beside the executable, not after its extension', async () => {
    const windowsExe = 'C:\\runtime\\deepseek-harness-sdk-runtime-win-x64.exe'
    stubExecPath(windowsExe)
    Reflect.defineProperty(process, 'pkg', { configurable: true, value: {} })
    existsSync.mockReturnValue(true)
    const { resolveRgPath } = await import('@deepseek-ai/dsh-tool-fs-search')

    const sidecar = 'C:\\runtime\\deepseek-harness-sdk-runtime-win-x64-rg.exe'
    await expect(resolveRgPath()).resolves.toBe(sidecar)
    expect(existsSync).toHaveBeenCalledWith(sidecar)
  })

  it('uses the dependency binary in an ordinary Node process', async () => {
    existsSync.mockReturnValue(true)
    const { resolveRgPath } = await import('@deepseek-ai/dsh-tool-fs-search')

    await expect(resolveRgPath()).resolves.toBe(dependencyRgPath)
    expect(existsSync).not.toHaveBeenCalled()
  })

  it('uses the dependency binary when a packaged runtime has no sidecar', async () => {
    Reflect.defineProperty(process, 'pkg', { configurable: true, value: {} })
    existsSync.mockReturnValue(false)
    const { resolveRgPath } = await import('@deepseek-ai/dsh-tool-fs-search')

    await expect(resolveRgPath()).resolves.toBe(dependencyRgPath)
    expect(existsSync).toHaveBeenCalledWith(expectedSidecar(process.execPath))
  })
})
