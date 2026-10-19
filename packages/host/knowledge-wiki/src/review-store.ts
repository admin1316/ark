/**
 * Owns the byte bound and durable JSON encoding for `.llm-wiki/review.json`.
 * @module @deepseek-ai/dsh-knowledge-wiki/review-store
 */

import { atomicWriteFile, isMissingPathError, readRegularFileBounded } from './filesystem.ts'

/** Maximum encoded review store size, shared by every reader and writer. */
export const REVIEW_STORE_MAX_BYTES = 8 * 1024 * 1024

const encodedReviewStoreBrand: unique symbol = Symbol('EncodedReviewStore')

/** A review array encoded and byte-checked by this module. */
export type EncodedReviewStore = string & { readonly [encodedReviewStoreBrand]: true }

/** Read a review store within the shared byte bound, preserving absence as undefined.
 * @param path - Absolute path of `.llm-wiki/review.json`.
 * @returns The exact bounded bytes, or undefined when the file does not exist.
 * @throws On unsafe files, oversized input, or other filesystem failures.
 */
export function readReviewStore(path: string): Buffer | undefined {
  try {
    return readRegularFileBounded(path, REVIEW_STORE_MAX_BYTES)
  } catch (error) {
    if (isMissingPathError(error)) return undefined
    throw error
  }
}

/** Encode and bound the complete review array using its durable JSON format.
 * @param items - Complete review array to persist.
 * @returns Immutable serialized text accepted by `writeReviewStore`.
 * @throws When UTF-8 encoded JSON exceeds the shared review-store byte bound.
 */
export function encodeReviewStore(items: readonly unknown[]): EncodedReviewStore {
  const text = `${JSON.stringify(items, null, 2)}\n`
  if (Buffer.byteLength(text, 'utf8') > REVIEW_STORE_MAX_BYTES) {
    throw new Error(`review store exceeds ${REVIEW_STORE_MAX_BYTES} bytes`)
  }
  return text as EncodedReviewStore
}

/** Durably replace the store with the exact preflighted text.
 * @param path - Absolute path of `.llm-wiki/review.json`.
 * @param encoded - Full review array text returned by `encodeReviewStore`.
 * @throws On unsafe destinations or filesystem failures; errors after rename may leave the new bytes visible.
 */
export function writeReviewStore(path: string, encoded: EncodedReviewStore): void {
  atomicWriteFile(path, encoded)
}
