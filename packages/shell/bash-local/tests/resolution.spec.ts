// resolveBashExecutable is the executor's fail-closed argv head. POSIX passes the
// bare name through; win32 resolves an absolute non-system bash.exe once per
// process, because CreateProcess's search order would otherwise route a sandboxed
// `bash -c` into System32's WSL launcher — outside the sandbox entirely.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveBashExecutable } from '@deepseek-ai/dsh-bash-local'

const cleanups: Array<() => void> = []
const hostPath = process.env.PATH
const hostSystemRoot = process.env.SystemRoot

afterEach(() => {
  if (hostPath === undefined) delete process.env.PATH
  else process.env.PATH = hostPath
  if (hostSystemRoot === undefined) delete process.env.SystemRoot
  else process.env.SystemRoot = hostSystemRoot
  while (cleanups.length > 0) cleanups.pop()?.()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bash-resolution-'))
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

/** A fake Windows root whose system directories hold the WSL launcher the scan must refuse. */
function windowsRoot(): { root: string; systemDirectories: string[] } {
  const root = tempDir()
  const systemDirectories = [root, join(root, 'System32'), join(root, 'SysWOW64')]
  for (const directory of systemDirectories) {
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'bash.exe'), 'wsl launcher stand-in')
  }
  return { root, systemDirectories }
}

/** One PATH segment holding a real bash.exe, plus segments the scan must survive. */
function bashDistribution(): string {
  const bin = join(tempDir(), 'Git', 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'bash.exe'), 'git for windows stand-in')
  return bin
}

/**
 * A fresh module instance: the win32 answer is memoized per process, so the scan
 * itself (and its failure) is only reachable before the first successful call.
 */
async function freshResolve(): Promise<typeof resolveBashExecutable> {
  vi.resetModules()
  return (await import('@deepseek-ai/dsh-bash-local')).resolveBashExecutable
}

describe('resolveBashExecutable', () => {
  it('passes the bare name through on POSIX so execvp does the PATH resolution', () => {
    expect(resolveBashExecutable('linux')).toBe('bash')
    expect(resolveBashExecutable('darwin')).toBe('bash')
    expect(resolveBashExecutable('freebsd')).toBe('bash')
    if (process.platform !== 'win32') expect(resolveBashExecutable()).toBe('bash')
  })

  it('resolves an absolute non-system bash.exe on win32 and memoizes the answer', async () => {
    const { root, systemDirectories } = windowsRoot()
    const bin = bashDistribution()
    const missing = join(tempDir(), 'no-bash-here')
    process.env.SystemRoot = root
    // A system directory first (refused as the WSL launcher), then an empty
    // segment, a segment without bash.exe, and finally the real distribution.
    process.env.PATH = [...systemDirectories, '', missing, bin].join(delimiter)

    const resolve = await freshResolve()
    expect(resolve('win32')).toBe(join(bin, 'bash.exe'))
    // The memoized second call answers without rescanning, even once PATH is gone.
    delete process.env.PATH
    expect(resolve('win32')).toBe(join(bin, 'bash.exe'))
  })

  it('skips a directory entry named bash.exe that is not a file', async () => {
    const { root } = windowsRoot()
    const bin = bashDistribution()
    const decoy = tempDir()
    mkdirSync(join(decoy, 'bash.exe'))
    process.env.SystemRoot = root
    process.env.PATH = [decoy, bin].join(delimiter)

    const resolve = await freshResolve()
    expect(resolve('win32')).toBe(join(bin, 'bash.exe'))
  })

  it('fails closed when PATH offers only the system-directory WSL launcher', async () => {
    const { root, systemDirectories } = windowsRoot()
    process.env.SystemRoot = root
    // Case-insensitive, exactly as Windows compares the paths.
    process.env.PATH = systemDirectories.map(directory => directory.toUpperCase()).join(delimiter)

    const resolve = await freshResolve()
    expect(() => resolve('win32'))
      .toThrow(/no bash\.exe found on PATH outside the Windows system directories/)
    expect(() => resolve('win32')).toThrow(/Install Git for Windows/)
  })

  it('treats an unset PATH as no candidate and defaults SystemRoot when unset', async () => {
    delete process.env.PATH
    delete process.env.SystemRoot
    const resolve = await freshResolve()
    expect(() => resolve('win32')).toThrow(/no bash\.exe found on PATH/)

    const bin = bashDistribution()
    delete process.env.SystemRoot
    process.env.PATH = bin
    const next = await freshResolve()
    expect(next('win32')).toBe(join(bin, 'bash.exe'))
  })
})
