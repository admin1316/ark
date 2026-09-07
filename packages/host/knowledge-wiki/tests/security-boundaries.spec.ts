import { describe, expect, it } from 'vitest'
import { isBlockedNetworkAddress, normalizeWikiRelativePath } from '../src/index.ts'

describe('wiki path boundary', () => {
  it('accepts a normal relative page path', () => {
    expect(normalizeWikiRelativePath('/concepts/example.md')).toBe('concepts/example.md')
  })
  it.each(['../secret', 'concepts/../secret', 'concepts\\secret', '', 'concepts//x.md'])(
    'rejects unsafe path %s', (value) =>{  expect(() => normalizeWikiRelativePath(value)).toThrow() },
  )
})

describe('SSRF address gate', () => {
  it.each(['127.0.0.1', '10.0.0.2', '169.254.169.254', '172.16.0.1', '192.168.1.1', '::1', 'fd00::1'])(
    'blocks %s', (address) =>{  expect(isBlockedNetworkAddress(address)).toBe(true) },
  )
  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])(
    'allows public address %s', (address) =>{  expect(isBlockedNetworkAddress(address)).toBe(false) },
  )
})
