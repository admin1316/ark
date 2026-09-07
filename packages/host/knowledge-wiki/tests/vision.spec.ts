import { describe, expect, it } from 'vitest'
import { isImagePath } from '../src/vision.ts'

describe('isolated vision-stage path classification', () => {
  it('recognizes only supported image suffixes case-insensitively', () => {
    expect(isImagePath('/tmp/image.PNG')).toBe(true)
    expect(isImagePath('/tmp/image.jpeg')).toBe(true)
    expect(isImagePath('/tmp/image.svg')).toBe(true)
    expect(isImagePath('/tmp/image.txt')).toBe(false)
  })
})
