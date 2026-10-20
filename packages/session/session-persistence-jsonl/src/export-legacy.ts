/** Offline conversion of complete session artifacts for Ark 3.1.2 rollback. */
import { Session } from '@deepseek-ai/dsh-session'
import { eventLines, scanLog, toHeaderLine, type JsonlCompression } from './format.ts'
import { decompressZstdFrame, scanZstdFrames } from './zstd.ts'

/**
 * Flatten new physical atomic records into the existing scalar JSONL encoding.
 * No source bytes or live profile are modified; torn/corrupt input is refused.
 * @param source - complete bytes copied from a stopped session artifact.
 * @param compression - explicit physical encoding of the source.
 * @returns plaintext scalar-event JSONL understood by Ark 3.1.2.
 */
export async function exportLegacySessionArtifact(source: Buffer, compression: JsonlCompression): Promise<string> {
  let plain = source
  if (compression === 'zstd') {
    const scan = scanZstdFrames(source)
    if (scan.tornStart !== undefined) throw new Error('rollback export requires a complete artifact; torn compressed tail was preserved')
    plain = Buffer.concat(await Promise.all(scan.frames.map(frame => decompressZstdFrame(source.subarray(frame.start, frame.end)))))
  }
  new TextDecoder('utf-8', { fatal: true }).decode(plain)
  const parsed = scanLog(plain)
  if (parsed.committedBytes !== plain.length) throw new Error('rollback export requires a complete artifact; corrupt or incomplete tail was preserved')
  Session.fromRestore(parsed.meta.id, parsed.events, parsed.meta)
  return `${JSON.stringify(toHeaderLine(parsed.meta))}\n${parsed.events.length === 0 ? '' : `${eventLines(parsed.events, false)}\n`}`
}
