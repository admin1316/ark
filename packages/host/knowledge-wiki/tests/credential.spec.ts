import { Context } from '@deepseek-ai/cordis'
import {
  CredentialProvider,
  credentialRef,
  type CredentialInfo,
  type CredentialKey,
  type CredentialRecord,
  type CredentialRecordEntry,
  type CredentialRecordInfo,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { afterEach, describe, expect, it } from 'vitest'
import KnowledgeWikiService from '../src/index.ts'

class MemoryCredentials extends CredentialProvider {
  private readonly values = new Map<CredentialRef, string>()

  constructor(ctx: Context, seed: Record<string, string>) {
    super(ctx)
    for (const [key, value] of Object.entries(seed)) this.values.set(credentialRef(key), value)
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'memory' })
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: this.values.has(ref), source: 'memory', writable: true })
  }

  override set(ref: CredentialRef, value: string): Promise<void> {
    this.values.set(ref, value)
    return Promise.resolve()
  }

  override unset(ref: CredentialRef): Promise<void> {
    this.values.delete(ref)
    return Promise.resolve()
  }

  // The record surface is unused by this fixture; absent records read as
  // "not configured" and writes are no-ops.
  override readRecord(_key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(undefined)
  }

  override describeRecord(_key: CredentialKey): Promise<CredentialRecordInfo> {
    return Promise.resolve({ configured: false, writable: true })
  }

  override listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve([])
  }

  override modifyRecord(
    _key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    return mutate(undefined)
  }

  override deleteRecord(_key: CredentialKey): Promise<void> {
    return Promise.resolve()
  }
}

describe('Knowledge Wiki credential resolution', () => {
  const contexts: Context[] = []
  afterEach(async () => Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())))

  it('resolves the configured reference for every operation instead of caching a secret', async () => {
    const first = ['sk', 'first-fixture', '1234567890'].join('-')
    const second = ['sk', 'second-fixture', '1234567890'].join('-')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(MemoryCredentials, { VISION_API_KEY: first })
    const service = new KnowledgeWikiService(ctx, {
      wikiRoot: '/tmp/wiki',
      mainRoot: '/tmp',
      credential: 'VISION_API_KEY',
      llmProvider: 'test',
      llmModel: 'test',
    }) as unknown as { resolveApiKey(): Promise<string> }

    await expect(service.resolveApiKey()).resolves.toBe(first)
    await ctx.credentials.set(credentialRef('VISION_API_KEY'), second)
    await expect(service.resolveApiKey()).resolves.toBe(second)
  })
})
