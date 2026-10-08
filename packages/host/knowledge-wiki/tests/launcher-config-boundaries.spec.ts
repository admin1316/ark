import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import KnowledgeWikiService from '../src/index.ts'
import { wikiTestConfig } from './config-fixture.ts'

const contexts: Context[] = []
const roots: string[] = []
const keys = generateKeyPairSync('ed25519')
const config = {
  authorityId: 'launcher-owned', executable: process.execPath,
  publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  sourceIdentity: {
    commit: 'a'.repeat(40), sourceDigest: '1'.repeat(64), dirty: false,
    dirtyDigest: '2'.repeat(64), buildDigest: '3'.repeat(64),
  },
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function service(raw: string): KnowledgeWikiService {
  const root = mkdtempSync(join(tmpdir(), 'wiki-launcher-config-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  return new KnowledgeWikiService(ctx, wikiTestConfig({
    wikiRoot: join(root, 'wiki'), mainRoot: root, knowledgeVerifierConfig: raw,
  }))
}

describe('launcher-owned verifier configuration boundary', () => {
  it.each(['{broken', 'null', '[]', '"verifier"'])('fails load for malformed JSON authority: %s', (raw) => {
    expect(() => service(raw)).toThrow(/knowledgeVerifierConfig must be/u)
  })

  it.each([
    { authorityId: null }, { executable: null }, { publicKey: null }, { privateKey: null },
    { sourceIdentity: undefined }, { sourceIdentity: null }, { sourceIdentity: [] },
  ])('fails load when a launcher field is absent or has a wrong wire type: %j', (patch) => {
    expect(() => service(JSON.stringify({ ...config, ...patch }))).toThrow('missing launcher-owned verifier fields')
  })

  it.each(['command-line', [1]])('rejects verifier arguments that are not a list of strings: %j', (args) => {
    expect(() => service(JSON.stringify({ ...config, args }))).toThrow('args must be an array of strings')
  })

  it.each([{}, { args: [], timeoutMs: 1000 }])('accepts a launcher keypair and keeps the missing review unverified: %j', async (options) => {
    const owner = service(JSON.stringify({ ...config, ...options }))
    await expect(owner.verifyCandidate({ reviewId: 'absent', action: 'Promote' }, new AbortController().signal))
      .resolves.toEqual({ ok: false, evidence: [], errorCode: 'review-not-found' })
  })

  it('keeps a whitespace-only launcher configuration unavailable', async () => {
    const owner = service(' \n ')
    await expect(owner.verifyCandidate({ reviewId: 'absent', action: 'Promote' }, new AbortController().signal))
      .resolves.toEqual({ ok: false, evidence: [], errorCode: 'verifier-authority-unavailable' })
  })

  it('denies every model projection when the caller has no registered, matching project and session', async () => {
    const owner = service(JSON.stringify(config))
    const root = roots.at(-1)!
    for (const scope of [
      {}, { projectId: '', sessionId: 'session' },
      { projectId: root, workspaceId: join(root, 'different'), sessionId: 'session' },
      { projectId: root }, { projectId: join(root, 'unregistered'), sessionId: 'session' },
    ]) {
      await expect(owner.modelSearch({ query: 'claim' }, scope)).rejects.toThrow('knowledge scope is unavailable')
      await expect(owner.modelPageContent({ path: 'concepts/claim.md' }, scope)).rejects.toThrow('knowledge scope is unavailable')
      await expect(owner.modelList(scope)).rejects.toThrow('knowledge scope is unavailable')
      await expect(owner.modelGraph(scope)).rejects.toThrow('knowledge scope is unavailable')
      await expect(owner.modelReviews({}, scope)).rejects.toThrow('knowledge scope is unavailable')
    }
  })
})
