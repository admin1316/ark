#!/usr/bin/env node
/** Failure-only evidence for one Native contract process; never changes its result. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const PROCESS_NAME = 'JiuzhangShellContractTests'
const MAX_REPORT_BYTES = 16 * 1024 * 1024
const MAX_BINARY_BYTES = 256 * 1024 * 1024

interface ProcessIdentity {
  schemaVersion: 1
  pid: number
  executablePath: string
  startedAtUTC: string
}

interface ReportIdentity {
  pid: number
  executablePath: string
  capturedAt: number
}

/** Explicit filesystem/tool boundaries permit temporary fake reports without a macOS crash. */
export interface NativeContractDiagnosticsOptions {
  diagnosticsDirectory: string
  executable: string
  reportDirectories?: readonly string[]
  now?: Date
  uuidForFile?: (path: string) => readonly string[]
  run?: { id: string | null; attempt: string | null; commit: string | null; job: string | null }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function errorCode(error: unknown): string {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : 'invalid-or-unavailable'
}

/** Read the same bounded regular file that was opened, without following a leaf symlink. */
function readRegular(path: string, maximum: number, window?: { started: number; ended: number }): Buffer {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(file)
    if (!stat.isFile() || stat.size === 0 || stat.size > maximum) throw new Error('invalid diagnostic file size or type')
    if (window !== undefined && (stat.mtimeMs < window.started || stat.mtimeMs > window.ended)) {
      throw new Error('opened diagnostic file is outside the launch window')
    }
    const bytes = Buffer.alloc(stat.size + 1)
    let count = 0
    while (count < bytes.length) {
      const read = readSync(file, bytes, count, bytes.length - count, count)
      if (read === 0) break
      count += read
    }
    const after = fstatSync(file)
    if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('diagnostic file changed')
    return bytes.subarray(0, count)
  } finally {
    closeSync(file)
  }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('diagnostic object required')
  return value as Record<string, unknown>
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string') throw new Error('diagnostic timestamp required')
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}:?\d{2})$/u.exec(value)
  if (match === null) throw new Error('diagnostic timestamp format differs')
  const zone = match[4] as string
  const normalizedZone = zone === 'Z' || zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`
  const time = Date.parse(`${match[1]}T${match[2]}.${(match[3] ?? '').padEnd(3, '0').slice(0, 3)}${normalizedZone}`)
  if (!Number.isFinite(time)) throw new Error('diagnostic timestamp is invalid')
  return time
}

function processIdentity(bytes: Buffer, executable: string, now: number): ProcessIdentity {
  const value = object(JSON.parse(bytes.toString('utf8')))
  if (Object.keys(value).sort().join(',') !== 'executablePath,pid,schemaVersion,startedAtUTC'
    || value.schemaVersion !== 1 || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0
    || value.executablePath !== executable || typeof value.startedAtUTC !== 'string'
    || !value.startedAtUTC.endsWith('Z') || timestamp(value.startedAtUTC) > now) throw new Error('process identity differs')
  return value as unknown as ProcessIdentity
}

function reportIdentity(bytes: Buffer, extension: string): ReportIdentity {
  const text = bytes.toString('utf8')
  if (extension === '.ips') {
    let report: Record<string, unknown>
    let header: Record<string, unknown> = {}
    try { report = object(JSON.parse(text)) } catch {
      // Apple .ips reports can start with a metadata JSON line before the body JSON.
      const newline = text.indexOf('\n')
      header = object(JSON.parse(text.slice(0, newline)))
      report = object(JSON.parse(text.slice(newline + 1)))
    }
    if (!Number.isSafeInteger(report.pid) || typeof report.procPath !== 'string') {
      throw new Error('report process metadata differs')
    }
    return { pid: report.pid as number, executablePath: report.procPath, capturedAt: timestamp(report.captureTime ?? header.timestamp) }
  }
  const process = /^Process:[^\r\n]+\[(\d+)\][^\S\r\n]*$/mu.exec(text)
  const path = /^Path:\s+(.+)$/mu.exec(text)
  const date = /^Date\/Time:\s+(.+)$/mu.exec(text)
  if (process === null || path === null || date === null) throw new Error('crash process metadata is missing')
  return { pid: Number(process[1]), executablePath: (path[1] as string).trim(), capturedAt: timestamp((date[1] as string).trim()) }
}

function machoUUIDs(path: string): readonly string[] {
  const result = spawnSync('xcrun', ['dwarfdump', '--uuid', path], { encoding: 'utf8', maxBuffer: 64 * 1024 })
  if (result.error !== undefined || result.status !== 0) return []
  return [...result.stdout.matchAll(/^UUID:\s+([A-Fa-f0-9-]{36})\s+\(([A-Za-z0-9_]+)\)/gmu)]
    .map(match => `${(match[1] as string).toUpperCase()}:${match[2]}`).sort()
}

/**
 * Collect only reports bound to the current main PID, exact binary and launch window.
 * @param options - Job-local output, fixed build executable and optional fake-report/tool inputs.
 * @returns The written manifest; missing or rejected reports are evidence gaps, never a test pass.
 * @throws If the output already exists or the collector cannot create its own output/manifest.
 */
export function collectNativeContractDiagnostics(options: NativeContractDiagnosticsOptions) {
  if (!isAbsolute(options.diagnosticsDirectory) || !isAbsolute(options.executable)) throw new Error('diagnostic paths must be absolute')
  mkdirSync(options.diagnosticsDirectory, { recursive: true })
  if (!lstatSync(options.diagnosticsDirectory).isDirectory() || lstatSync(options.diagnosticsDirectory).isSymbolicLink()) {
    throw new Error('diagnostic directory is unsafe')
  }
  const output = join(options.diagnosticsDirectory, 'collected')
  mkdirSync(output) // Never overwrite a prior collector result.
  const now = (options.now ?? new Date()).getTime()
  const uuidForFile = options.uuidForFile ?? machoUUIDs
  const issues: Array<{ phase: string; code: string }> = []
  let executable: string | undefined
  let identity: ProcessIdentity | undefined
  let binary: { path: string; bytes: number; sha256: string; uuids: readonly string[] } | undefined
  const symbols: { status: string; files: string[] } = { status: 'missing', files: [] }
  const reports: Array<{ name: string; bytes: number; sha256: string; capturedAtUTC: string }> = []
  const rejected: Array<{ name: string; reason: string }> = []
  try {
    const selected = realpathSync(options.executable)
    if (basename(selected) !== PROCESS_NAME) throw new Error('unexpected diagnostic executable')
    executable = selected
    identity = processIdentity(readRegular(join(options.diagnosticsDirectory, 'identity.json'), 16 * 1024), executable, now)
  } catch (error) { issues.push({ phase: 'identity', code: errorCode(error) }) }
  if (executable !== undefined) {
    try {
      const bytes = readRegular(executable, MAX_BINARY_BYTES)
      const path = join(output, PROCESS_NAME)
      writeFileSync(path, bytes)
      binary = { path: executable, bytes: bytes.length, sha256: sha256(bytes), uuids: [] }
      binary.uuids = [...uuidForFile(path)].sort()
      const dwarf = join(`${executable}.dSYM`, 'Contents', 'Resources', 'DWARF', PROCESS_NAME)
      const temporary = join(options.diagnosticsDirectory, 'symbol-dwarf.tmp')
      let temporaryCreated = false
      try {
        // Copy only the exact DWARF and Info.plist, never the surrounding build tree.
        for (const directory of [`${executable}.dSYM`, join(`${executable}.dSYM`, 'Contents'), join(`${executable}.dSYM`, 'Contents', 'Resources'), join(`${executable}.dSYM`, 'Contents', 'Resources', 'DWARF')]) {
          const stat = lstatSync(directory)
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe dSYM directory')
        }
        const dwarfBytes = readRegular(dwarf, MAX_BINARY_BYTES)
        const info = readRegular(join(`${executable}.dSYM`, 'Contents', 'Info.plist'), 64 * 1024)
        writeFileSync(temporary, dwarfBytes, { flag: 'wx' })
        temporaryCreated = true
        const uuids = [...uuidForFile(temporary)].sort()
        if (binary.uuids.length > 0 && JSON.stringify(uuids) === JSON.stringify(binary.uuids)) {
          const relative = `${PROCESS_NAME}.dSYM/Contents/Resources/DWARF/${PROCESS_NAME}`
          mkdirSync(join(output, `${PROCESS_NAME}.dSYM`, 'Contents', 'Resources', 'DWARF'), { recursive: true })
          writeFileSync(join(output, relative), dwarfBytes)
          symbols.files.push(relative)
          const infoRelative = `${PROCESS_NAME}.dSYM/Contents/Info.plist`
          writeFileSync(join(output, infoRelative), info)
          symbols.files.push(infoRelative)
          symbols.status = 'matched'
        } else symbols.status = 'uuid-unavailable-or-mismatched'
      } catch (error) {
        symbols.status = symbols.files.length === 0 ? 'unavailable' : 'partial'
        issues.push({ phase: 'symbols', code: errorCode(error) })
      }
      finally { if (temporaryCreated) rmSync(temporary, { force: true }) }
    } catch (error) { issues.push({ phase: 'binary', code: errorCode(error) }) }
  }
  if (identity !== undefined) {
    const started = timestamp(identity.startedAtUTC)
    for (const directory of options.reportDirectories ?? [join(homedir(), 'Library', 'Logs', 'DiagnosticReports'), '/Library/Logs/DiagnosticReports']) {
      let names: string[]
      try {
        const stat = lstatSync(directory)
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe report directory')
        names = readdirSync(directory).sort()
      } catch (error) { issues.push({ phase: 'report-directory', code: errorCode(error) }); continue }
      for (const name of names) {
        const suffix = name.endsWith('.ips') ? '.ips' : name.endsWith('.crash') ? '.crash' : undefined
        if (suffix === undefined || (!name.startsWith(`${PROCESS_NAME}-`) && !name.startsWith(`${PROCESS_NAME}_`))) continue
        try {
          const path = join(directory, name)
          const stat = lstatSync(path)
          if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs < started || stat.mtimeMs > now) {
            rejected.push({ name, reason: 'not-current-regular-report' }); continue
          }
          const bytes = readRegular(path, MAX_REPORT_BYTES, { started, ended: now })
          const report = reportIdentity(bytes, suffix)
          if (report.pid !== identity.pid || !isAbsolute(report.executablePath)
            || realpathSync(report.executablePath) !== identity.executablePath
            || report.capturedAt < started || report.capturedAt > now) {
            rejected.push({ name, reason: 'process-or-time-mismatch' }); continue
          }
          mkdirSync(join(output, 'reports'), { recursive: true })
          const destination = `${reports.length}-${name}`
          writeFileSync(join(output, 'reports', destination), bytes, { flag: 'wx' })
          reports.push({
            name: destination, bytes: bytes.length, sha256: sha256(bytes),
            capturedAtUTC: new Date(report.capturedAt).toISOString(),
          })
        } catch (error) { rejected.push({ name, reason: errorCode(error) }) }
      }
    }
  }
  const manifest = {
    schemaVersion: 1,
    kind: 'native-contract-failure-diagnostics',
    collectedAtUTC: new Date(now).toISOString(),
    run: options.run ?? null,
    identity: identity ?? null,
    status: identity === undefined ? 'identity-unavailable' : reports.length === 0 ? 'missing-matching-report' : 'collected',
    binary: binary ?? null,
    symbols,
    reports,
    rejected,
    issues,
  }
  writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory, executable] = process.argv.slice(2)
  if (process.argv.length !== 4 || directory === undefined || executable === undefined) {
    throw new Error('usage: collect-native-contract-diagnostics.ts <diagnostics-directory> <contract-executable>')
  }
  const result = collectNativeContractDiagnostics({
    diagnosticsDirectory: resolve(directory), executable: resolve(executable),
    run: { id: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      commit: process.env.GITHUB_SHA ?? null, job: process.env.GITHUB_JOB ?? null },
  })
  console.log(`Native contract diagnostics: ${result.status}; reports=${result.reports.length}`)
}
