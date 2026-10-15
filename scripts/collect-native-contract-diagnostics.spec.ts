import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectNativeContractDiagnostics } from './collect-native-contract-diagnostics.ts'

const processName = 'JiuzhangShellContractTests'
const startedAtUTC = '2026-10-15T08:00:00Z'
const capturedAtUTC = '2026-10-15T08:00:05Z'
const now = new Date('2026-10-15T08:00:10Z')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ark-native-diagnostics-')))
  roots.push(root)
  const diagnosticsDirectory = join(root, 'diagnostics')
  const reports = join(root, 'reports')
  const executable = join(root, processName)
  mkdirSync(diagnosticsDirectory)
  mkdirSync(reports)
  writeFileSync(executable, 'fake build binary')
  const identity = { schemaVersion: 1, pid: 4123, executablePath: executable, startedAtUTC }
  writeFileSync(join(diagnosticsDirectory, 'identity.json'), JSON.stringify(identity))
  return {
    root, diagnosticsDirectory, reports, executable, identity,
    options: { diagnosticsDirectory, executable, reportDirectories: [reports], now, uuidForFile: () => [] as string[] },
  }
}

function ips(executable: string, fields: Record<string, unknown> = {}) {
  return JSON.stringify({ pid: 4123, procPath: executable, captureTime: capturedAtUTC, ...fields })
}

function report(directory: string, name: string, bytes: string | Buffer, mtime = capturedAtUTC) {
  const path = join(directory, name)
  writeFileSync(path, bytes)
  utimesSync(path, new Date(mtime), new Date(mtime))
  return path
}

function symbols(executable: string) {
  const root = `${executable}.dSYM`
  mkdirSync(join(root, 'Contents', 'Resources', 'DWARF'), { recursive: true })
  writeFileSync(join(root, 'Contents', 'Resources', 'DWARF', processName), 'fake dwarf')
  writeFileSync(join(root, 'Contents', 'Info.plist'), '<plist/>')
}

describe('Native contract failure diagnostics', () => {
  it('copies current main-process IPS and legacy crash reports with exact byte hashes', () => {
    const f = fixture()
    const first = report(f.reports, `${processName}-current.ips`, ips(f.executable))
    const twoObjects = `${JSON.stringify({ timestamp: '2026-10-15 08:00:05.000 +0000' })}\n${JSON.stringify({ pid: 4123, procPath: f.executable })}`
    report(f.reports, `${processName}-header.ips`, twoObjects)
    report(f.reports, `${processName}_legacy.crash`, `Process: ${processName} [4123]\nPath: ${f.executable}\nDate/Time: 2026-10-15 08:00:05.000 +0000\n`)
    const run = { id: 'fixed-run', attempt: '1', commit: 'fixed-commit', job: 'macos-native' }
    const result = collectNativeContractDiagnostics({ ...f.options, run })
    expect(result.status).toBe('collected')
    expect(result.identity).toEqual(f.identity)
    expect(result.run).toEqual(run)
    expect(result.reports).toHaveLength(3)
    expect(result.rejected).toEqual([])
    const copied = result.reports.find(item => item.name.endsWith('-current.ips'))
    expect(copied?.sha256).toBe(createHash('sha256').update(readFileSync(first)).digest('hex'))
    expect(readFileSync(join(f.diagnosticsDirectory, 'collected', 'reports', copied!.name))).toEqual(readFileSync(first))
    expect(result.reports.every(item => item.capturedAtUTC === '2026-10-15T08:00:05.000Z')).toBe(true)
    expect(JSON.parse(readFileSync(join(f.diagnosticsDirectory, 'collected', 'manifest.json'), 'utf8'))).toEqual(result)
  })

  it.each([
    ['helper PID', { pid: 4124 }],
    ['old capture', { captureTime: '2026-10-15T07:59:59Z' }],
    ['future capture', { captureTime: '2026-10-15T08:00:11Z' }],
    ['relative executable', { procPath: processName }],
  ])('rejects a same-name report for %s', (_name, fields) => {
    const f = fixture()
    report(f.reports, `${processName}-wrong.ips`, ips(f.executable, fields))
    const result = collectNativeContractDiagnostics(f.options)
    expect(result.status).toBe('missing-matching-report')
    expect(result.reports).toEqual([])
    expect(result.rejected).toEqual([{ name: `${processName}-wrong.ips`, reason: 'process-or-time-mismatch' }])
  })

  it('rejects a different executable even when the basename and PID match', () => {
    const f = fixture()
    mkdirSync(join(f.root, 'other-build'))
    const other = join(f.root, 'other-build', processName)
    writeFileSync(other, 'other binary')
    report(f.reports, `${processName}-other.ips`, ips(other))
    const result = collectNativeContractDiagnostics(f.options)
    expect(result.reports).toEqual([])
    expect(result.rejected[0]?.reason).toBe('process-or-time-mismatch')
  })

  it('rejects old and future report file times even with current capture metadata', () => {
    const f = fixture()
    for (const [name, time] of [['old', '2026-10-15T07:59:59Z'], ['future', '2026-10-15T08:00:11Z']]) {
      report(f.reports, `${processName}-${name}.ips`, ips(f.executable), time)
    }
    const result = collectNativeContractDiagnostics(f.options)
    expect(result.reports).toEqual([])
    expect(result.rejected.map(item => item.reason)).toEqual(['not-current-regular-report', 'not-current-regular-report'])
  })

  it('records malformed and oversized reports without copying unrelated process reports', () => {
    const f = fixture()
    report(f.reports, `${processName}-malformed.ips`, '{broken')
    report(f.reports, `${processName}-oversize.ips`, Buffer.alloc(16 * 1024 * 1024 + 1, 32))
    report(f.reports, 'UnrelatedProcess-current.ips', ips(f.executable))
    const result = collectNativeContractDiagnostics(f.options)
    expect(result.reports).toEqual([])
    expect(result.rejected.map(item => item.name)).toEqual([`${processName}-malformed.ips`, `${processName}-oversize.ips`])
  })

  it.skipIf(process.platform === 'win32')('rejects a report symlink without copying its target', () => {
    const f = fixture()
    const target = report(f.root, 'unrelated.ips', ips(f.executable))
    symlinkSync(target, join(f.reports, `${processName}-link.ips`))
    const result = collectNativeContractDiagnostics(f.options)
    expect(result.reports).toEqual([])
    expect(result.rejected[0]?.reason).toBe('not-current-regular-report')
  })

  it('preserves an explicit identity gap and never collects reports when launch identity is absent', () => {
    const f = fixture()
    rmSync(join(f.diagnosticsDirectory, 'identity.json'))
    report(f.reports, `${processName}-current.ips`, ips(f.executable))
    const result = collectNativeContractDiagnostics(f.options)
    expect(result.status).toBe('identity-unavailable')
    expect(result.identity).toBeNull()
    expect(result.reports).toEqual([])
    expect(result.issues).toContainEqual({ phase: 'identity', code: 'ENOENT' })
    expect(result.binary?.sha256).toBe(createHash('sha256').update('fake build binary').digest('hex'))
  })

  it('retains the copied binary hash when the UUID probe throws', () => {
    const f = fixture()
    const result = collectNativeContractDiagnostics({ ...f.options, uuidForFile: () => { throw new Error('probe failed') } })
    expect(result.binary).toMatchObject({ bytes: 17, sha256: createHash('sha256').update('fake build binary').digest('hex'), uuids: [] })
    expect(result.issues).toContainEqual({ phase: 'binary', code: 'invalid-or-unavailable' })
  })

  it('copies only matching UUID symbols and removes its temporary probe file', () => {
    const f = fixture()
    symbols(f.executable)
    const result = collectNativeContractDiagnostics({ ...f.options, uuidForFile: () => ['FIXED-UUID:arm64'] })
    expect(result.symbols.status).toBe('matched')
    expect(result.symbols.files).toHaveLength(2)
    for (const path of result.symbols.files) expect(existsSync(join(f.diagnosticsDirectory, 'collected', path))).toBe(true)
    expect(existsSync(join(f.diagnosticsDirectory, 'symbol-dwarf.tmp'))).toBe(false)
  })

  it('does not copy mismatched UUID symbols', () => {
    const f = fixture()
    symbols(f.executable)
    const result = collectNativeContractDiagnostics({
      ...f.options, uuidForFile: path => [basename(path) === 'symbol-dwarf.tmp' ? 'OTHER:arm64' : 'BUILD:arm64'],
    })
    expect(result.symbols).toEqual({ status: 'uuid-unavailable-or-mismatched', files: [] })
    expect(existsSync(join(f.diagnosticsDirectory, 'collected', `${processName}.dSYM`))).toBe(false)
    expect(existsSync(join(f.diagnosticsDirectory, 'symbol-dwarf.tmp'))).toBe(false)
  })

  it('reports partial symbols when the second retained file cannot be written', () => {
    const f = fixture()
    symbols(f.executable)
    const result = collectNativeContractDiagnostics({
      ...f.options,
      uuidForFile: (path) => {
        if (basename(path) === 'symbol-dwarf.tmp') {
          mkdirSync(join(f.diagnosticsDirectory, 'collected', `${processName}.dSYM`, 'Contents', 'Info.plist'), { recursive: true })
        }
        return ['FIXED-UUID:arm64']
      },
    })
    expect(result.symbols.status).toBe('partial')
    expect(result.symbols.files).toEqual([`${processName}.dSYM/Contents/Resources/DWARF/${processName}`])
    expect(result.issues.some(issue => issue.phase === 'symbols')).toBe(true)
  })

  it('refuses to overwrite an earlier collection', () => {
    const f = fixture()
    const first = collectNativeContractDiagnostics(f.options)
    const manifestPath = join(f.diagnosticsDirectory, 'collected', 'manifest.json')
    const original = readFileSync(manifestPath)
    expect(() => collectNativeContractDiagnostics(f.options)).toThrow()
    expect(readFileSync(manifestPath)).toEqual(original)
    expect(JSON.parse(original.toString())).toEqual(first)
  })
})
