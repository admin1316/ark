/** Physical atomic groups expand before snapshot identity and transcript projection. */
import { decodeStorageRecord } from '@deepseek-ai/dsh-session'

/**
 * Preserve ordinary fixture bytes while expanding validated runtime atomic rows.
 * @param content - persisted or projected session JSONL.
 * @returns logical event lines, retaining the original final newline.
 */
export function expandAtomicSessionLog(content: string): string {
  return content.split('\n').flatMap((line) => {
    if (line.trim().length === 0) return [line]
    const record: unknown = JSON.parse(line)
    if (record === null || typeof record !== 'object' || !('type' in record) || record.type !== 'atomic-events') return [line]
    return decodeStorageRecord(record).map(event => JSON.stringify(event))
  }).join('\n')
}
