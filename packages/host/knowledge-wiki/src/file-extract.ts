/** Strict UTF-8 text extraction shared by local and owned-worker consumers. */
import { readRegularFileBounded } from './filesystem.ts'
import { createHash } from 'node:crypto'
import type { KnowledgeFileErrorCode } from './types.ts'

/** Permanent extraction rejection transported across the owned worker boundary. */
export class KnowledgeFileError extends Error {
  /** Stable rejection category used by the queue's permanent-failure policy. */
  readonly code: KnowledgeFileErrorCode
  /** Digest of the exact rejected bytes, when the failure followed a read. */
  readonly sourceHash: string | undefined

  constructor(code: KnowledgeFileErrorCode, message: string, sourceHash?: string) {
    super(message)
    this.name = 'KnowledgeFileError'
    this.code = code
    this.sourceHash = sourceHash
  }
}

/**
 * Validate the error-code field received from a worker or durable queue record.
 * @param value - Untrusted worker/state field.
 * @returns Whether the value names a permanent local extraction rejection.
 */
export function isKnowledgeFileErrorCode(value: unknown): value is KnowledgeFileErrorCode {
  return value === 'unsupported-format' || value === 'binary-content' || value === 'invalid-utf8'
    || value === 'source-too-large' || value === 'invalid-text' || value === 'empty-content'
}

/**
 * Identify the actual format/encoding/size admission policy used for extraction.
 * @returns SHA-256 of the decoder policy, permitting retries after a decoder change.
 */
export function knowledgeFilePolicyHash(): string {
  return createHash('sha256').update(decodeKnowledgeText.toString()).digest('hex')
}

/**
 * Decode only supported, bounded UTF-8 text; reject binary containers even with a text suffix.
 * @param path - Source name used for explicit format admission.
 * @param bytes - Complete bounded source bytes.
 * @param admissionOnly - Check the filename before I/O without treating the empty probe as file content.
 * @returns Validated text, or null for an unsupported extension.
 * @throws For Office/PDF, binary signatures, malformed UTF-8, controls, or oversized input.
 */
export function decodeKnowledgeText(path: string, bytes: Uint8Array, admissionOnly = false): string | null {
  // This decoder is copied into the owned worker; keep its error construction self-contained.
  const reject = (code: KnowledgeFileErrorCode, message: string): never => {
    throw Object.assign(new Error(message), { name: 'KnowledgeFileError', code })
  }
  if (/\.(pdf|doc|docx|xls|xlsx|ppt|pptx|odt|epub)$/iu.test(path)) {
    reject('unsupported-format', 'Office/PDF import is unavailable until a verified text extractor is configured')
  }
  if (!/\.(md|markdown|txt|org|json|yaml|yml|html?|xml|csv|tsv|log)$/iu.test(path)) return null
  if (admissionOnly) return ''
  if (bytes.byteLength > 5 * 1024 * 1024) reject('source-too-large', 'knowledge text exceeds the 5 MiB extraction limit')
  const signatures = [[0x50, 0x4b], [0x25, 0x50, 0x44, 0x46], [0xd0, 0xcf, 0x11, 0xe0], [0x1f, 0x8b]]
  if (signatures.some(signature => signature.every((value, index) => bytes[index] === value))) {
    reject('binary-content', 'binary container is not a supported knowledge text file')
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return reject('invalid-utf8', 'knowledge text must contain valid UTF-8; original file was preserved')
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    reject('invalid-text', 'binary control characters are not supported knowledge text')
  }
  if (text.trim() === '') reject('empty-content', 'knowledge source contains no usable text; original file was preserved')
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
    let bytes: Buffer | undefined
    try {
      const admitted = decodeKnowledgeText(absolutePath, new Uint8Array(), true)
      if (admitted === null) return null
      bytes = readRegularFileBounded(absolutePath, 5 * 1024 * 1024)
      return decodeKnowledgeText(absolutePath, bytes)
    } catch (error) {
      if (error instanceof Error && 'code' in error && isKnowledgeFileErrorCode(error.code)) {
        throw new KnowledgeFileError(error.code, error.message, bytes === undefined ? undefined : createHash('sha256').update(bytes).digest('hex'))
      }
      throw error
    }
  })
}
