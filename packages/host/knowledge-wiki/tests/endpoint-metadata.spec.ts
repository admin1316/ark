import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KNOWLEDGE_WIKI_ENDPOINT_METADATA } from '../src/index.ts'

describe('Knowledge Wiki strict endpoint metadata', () => {
  it('declares verifier authority and pending Native integration without registering a bypass', () => {
    expect(KNOWLEDGE_WIKI_ENDPOINT_METADATA.verifyCandidate).toEqual({
      endpoint: 'knowledgeWiki/verifyCandidate',
      owner: 'knowledgeWiki',
      transport: 'strict-remote',
      requiresVerifierAuthority: true,
      verifierAuthorityService: 'knowledgeWikiVerifierAuthority',
      sourceIdentitySchema: 'commit40+sourceDigest+dirtyDigest+buildDigest',
      nativeIntegration: 'pending',
    })
  })

  it('records that Native does not consume the new endpoint yet', () => {
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
    const nativeApi = readFileSync(
      join(repositoryRoot, 'integrations/jiuzhang/native/Sources/JiuzhangShellCore/ArkDomainAPI.swift'),
      'utf8',
    )
    expect(nativeApi).not.toContain('knowledgeWiki/verifyCandidate')
    expect(KNOWLEDGE_WIKI_ENDPOINT_METADATA.verifyCandidate.nativeIntegration).toBe('pending')
    const findingsStart = nativeApi.indexOf('public static func knowledgeFindings')
    const findingsEnd = nativeApi.indexOf('public static func knowledgeReviews', findingsStart)
    const findingsDecoder = nativeApi.slice(findingsStart, findingsEnd)
    expect(findingsDecoder).not.toMatch(/warnings|degraded|errorCode/u)
  })
})
