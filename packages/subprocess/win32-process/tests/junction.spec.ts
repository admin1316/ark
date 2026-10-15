/** Native-boundary contracts; real Windows publication is exercised by app-boot's unchanged stress. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Win32BindingContext } from '../src/ffi.ts'

const boundary = vi.hoisted(() => ({
  calls: [] as string[],
  createResult: 11n as bigint | null,
  infoCalls: 0,
  getCalls: 0,
  infoFailAt: 0,
  getFailAt: 0,
  setFails: false,
  closeFails: false,
  volumeFails: false,
  fileSystem: 'NTFS',
  attributes: 0x410,
  nlink: 1,
  dev: 7n,
  ino: (1n << 60n) + 3n,
  namedIno: (1n << 60n) + 3n,
  namedDev: undefined as bigint | undefined,
  namedLink: true,
  namedNlink: 1n,
  afterIno: undefined as bigint | undefined,
  response: undefined as Buffer | undefined,
  returnedSize: undefined as number | undefined,
  afterResponse: undefined as Buffer | undefined,
  published: undefined as Buffer | undefined,
  open: [] as unknown[],
}))

vi.mock('node:fs', () => ({ lstatSync: (_path: string, options: unknown) => {
  expect(options).toEqual({ bigint: true })
  return { dev: boundary.namedDev ?? boundary.dev, ino: boundary.namedIno, nlink: boundary.namedNlink,
    isSymbolicLink: () => boundary.namedLink }
} }))

vi.mock('../src/ffi.ts', async (original) => {
  const actual = await original<typeof import('../src/ffi.ts')>()
  return { ...actual, extendWin32ProcessBindings: (create: (context: Win32BindingContext) => object) => {
    const bind: Win32BindingContext['bind'] = (_lib, name) => {
      if (name === 'CreateFileW') return (...args: unknown[]) => {
        boundary.calls.push('open'); boundary.open = args
        return boundary.createResult
      }
      if (name === 'GetFileInformationByHandle') return (_handle: bigint, info: Buffer) => {
        boundary.calls.push('identity'); boundary.infoCalls++
        if (boundary.infoCalls === boundary.infoFailAt) return 0
        info.writeUInt32LE(boundary.attributes, 0)
        info.writeUInt32LE(Number(boundary.dev), 28)
        info.writeUInt32LE(boundary.nlink, 40)
        const ino = boundary.published === undefined ? boundary.ino : boundary.afterIno ?? boundary.ino
        info.writeUInt32LE(Number(ino >> 32n), 44)
        info.writeUInt32LE(Number(ino & 0xffffffffn), 48)
        return 1
      }
      if (name === 'GetVolumeInformationByHandleW') return (_handle: bigint, volume: null, volumeSize: number,
        serial: null, componentLength: null, flags: null, output: Buffer, outputSize: number) => {
        boundary.calls.push('volume')
        expect([volume, volumeSize, serial, componentLength, flags, outputSize]).toEqual([null, 0, null, null, null, 32])
        if (boundary.volumeFails) return 0
        output.write(boundary.fileSystem, 'utf16le')
        return 1
      }
      if (name === 'DeviceIoControl') return (_handle: bigint, operation: number, input: Buffer | null, inputSize: number,
        output: Buffer | null, outputSize: number, returned: Buffer, overlapped: null) => {
        expect(overlapped).toBeNull()
        if (operation === 0x900a4) {
          boundary.calls.push('set')
          expect(input).not.toBeNull(); expect(inputSize).toBe(input!.length)
          expect(output).toBeNull(); expect(outputSize).toBe(0)
          if (boundary.setFails) return 0
          boundary.published = Buffer.from(input!)
          return 1
        }
        expect(operation).toBe(0x900a8)
        boundary.calls.push('get'); boundary.getCalls++
        expect(input).toBeNull(); expect(inputSize).toBe(0); expect(outputSize).toBe(16_384)
        if (boundary.getCalls === boundary.getFailAt) return 0
        // Captured MOUNT_POINT layout with substitute \\??\\C:\\old and an empty print name.
        const old = Buffer.from('030000a01e00000000001400160000005c003f003f005c0043003a005c006f006c0064000000', 'hex')
        const response = boundary.published === undefined ? boundary.response ?? old
          : boundary.afterResponse ?? boundary.published
        response.copy(output!)
        returned.writeUInt32LE(boundary.returnedSize ?? response.length, 0)
        return 1
      }
      throw new Error(`unexpected native binding ${name}`)
    }
    return { ...create({ kernel32: {} as Win32BindingContext['kernel32'], advapi32: {} as Win32BindingContext['advapi32'], bind }),
      closeHandle: (handle: bigint) => { boundary.calls.push('close'); expect(handle).toBe(11n); return boundary.closeFails ? 0 : 1 },
      getLastError: () => 5,
      formatMessageW: () => 0 }
  } }
})

import { replaceJunctionTarget } from '../src/junction.ts'

const link = 'C:\\home\\profiles\\node_modules\\pkg'
const expected = { dev: 7n, ino: (1n << 60n) + 3n, target: 'C:\\old' }

beforeEach(() => {
  Object.assign(boundary, { calls: [], createResult: 11n, infoCalls: 0, getCalls: 0, infoFailAt: 0, getFailAt: 0,
    setFails: false, closeFails: false, volumeFails: false, fileSystem: 'NTFS', attributes: 0x410, nlink: 1, dev: 7n, ino: expected.ino,
    namedIno: expected.ino, namedDev: undefined, namedLink: true, namedNlink: 1n, afterIno: undefined, response: undefined,
    returnedSize: undefined, afterResponse: undefined, published: undefined, open: [] })
})

describe('owned junction retargeting', () => {
  it('updates the same handle using attribute-only access and retains the exact high inode', () => {
    replaceJunctionTarget(link, 'C:\\new-\ud83d\udcc1', expected)
    expect(boundary.calls).toEqual(['open', 'volume', 'identity', 'get', 'set', 'identity', 'get', 'close'])
    expect(boundary.open).toEqual([`\\\\?\\${link}`, 0x180, 3, null, 3, 0x02200000, null])
    const bytes = boundary.published!
    expect(bytes.readUInt32LE(0)).toBe(0xa0000003)
    expect(bytes.readUInt16LE(4) + 8).toBe(bytes.length)
    expect(bytes.readUInt16LE(6)).toBe(0)
    expect(bytes.subarray(16, 16 + bytes.readUInt16LE(10)).toString('utf16le')).toBe('\\??\\C:\\new-\ud83d\udcc1')
    expect(bytes.subarray(16 + bytes.readUInt16LE(12), 16 + bytes.readUInt16LE(12) + bytes.readUInt16LE(14))
      .toString('utf16le')).toBe('C:\\new-\ud83d\udcc1')
  })

  it('accepts an already completed matching retarget without another SET', () => {
    replaceJunctionTarget(link, 'C:\\new', expected)
    const published = Buffer.from(boundary.published!)
    boundary.calls = []

    replaceJunctionTarget(link, 'C:\\new', expected)

    expect(boundary.calls).toContain('volume')
    expect(boundary.calls).toContain('identity')
    expect(boundary.calls).toContain('get')
    expect(boundary.calls).not.toContain('set')
    expect(boundary.calls.at(-1)).toBe('close')
    expect(boundary.published).toEqual(published)
  })

  it('refuses a third target after another retarget completed', () => {
    replaceJunctionTarget(link, 'C:\\new', expected)
    const published = Buffer.from(boundary.published!)
    boundary.calls = []

    expect(() => { replaceJunctionTarget(link, 'C:\\third', expected) }).toThrow('target changed')
    expect(boundary.calls).not.toContain('set')
    expect(boundary.calls.at(-1)).toBe('close')
    expect(boundary.published).toEqual(published)
  })

  it.each([
    ['non-NTFS identity', { fileSystem: 'ReFS' }, 'requires an NTFS file identity'],
    ['changed file identity', { namedIno: expected.ino + 1n }, 'identity changed'],
    ['foreign reparse tag', { afterResponse: Buffer.from('0c0000a0080000000000000000000000', 'hex') }, 'not a directory junction'],
  ] as const)('checks %s before accepting an already completed matching retarget', (_name, mutation, error) => {
    replaceJunctionTarget(link, 'C:\\new', expected)
    Object.assign(boundary, mutation)
    boundary.calls = []

    expect(() => { replaceJunctionTarget(link, 'C:\\new', expected) }).toThrow(error)
    expect(boundary.calls).not.toContain('set')
    expect(boundary.calls.at(-1)).toBe('close')
  })

  it('reports close failure when the matching retarget is already complete', () => {
    replaceJunctionTarget(link, 'C:\\new', expected)
    boundary.calls = []
    boundary.closeFails = true

    expect(() => { replaceJunctionTarget(link, 'C:\\new', expected) })
      .toThrow(/CloseHandle failed \(Win32 5\)|junction update and handle close failed/u)
    expect(boundary.calls).not.toContain('set')
    expect(boundary.calls.at(-1)).toBe('close')
  })

  it('accepts a namespaced drive target without changing the drive-target representation', () => {
    replaceJunctionTarget(link, '\\\\?\\C:\\new', expected)
    expect(boundary.published!.subarray(16, 16 + boundary.published!.readUInt16LE(10)).toString('utf16le'))
      .toBe('\\??\\C:\\new')
  })

  it.each(['C:\\home\\'+ 'nested\\'.repeat(45) + 'pkg', '\\\\?\\C:\\home\\'+ 'nested\\'.repeat(45) + 'pkg'])(
    'keeps the native open namespaced for long entry case %#', (entry) => {
      replaceJunctionTarget(entry, 'C:\\new', expected)
      const ordinary = entry.startsWith('\\\\?\\') ? entry.slice(4) : entry
      expect(ordinary.length).toBeGreaterThan(260)
      expect(boundary.open).toEqual([`\\\\?\\${ordinary}`, 0x180, 3, null, 3, 0x02200000, null])
      const bytes = boundary.published!
      expect(bytes.subarray(16, 16 + bytes.readUInt16LE(10)).toString('utf16le')).toBe('\\??\\C:\\new')
    })

  it.each(['relative', '\\\\server\\share', 'C:\\bad\0name', 'C:\\bad\ud800', `C:\\${'x'.repeat(5000)}`])(
    'refuses unsupported or malformed target %j before opening the entry', (target) => {
      expect(() => { replaceJunctionTarget(link, target, expected) }).toThrow()
      expect(boundary.calls).toEqual([])
    })

  it.each([null, 0n, -1n, 0xffffffffffffffffn])('refuses failed opens %s without closing an invalid handle', (handle) => {
    boundary.createResult = handle
    expect(() => { replaceJunctionTarget(link, 'C:\\new', expected) }).toThrow('CreateFileW failed (Win32 5)')
    expect(boundary.calls).toEqual(['open'])
  })

  it('closes the held point on volume-query permission or unsupported-API refusal', () => {
    boundary.volumeFails = true
    expect(() => { replaceJunctionTarget(link, 'C:\\new', expected) }).toThrow('GetVolumeInformationByHandleW failed (Win32 5)')
    expect(boundary.calls).toEqual(['open', 'volume', 'close'])
  })

  it.each(['ReFS', 'FAT32', ''])('rejects non-authoritative %s file IDs without SET or deletion', (fileSystem) => {
    boundary.fileSystem = fileSystem
    expect(() => { replaceJunctionTarget(link, 'C:\\new', expected) }).toThrow('requires an NTFS file identity')
    expect(boundary.calls).toEqual(['open', 'volume', 'close'])
  })

  it.each([{ attributes: 0x10 }, { nlink: 2 }, { namedLink: false }, { namedNlink: 2n },
    { namedIno: expected.ino + 1n }, { ino: expected.ino + 1n }, { dev: 8n }, { namedDev: 8n }])(
    'refuses foreign metadata case %# without SET', (mutation) => {
      Object.assign(boundary, mutation)
      expect(() => { replaceJunctionTarget(link, 'C:\\new', expected) }).toThrow(/owned junction/)
      expect(boundary.calls.at(-1)).toBe('close')
      expect(boundary.calls).not.toContain('set')
    })

  it('refuses an unobservable zero identity without SET', () => {
    expect(() => { replaceJunctionTarget(link, 'C:\\new', { ...expected, ino: 0n }) }).toThrow('identity changed')
    expect(boundary.calls).not.toContain('set')
    expect(boundary.calls.at(-1)).toBe('close')
  })

  it('refuses an unobservable zero volume identity without SET', () => {
    boundary.dev = 0n
    expect(() => { replaceJunctionTarget(link, 'C:\\new', { ...expected, dev: 0n }) }).toThrow('identity changed')
    expect(boundary.calls).not.toContain('set')
    expect(boundary.calls.at(-1)).toBe('close')
  })

  it.each([1, 2])('closes the owned handle when identity query %s fails', (at) => {
    boundary.infoFailAt = at
    expect(() => { replaceJunctionTarget(link, 'C:\\new', expected) }).toThrow('GetFileInformationByHandle failed (Win32 5)')
    expect(boundary.calls.at(-1)).toBe('close')
  })

  it.each([1, 2])('closes the owned handle when GET %s fails', (at) => {
    boundary.getFailAt = at
    expect(() => { replaceJunctionTarget(link, 'C:\\new', expected) }).toThrow('FSCTL_GET_REPARSE_POINT failed (Win32 5)')
    expect(boundary.calls.at(-1)).toBe('close')
  })

  it.each([
    Buffer.alloc(8),
    Buffer.from('0c0000a0080000000000000000000000', 'hex'),
    Buffer.from('030000a0070000000000000000000000', 'hex'),
    Buffer.from('030000a0080000000100020000000000', 'hex'),
    Buffer.from('030000a0080000000000010000000000', 'hex'),
    Buffer.from('030000a0080000000000000000000000', 'hex'),
    Buffer.from('030000a0080000000000040000000000', 'hex'),
    Buffer.from('030000a0080000000000020001000000', 'hex'),
  ])('refuses malformed or foreign reparse data without SET', (bytes) => {
    boundary.response = bytes
    expect(() => { replaceJunctionTarget(link, 'C:\\new', expected) }).toThrow()
    expect(boundary.calls).not.toContain('set')
    expect(boundary.calls.at(-1)).toBe('close')
  })

  it('refuses a response larger than the native output bound', () => {
    boundary.returnedSize = 16_385
    expect(() => { replaceJunctionTarget(link, 'C:\\new', expected) }).toThrow('response exceeds')
    expect(boundary.calls).not.toContain('set')
    expect(boundary.calls.at(-1)).toBe('close')
  })

  it.each([[12, 1], [14, 1], [12, 200], [16, 65]])(
    'refuses foreign namespace or print bounds case %# before SET', (offset, value) => {
      const bytes = Buffer.from('030000a01e00000000001400160000005c003f003f005c0043003a005c006f006c0064000000', 'hex')
      bytes.writeUInt16LE(value, offset)
      boundary.response = bytes
      expect(() => { replaceJunctionTarget(link, 'C:\\new', expected) }).toThrow()
      expect(boundary.calls).not.toContain('set')
      expect(boundary.calls.at(-1)).toBe('close')
    })

  it('refuses a changed old target without writing', () => {
    expect(() => { replaceJunctionTarget(link, 'C:\\new', { ...expected, target: 'C:\\other' }) }).toThrow('target changed')
    expect(boundary.calls).not.toContain('set')
    expect(boundary.calls.at(-1)).toBe('close')
  })

  it('preserves SET refusal and closes the held entry', () => {
    boundary.setFails = true
    expect(() => { replaceJunctionTarget(link, 'C:\\new', expected) }).toThrow('FSCTL_SET_REPARSE_POINT failed (Win32 5)')
    expect(boundary.published).toBeUndefined()
    expect(boundary.calls.at(-1)).toBe('close')
  })

  it('rejects a post-write handle identity change', () => {
    boundary.afterIno = expected.ino + 1n
    expect(() => { replaceJunctionTarget(link, 'C:\\new', expected) }).toThrow('identity changed')
    expect(boundary.calls.at(-1)).toBe('close')
  })

  it('rejects an unsuccessful post-write target observation', () => {
    boundary.afterResponse = Buffer.from('030000a01e00000000001400160000005c003f003f005c0043003a005c006f006c0064000000', 'hex')
    expect(() => { replaceJunctionTarget(link, 'C:\\new', expected) }).toThrow('did not retain')
    expect(boundary.calls.at(-1)).toBe('close')
  })

  it('reports close failure after a completed update', () => {
    boundary.closeFails = true
    expect(() => { replaceJunctionTarget(link, 'C:\\new', expected) }).toThrow('CloseHandle failed (Win32 5)')
  })

  it('retains the primary refusal when handle close also fails', () => {
    boundary.setFails = true; boundary.closeFails = true
    let failure: unknown
    try { replaceJunctionTarget(link, 'C:\\new', expected) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors.map(error => (error as Error).message))
      .toEqual(['FSCTL_SET_REPARSE_POINT failed (Win32 5): '+link, 'CloseHandle failed (Win32 5): '+link])
  })
})
