/** In-place updates of an already-owned Windows directory junction. */

import assert from 'node:assert/strict'
import { lstatSync } from 'node:fs'
import { win32 } from 'node:path'
import koffi from 'koffi'
import { extendWin32ProcessBindings, isNullPtr, throwLastError, type NativePtr } from './ffi.ts'

const MOUNT_POINT = 0xa0000003
const GET_REPARSE_POINT = 0x000900a8
const SET_REPARSE_POINT = 0x000900a4
const MAX_REPARSE_BYTES = 16_384
const FILE_ATTRIBUTE_DIRECTORY_REPARSE = 0x410

interface JunctionBindings {
  createFileW(path: string, access: number, share: number, attributes: null, disposition: number,
    flags: number, template: null): NativePtr | null
  getFileInformationByHandle(handle: NativePtr, information: Buffer): number
  getVolumeInformationByHandleW(handle: NativePtr, volume: null, volumeSize: number, serial: null,
    componentLength: null, flags: null, fileSystem: Buffer, fileSystemSize: number): number
  deviceIoControl(handle: NativePtr, operation: number, input: Buffer | null, inputSize: number,
    output: Buffer | null, outputSize: number, returned: Buffer, overlapped: null): number
}

let cached: ReturnType<typeof bindJunctionOperations> | undefined

function bindJunctionOperations() {
  const pointer = koffi.pointer('void')
  return extendWin32ProcessBindings<JunctionBindings>(({ kernel32, bind }) => ({
    createFileW: bind(kernel32, 'CreateFileW', pointer, ['str16', 'uint32', 'uint32', pointer, 'uint32', 'uint32', pointer]),
    getFileInformationByHandle: bind(kernel32, 'GetFileInformationByHandle', 'int', [pointer, pointer]),
    getVolumeInformationByHandleW: bind(kernel32, 'GetVolumeInformationByHandleW', 'int',
      [pointer, pointer, 'uint32', pointer, pointer, pointer, pointer, 'uint32']),
    deviceIoControl: bind(kernel32, 'DeviceIoControl', 'int', [pointer, 'uint32', pointer, 'uint32', pointer, 'uint32', pointer, pointer]),
  }) as JunctionBindings)
}

function junctionPath(path: string): string {
  assert(path.isWellFormed() && !path.includes('\0'), 'junction target is not a valid UTF-16 path')
  const ordinary = path.startsWith('\\\\?\\') ? path.slice(4) : path
  const normalized = win32.normalize(ordinary)
  assert(/^[a-z]:\\/iu.test(normalized), 'junction target must be an absolute drive path')
  return normalized
}

function mountPointBuffer(target: string): Buffer {
  const ordinary = junctionPath(target)
  const length = 16 + (ordinary.length + 4) * 2 + 2 + ordinary.length * 2 + 2
  assert(length <= MAX_REPARSE_BYTES, 'junction target exceeds the reparse point limit')
  const print = Buffer.from(ordinary, 'utf16le')
  const substitute = Buffer.from(`\\??\\${ordinary}`, 'utf16le')
  const bytes = Buffer.alloc(length)
  bytes.writeUInt32LE(MOUNT_POINT, 0)
  bytes.writeUInt16LE(bytes.length - 8, 4)
  bytes.writeUInt16LE(substitute.length, 10)
  bytes.writeUInt16LE(substitute.length + 2, 12)
  bytes.writeUInt16LE(print.length, 14)
  substitute.copy(bytes, 16)
  print.copy(bytes, 16 + substitute.length + 2)
  return bytes
}

function mountPointTarget(bytes: Buffer): string {
  assert(bytes.length >= 16, 'invalid junction reparse buffer length')
  assert(bytes.readUInt32LE(0) === MOUNT_POINT, 'owned entry is not a directory junction')
  assert(bytes.readUInt16LE(4) + 8 === bytes.length, 'invalid junction reparse data length')
  const pathBytes = bytes.subarray(16)
  const offset = bytes.readUInt16LE(8)
  const length = bytes.readUInt16LE(10)
  const printOffset = bytes.readUInt16LE(12)
  const printLength = bytes.readUInt16LE(14)
  assert(offset % 2 === 0 && length % 2 === 0 && length > 0 && offset + length <= pathBytes.length,
    'invalid junction substitute path bounds')
  assert(printOffset % 2 === 0 && printLength % 2 === 0 && printOffset + printLength <= pathBytes.length,
    'invalid junction print path bounds')
  const substitute = pathBytes.subarray(offset, offset + length).toString('utf16le')
  assert(substitute.startsWith('\\??\\'), 'junction target is outside the drive namespace')
  return junctionPath(substitute.slice(4))
}

/**
 * Re-point a same-tag directory junction without removing its namespace entry.
 * @param link - existing managed junction path; its ancestors remain caller-owned.
 * @param target - absolute drive target whose installation stays alive for current readers.
 * @param expected - exact BigInt identity and old target observed by the owning profile healer.
 * @returns after the same handle retains its identity and reports the requested target; native and close failures throw.
 * @throws a post-SET verification or close failure can follow a completed update; rejection is not a rollback claim.
 */
export function replaceJunctionTarget(link: string, target: string,
  expected: { readonly dev: bigint; readonly ino: bigint; readonly target: string }): void {
  const desired = mountPointBuffer(target)
  const oldTarget = junctionPath(expected.target)
  const entry = junctionPath(link)
  cached ??= bindJunctionOperations()
  const api = cached
  // Attribute-only access remains compatible with Node's share=0 readlink handles.
  // No FILE_SHARE_DELETE fences deletion/rename of this entry while it is held.
  const handle = api.createFileW(win32.toNamespacedPath(entry), 0x180, 0x3, null, 3, 0x02200000, null)
  if (isNullPtr(handle) || BigInt.asIntN(64, handle) === -1n) throwLastError(api, 'CreateFileW', link)
  const identity = () => {
    const information = Buffer.alloc(52)
    if (api.getFileInformationByHandle(handle, information) === 0) throwLastError(api, 'GetFileInformationByHandle', link)
    assert((information.readUInt32LE(0) & FILE_ATTRIBUTE_DIRECTORY_REPARSE) === FILE_ATTRIBUTE_DIRECTORY_REPARSE
      && information.readUInt32LE(40) === 1, 'owned junction file metadata differs')
    return { dev: BigInt(information.readUInt32LE(28)),
      ino: BigInt(information.readUInt32LE(44)) << 32n | BigInt(information.readUInt32LE(48)) }
  }
  const assertIdentity = () => {
    const current = identity()
    const named = lstatSync(link, { bigint: true })
    assert(named.isSymbolicLink() && named.nlink === 1n && expected.dev > 0n && expected.ino > 0n
      && current.dev === expected.dev && current.ino === expected.ino
      && named.dev === current.dev && named.ino === current.ino, 'owned junction identity changed')
  }
  const getTarget = () => {
    const output = Buffer.alloc(MAX_REPARSE_BYTES)
    const returned = Buffer.alloc(4)
    if (api.deviceIoControl(handle, GET_REPARSE_POINT, null, 0, output, output.length, returned, null) === 0) {
      throwLastError(api, 'FSCTL_GET_REPARSE_POINT', link)
    }
    const size = returned.readUInt32LE(0)
    assert(size <= output.length, 'junction response exceeds the reparse point limit')
    return mountPointTarget(output.subarray(0, size))
  }
  let primary: unknown
  let failed = false
  try {
    // Node's lstat and BY_HANDLE expose the same 64-bit ID. ReFS requires a
    // 128-bit ID, so an apparent 64-bit match there is not authoritative.
    const fileSystem = Buffer.alloc(64)
    if (api.getVolumeInformationByHandleW(handle, null, 0, null, null, null, fileSystem, fileSystem.length / 2) === 0) {
      throwLastError(api, 'GetVolumeInformationByHandleW', link)
    }
    assert(fileSystem.toString('utf16le').split('\0', 1)[0] === 'NTFS', 'owned junction requires an NTFS file identity')
    assertIdentity()
    assert(getTarget() === oldTarget, 'owned junction target changed')
    const returned = Buffer.alloc(4)
    if (api.deviceIoControl(handle, SET_REPARSE_POINT, desired, desired.length, null, 0, returned, null) === 0) {
      throwLastError(api, 'FSCTL_SET_REPARSE_POINT', link)
    }
    assertIdentity()
    assert(getTarget() === junctionPath(target), 'junction update did not retain the requested target')
  } catch (error) {
    primary = error
    failed = true
  }
  try {
    if (api.closeHandle(handle) === 0) throwLastError(api, 'CloseHandle', link)
  } catch (error) {
    if (failed) throw new AggregateError([primary, error], 'junction update and handle close failed')
    throw error
  }
  if (failed) throw primary
}
