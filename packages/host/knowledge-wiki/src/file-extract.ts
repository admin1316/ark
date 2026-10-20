/** Strict UTF-8 text extraction shared by local and owned-worker consumers. */
import { readRegularFileBounded } from './filesystem.ts'

/**
 * Decode only supported, bounded UTF-8 text; reject binary containers even with a text suffix.
 * @param path - Source name used for explicit format admission.
 * @param bytes - Complete bounded source bytes.
 * @returns Validated text, or null for an unsupported extension.
 * @throws For Office/PDF, binary signatures, malformed UTF-8, controls, or oversized input.
 */
export function decodeKnowledgeText(path: string, bytes: Uint8Array): string | null {
  if (/\.(pdf|doc|docx|xls|xlsx|ppt|pptx|odt|epub)$/iu.test(path)) {
    throw new Error('Office/PDF import is unavailable until a verified text extractor is configured')
  }
  if (!/\.(md|markdown|txt|org|json|yaml|yml|html?|xml|csv|tsv|log)$/iu.test(path)) return null
  if (bytes.byteLength > 5 * 1024 * 1024) throw new Error('knowledge text exceeds the 5 MiB extraction limit')
  const signatures = [[0x50, 0x4b], [0x25, 0x50, 0x44, 0x46], [0xd0, 0xcf, 0x11, 0xe0], [0x1f, 0x8b]]
  if (signatures.some(signature => signature.every((value, index) => bytes[index] === value))) {
    throw new Error('binary container is not a supported knowledge text file')
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('knowledge text must contain valid UTF-8; original file was preserved')
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new Error('binary control characters are not supported knowledge text')
  }
  return text
}

/**
 * Read a regular, bounded text source without following a leaf symlink.
 * @param absolutePath - Absolute confined project file.
 * @returns Validated UTF-8 text, or null for an unsupported extension.
 */
export function extractFileText(absolutePath: string): Promise<string | null> {
  return Promise.resolve().then(() => {
    // Admission happens before I/O so unsupported Office files never start parsing.
    const admitted = decodeKnowledgeText(absolutePath, new Uint8Array())
    if (admitted === null) return null
    return decodeKnowledgeText(absolutePath, readRegularFileBounded(absolutePath, 5 * 1024 * 1024))
  })
}
