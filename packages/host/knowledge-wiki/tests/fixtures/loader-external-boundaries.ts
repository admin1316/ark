import type { Context } from '@deepseek-ai/cordis'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { KnowledgeWikiVerifierAuthority } from '../../src/verifier.ts'

/** Calls crossing external boundaries; the Loader regression never runs a model. */
export interface ExternalBoundaryCalls {
  verifier: number
  credentials: number
  llm: number
}

/**
 * Explicit test-only YAML entry for external interfaces. Product services,
 * agent/session ownership, tools, timers and persistence remain real plugins.
 * @param authority - Fixture signer for generic checks and historical read admission.
 * @param calls - Counters shared with the test, including unexpected model attempts.
 * @returns The fixture plugin namespace to resolve from the Loader import map.
 */
export function externalBoundariesFixture(
  authority: KnowledgeWikiVerifierAuthority,
  calls: ExternalBoundaryCalls,
) {
  return {
    name: 'knowledge-wiki-keyless-external-boundaries',
    apply(ctx: Context) {
      const unexpectedModelCall = (): never => {
        calls.llm++
        throw new Error('keyless Loader fixture forbids model calls')
      }
      ctx.provide('llm', {
        stream: unexpectedModelCall,
        prepareCall: unexpectedModelCall,
      } as unknown as LlmRuntime)
      ctx.provide('credentials', {
        resolve: () => {
          calls.credentials++
          return Promise.resolve(undefined)
        },
      })
      ctx.provide('knowledgeWikiVerifierAuthority', {
        ...authority,
        verifyCandidate(request, signal) {
          calls.verifier++
          return authority.verifyCandidate(request, signal)
        },
      } satisfies KnowledgeWikiVerifierAuthority)
    },
  }
}
