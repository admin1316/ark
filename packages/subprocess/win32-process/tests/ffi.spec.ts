import { spawnSync } from 'node:child_process'
import koffi from 'koffi'
import { describe, expect, it, vi } from 'vitest'
import {
  Win32Error,
  allocPtrSlot,
  decodePtr,
  isNullPtr,
  throwLastError,
} from '../src/index.ts'
import { PROCESS_INFORMATION_SIZE, STARTUPINFOW_SIZE } from '../src/abi.ts'
import { PROCESS_INFORMATION, STARTUPINFOW, errorText } from '../src/ffi.ts'
import type { NativePtr, Win32ProcessBindings } from '../src/index.ts'

describe('shared Win32 process ABI', () => {
  it('matches the verified x64 structure sizes', () => {
    expect(STARTUPINFOW.size).toBe(STARTUPINFOW_SIZE)
    expect(PROCESS_INFORMATION.size).toBe(PROCESS_INFORMATION_SIZE)
  })

  it('loads independent FFI module identities into the same Koffi registry', () => {
    // Separate source and built consumers share Koffi's process-wide type registry.
    // A real child keeps the import identity check outside Vitest's module runner.
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
      import assert from 'node:assert/strict'
      import { createRequire } from 'node:module'
      const firstURL = process.argv[1]
      const secondURL = firstURL + '?independent-ffi-module'
      const koffi = createRequire(firstURL)('koffi')
      assert.equal(koffi, createRequire(secondURL)('koffi'))
      const first = await import(firstURL)
      const second = await import(secondURL)
      assert.notEqual(first, second)
      const slot = koffi.alloc(first.PROCESS_INFORMATION, 1)
      try {
        const information = { hProcess: null, hThread: null, dwProcessId: 123, dwThreadId: 456 }
        koffi.encode(slot, first.PROCESS_INFORMATION, information)
        assert.deepEqual(koffi.decode(slot, second.PROCESS_INFORMATION), information)
        const replacement = { ...information, dwThreadId: 789 }
        koffi.encode(slot, second.PROCESS_INFORMATION, replacement)
        assert.deepEqual(koffi.decode(slot, first.PROCESS_INFORMATION), replacement)
      } finally { koffi.free(slot) }
      console.log(JSON.stringify({
        startupSizes: [first.STARTUPINFOW.size, second.STARTUPINFOW.size],
        processSizes: [first.PROCESS_INFORMATION.size, second.PROCESS_INFORMATION.size],
      }))
    `, new URL('../src/ffi.ts', import.meta.url).href], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        TMPDIR: process.env.TMPDIR,
      },
    })
    expect(child.error).toBeUndefined()
    expect({ status: child.status, signal: child.signal, stderr: child.stderr })
      .toEqual({ status: 0, signal: null, stderr: '' })
    expect(JSON.parse(child.stdout)).toEqual({
      startupSizes: [STARTUPINFOW_SIZE, STARTUPINFOW_SIZE],
      processSizes: [PROCESS_INFORMATION_SIZE, PROCESS_INFORMATION_SIZE],
    })
  })

  it('handles NULL pointer out-parameters', () => {
    const slot = allocPtrSlot()
    expect(decodePtr(slot)).toBeNull()
    expect(isNullPtr(0n as NativePtr)).toBe(true)
    expect(isNullPtr(1n as NativePtr)).toBe(false)
  })

  it('formats and throws the exact Win32 error', () => {
    const api = {
      getLastError: vi.fn(() => 5),
      formatMessageW: vi.fn((_flags, _source, _id, _language, buffer: Buffer) => {
        buffer.write('access denied', 'utf16le')
        return 'access denied'.length
      }),
    } as unknown as Win32ProcessBindings
    expect(errorText(api, 5)).toBe('access denied')
    expect(() => throwLastError(api, 'Probe')).toThrow(Win32Error)
    expect(new Win32Error('CloseHandle', 6).message).toBe('CloseHandle failed (Win32 6)')
  })

  it('decodes a pointer stored by Koffi', () => {
    const slot = allocPtrSlot()
    koffi.encode(slot, koffi.pointer('void'), 42n)
    expect(decodePtr(slot)).toBe(42n)
  })
})
