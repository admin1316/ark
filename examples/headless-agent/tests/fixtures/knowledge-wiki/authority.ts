import type { Context } from '@deepseek-ai/cordis'
import { verifierAuthority } from '../../../../../packages/host/knowledge-wiki/tests/verifier-authority-fixture.ts'
export const name = 'wiki-governance-external-verifier-fixture'
export function apply(ctx: Context): void { ctx.provide('knowledgeWikiVerifierAuthority', verifierAuthority()) }
