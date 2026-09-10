/**
 * Cooperative local text extraction. Office/PDF parsing is deliberately
 * refused here and must run through the injected owned stage executor.
 * @module @deepseek-ai/dsh-knowledge-wiki/file-extract
 */

import { readFile } from 'node:fs/promises'

const OFFICE_EXTENSIONS = /\.(pdf|docx|xlsx|pptx|odt|epub)$/i
const TEXT_EXTENSIONS = /\.(md|markdown|txt|org|json|yaml|yml|html?|xml|csv|tsv|log)$/i

/**
 * Extract readable text from one project file.
 * @param absolutePath - absolute filesystem path.
 * @returns extracted text, or null when the format is unsupported.
 */
export async function extractFileText(absolutePath: string): Promise<string | null> {
  if (TEXT_EXTENSIONS.test(absolutePath)) {
    return readFile(absolutePath, 'utf8')
  }
  if (OFFICE_EXTENSIONS.test(absolutePath)) {
    throw new Error('Office/PDF extraction requires an injected owned stage executor')
  }
  return null
}
