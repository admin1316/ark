import { describe, expect, it } from 'vitest'
import { ARCHIVE_INPUTS, zipExportInvocation, zipListEntries, zipListInvocation } from '../src/archive.ts'

describe('platform archive invocations', () => {
  it('resolves the POSIX zip tooling with plain argv', () => {
    const inv = zipExportInvocation(ARCHIVE_INPUTS, '/tmp/out.zip', 'linux')
    expect(inv.command).toBe('zip')
    expect(inv.args).toEqual(['-r', '-q', '/tmp/out.zip', ...ARCHIVE_INPUTS])
    expect(inv.env).toEqual({})

    const list = zipListInvocation('/tmp/out.zip', 'linux')
    expect(list.command).toBe('unzip')
    expect(list.args).toEqual(['-l', '--', '/tmp/out.zip'])
  })

  it('resolves the windows PowerShell tooling with env-carried paths', () => {
    const inv = zipExportInvocation(ARCHIVE_INPUTS, 'C:\\tmp\\out.zip', 'win32')
    expect(inv.command).toBe('powershell.exe')
    expect(inv.args).toEqual(['-NoProfile', '-Command', expect.stringContaining('Compress-Archive')])
    // The user-controlled paths must travel through the environment so they
    // can never break out of the PowerShell command string.
    expect(inv.env.ARK_WIKI_ZIP_INPUTS).toBe(ARCHIVE_INPUTS.join(','))
    expect(inv.env.ARK_WIKI_ZIP_OUT).toBe('C:\\tmp\\out.zip')
    expect(inv.args.join(' ')).not.toContain('C:\\tmp')

    const list = zipListInvocation('C:\\tmp\\out.zip', 'win32')
    expect(list.command).toBe('powershell.exe')
    expect(list.args).toEqual(['-NoProfile', '-Command', expect.stringContaining('OpenRead')])
    expect(list.env.ARK_WIKI_ARCHIVE).toBe('C:\\tmp\\out.zip')
    expect(list.args.join(' ')).not.toContain('C:\\tmp')
  })

  it('parses each platform listing format through its own contract', () => {
    const posixListing = ['Archive:  a.zip', '  Length      Date    Name', '---------  ---------- -----', '     7  wiki/index.md', '     0  raw/', '---------', '        7                     2 files'].join('\n')
    expect(zipListEntries(posixListing, 'linux')).toEqual(['wiki/index.md', 'raw/'])

    const windowsListing = 'wiki/index.md\r\nraw/\r\n'
    expect(zipListEntries(windowsListing, 'win32')).toEqual(['wiki/index.md', 'raw/'])
  })
})
