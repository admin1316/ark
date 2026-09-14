/**
 * Platform-resolved wiki archive invocations.
 *
 * The wiki export/import feature shells out to the platform archive tool:
 * zip(1)/unzip(1) on POSIX, PowerShell's Compress-Archive and the .NET
 * ZipFile reader on Windows. User-controlled paths travel through the
 * process environment, never through the command string, so they cannot
 * break out of the invocation.
 */

/** One resolved archive command: the argv parts and the env values it needs. */
export interface ArchiveInvocation {
  readonly command: string
  readonly args: string[]
  readonly env: Record<string, string>
}

/** The wiki inputs every export archives, in canonical order. */
export const ARCHIVE_INPUTS = ['wiki', 'raw', 'purpose.md', 'schema.md'] as const

/**
 * Build the export invocation for one platform.
 * @param inputs - Archive input paths, relative to the wiki root.
 * @param outPath - Destination zip path.
 * @param platform - The platform to resolve for; defaults to the running one.
 * @returns The command, argv, and env required to run the export.
 */
export function zipExportInvocation(
  inputs: readonly string[],
  outPath: string,
  platform: NodeJS.Platform = process.platform,
): ArchiveInvocation {
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-Command',
        "Compress-Archive -Path $env:ARK_WIKI_ZIP_INPUTS.Split(',') -DestinationPath $env:ARK_WIKI_ZIP_OUT -Force"],
      env: { ARK_WIKI_ZIP_INPUTS: inputs.join(','), ARK_WIKI_ZIP_OUT: outPath },
    }
  }
  return { command: 'zip', args: ['-r', '-q', outPath, ...inputs], env: {} }
}

/**
 * Build the list invocation for one wiki archive.
 * @param archivePath - The archive to enumerate.
 * @param platform - The platform to resolve for; defaults to the running one.
 * @returns The command, argv, and env required to list the entries.
 */
export function zipListInvocation(
  archivePath: string,
  platform: NodeJS.Platform = process.platform,
): ArchiveInvocation {
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-Command',
        'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::OpenRead($env:ARK_WIKI_ARCHIVE).Entries.FullName'],
      env: { ARK_WIKI_ARCHIVE: archivePath },
    }
  }
  return { command: 'unzip', args: ['-l', '--', archivePath], env: {} }
}

/**
 * Parse the entry listing produced by the platform list invocation.
 * @param raw - The raw stdout of the list command.
 * @param platform - The platform the list ran on; defaults to the running one.
 * @returns The archive entry names in their stored order.
 */
export function zipListEntries(raw: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') {
    return raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  }
  return raw.split('\n').slice(3, -2).map(line => line.trim().replace(/^.*\s/u, '')).filter(Boolean)
}
