import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import KnowledgeWikiService from '../src/index.ts'
import { appendKnowledgeEvent, createKnowledgeEvent, readKnowledgeEventLog } from '../src/knowledge-governance.ts'
import { wikiTestConfig } from './config-fixture.ts'
import { seedHistoricalCanonicalKnowledge } from './historical-governed-fixture.ts'
import { verifierAuthority } from './verifier-authority-fixture.ts'

const roots: string[] = []
const contexts: Context[] = []
const pagePath = 'concepts/shared-repair.md'
const content = '---\ntype: concept\nstatus: canonical\ntitle: Shared repair\n---\n\nA shared repair must have exactly one authenticated owner.\n'

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function worldBytes(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  const visit = (directory: string): void => {
    files[relative(root, directory) + '/'] = 'directory'
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else files[relative(root, path)] = readFileSync(path).toString('base64')
    }
  }
  visit(root)
  return files
}

function fixture(reverse: boolean, terminal: 'canonical' | 'rejected' | 'rolled_back') {
  const root = mkdtempSync(join(tmpdir(), 'wiki-source-identity-'))
  roots.push(root)
  const wikiRoot = join(root, 'wiki')
  const authority = verifierAuthority()
  const ids = reverse ? ['second-owner', 'first-owner'] : ['first-owner', 'second-owner']
  for (const knowledgeId of ids) {
    seedHistoricalCanonicalKnowledge({ projectRoot: root, wikiRoot, path: pagePath, content, authority, knowledgeId })
  }
  const eventPath = join(root, '.llm-wiki', 'knowledge-events.jsonl')
  if (terminal !== 'canonical') {
    const prior = readKnowledgeEventLog(eventPath, authority)
    appendKnowledgeEvent(eventPath, createKnowledgeEvent(`knowledge/${terminal}`, 'second-owner', {
      projectId: root, visibility: 'project',
    }, {}, { seq: prior.length, previousEventHash: prior.at(-1)?.eventHash ?? null }))
  }
  mkdirSync(join(root, '.llm-wiki'), { recursive: true })
  writeFileSync(join(root, '.llm-wiki', 'knowledge-utility.json'), JSON.stringify({
    [pagePath]: { path: pagePath, retrievalHits: 99, successfulUses: 99, userCorrections: 0, utilityScore: 99 },
  }))
  const context = new Context()
  contexts.push(context)
  let credentialCalls = 0
  context.provide('knowledgeWikiVerifierAuthority', authority)
  context.provide('credentials', {
    async resolve() {
      credentialCalls++
      return undefined
    },
  })
  const service = new KnowledgeWikiService(context, wikiTestConfig({ mainRoot: root, wikiRoot, credential: 'FIXTURE_ONLY' }))
  return { root, service, credentialCalls: () => credentialCalls,
    scope: { projectId: root, workspaceId: root, sessionId: 'source-identity-reader' } }
}

describe('authenticated source ownership', () => {
  it.each(['Native', 'model'] as const)('rechecks correction authority after the %s search provider await', async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-source-search-race-'))
    roots.push(root)
    const wikiRoot = join(root, 'wiki')
    const authority = verifierAuthority()
    seedHistoricalCanonicalKnowledge({ projectRoot: root, wikiRoot, path: pagePath, content, authority })
    const context = new Context()
    contexts.push(context)
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => { enter = resolve })
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let credentialCalls = 0
    context.provide('knowledgeWikiVerifierAuthority', authority)
    context.provide('credentials', {
      async resolve() {
        credentialCalls++
        enter()
        await blocked
        return undefined
      },
    })
    const service = new KnowledgeWikiService(context, wikiTestConfig({
      mainRoot: root, wikiRoot, credential: 'FIXTURE_ONLY',
    }))
    await service.modelPageContent({ path: pagePath }, { projectId: root, sessionId: 'before-correction' })
    const pending = mode === 'Native'
      ? service.search({ query: 'shared repair' })
      : service.modelSearch({ query: 'shared repair' }, { projectId: root, sessionId: 'after-correction' })
    await entered
    expect(await service.recordKnowledgeOutcome({ paths: [pagePath], outcome: 'corrected' })).toBe(1)
    const correctedWorld = worldBytes(root)
    release()
    await expect(pending).resolves.toEqual([])
    expect(credentialCalls).toBe(1)
    expect(worldBytes(root)).toEqual(correctedWorld)
  })

  it.each([
    [false, 'canonical'], [true, 'canonical'],
    [false, 'rejected'], [true, 'rejected'],
    [false, 'rolled_back'], [true, 'rolled_back'],
  ] as const)('denies ambiguous ownership before projection or mutation (reverse=%s, second=%s)', async (reverse, terminal) => {
    const value = fixture(reverse, terminal)
    const before = worldBytes(value.root)
    const denied = 'ambiguous knowledge source ownership'

    await expect(value.service.modelPageContent({ path: pagePath }, value.scope)).rejects.toThrow(denied)
    await expect(value.service.modelSearch({ query: 'shared repair' }, value.scope)).rejects.toThrow(denied)
    await expect(value.service.modelList(value.scope)).rejects.toThrow(denied)
    await expect(value.service.modelGraph(value.scope)).rejects.toThrow(denied)
    await expect(value.service.modelReviews({}, value.scope)).rejects.toThrow(denied)
    await expect(value.service.search({ query: 'shared repair' })).resolves.toEqual([])
    await expect(value.service.pageContent({ path: pagePath })).resolves.toEqual({ path: pagePath, content: '' })
    await expect(value.service.knowledgeUtility()).rejects.toThrow(denied)
    for (const outcome of ['successful', 'corrected', 'neutral'] as const) {
      await expect(value.service.recordKnowledgeOutcome({ paths: [pagePath], outcome })).rejects.toThrow(denied)
    }
    expect(value.credentialCalls()).toBe(0)
    expect(worldBytes(value.root)).toEqual(before)
  })
})
