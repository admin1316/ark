import { describe, expect, it } from 'vitest'
import { matchesOwnKeyPattern } from '../src/index.ts'

describe('own-key patterns', () => {
  it('allows unrelated metadata and own undefined values', () => {
    expect(matchesOwnKeyPattern({ content: undefined, source: null, extra: 1 }, ['content', 'source'], ['message'])).toBe(true)
  })

  it('does not substitute an inherited required key or reject an inherited forbidden key', () => {
    const value = {}
    Object.setPrototypeOf(value, { content: 'inherited', message: 'inherited' })
    expect(matchesOwnKeyPattern(value, ['content'], ['message'])).toBe(false)
    Object.defineProperty(value, 'content', { value: undefined })
    expect(matchesOwnKeyPattern(value, ['content'], ['message'])).toBe(true)
  })

  it('rejects a current-looking own key even when its value is undefined', () => {
    expect(matchesOwnKeyPattern({ content: [], message: undefined }, ['content'], ['message'])).toBe(false)
  })

  it('inspects presence without invoking value getters', () => {
    const value = { get content(): never { throw new Error('must not read') } }
    expect(matchesOwnKeyPattern(value, ['content'], ['message'])).toBe(true)
  })

  it('supports null prototypes, symbols, and non-enumerable own keys', () => {
    const value = {}
    Object.setPrototypeOf(value, null)
    const key = Symbol('key')
    Object.defineProperty(value, key, { value: 1 })
    expect(matchesOwnKeyPattern(value, [key], [])).toBe(true)
    expect(matchesOwnKeyPattern(value, [], [key])).toBe(false)
  })

  it('checks forbidden keys before required keys and stops on the first mismatch', () => {
    const seen: PropertyKey[] = []
    const value = new Proxy({ blocked: true }, {
      getOwnPropertyDescriptor(target, key) {
        seen.push(key)
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
    })
    expect(matchesOwnKeyPattern(value, ['required'], ['absent', 'blocked', 'later'])).toBe(false)
    expect(seen).toEqual(['absent', 'blocked'])
    seen.length = 0
    expect(matchesOwnKeyPattern(value, ['missing', 'later'], ['absent'])).toBe(false)
    expect(seen).toEqual(['absent', 'missing'])
  })

  it('propagates property inspection failures', () => {
    const failure = new Error('inspection failed')
    const value = new Proxy({}, { getOwnPropertyDescriptor() { throw failure } })
    expect(() => matchesOwnKeyPattern(value, ['content'], [])).toThrow(failure)
  })

  it('accepts an empty pattern without inspecting the object', () => {
    const value = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('must not inspect') } })
    expect(matchesOwnKeyPattern(value, [], [])).toBe(true)
  })
})
