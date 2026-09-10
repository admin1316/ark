import { expect, it } from 'vitest'
import { formatFetchOutput, formatFetchOutputState } from '../src/index.ts'

it('keeps Native body truncation separate from model framing and retains the untrusted-content notice', () => {
  const result = { url: 'https://example.com/path', statusCode: 200, body: { kind: 'text' as const, content: 'short body' }, truncated: false }
  const formatted = formatFetchOutputState(result, 20)
  expect(formatted.markdown).toBe('short body')
  expect(formatted.markdownTruncated).toBe(false)
  expect(formatted.truncated).toBe(true)
  expect(formatted.text.length).toBeLessThanOrEqual(20)
  const full = formatFetchOutputState(result, 10_000)
  expect(full.text).toBe(formatFetchOutput(result, 10_000))
  expect(full.text.length).toBeGreaterThan(full.markdown.length)
})

it('does not cache mutable caller-owned values and caps both projections', () => {
  const result = { url: 'https://example.com', statusCode: 200, body: { kind: 'text' as const, content: 'first' }, truncated: false }
  expect(formatFetchOutputState(result, 1000).markdown).toBe('first')
  result.body.content = 'second'
  expect(formatFetchOutputState(result, 1000).markdown).toBe('second')
  Object.freeze(result.body)
  Object.freeze(result)
  expect(formatFetchOutputState(result, 3)).toMatchObject({ markdown: 'sec', markdownTruncated: true, truncated: true })
  expect(formatFetchOutputState(result, 3)).toEqual(formatFetchOutputState(result, 3))
  expect(formatFetchOutputState(result, 0)).toMatchObject({ text: '', markdown: '', markdownTruncated: true })
  expect(() => formatFetchOutputState(result, -1)).toThrow('non-negative safe integer')
})
