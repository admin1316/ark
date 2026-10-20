/** Independent knowledge routes; credentials remain owned by their provider. */
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import s from '@deepseek-ai/schemastery'

/** Persistable route selections, containing credential references only. */
export interface KnowledgeConnections {
  readonly textProvider: string
  readonly textModel: string
  readonly visionProvider: string
  readonly visionModel: string
  readonly embeddingProvider: string
  readonly embeddingBaseUrl: string
  readonly embeddingModel: string
  readonly embeddingCredential: string
}

/** Shared route defaults and credential roles for composition and native settings. */
export const knowledgeConnectionFields = {
  textProvider: s.string().default('deepseek-official'),
  textModel: s.string().default('deepseek-flash'),
  visionProvider: s.string().default(''),
  visionModel: s.string().default(''),
  embeddingProvider: s.string().default(''),
  embeddingBaseUrl: s.string().default(''),
  embeddingModel: s.string().default(''),
  embeddingCredential: s.string().role('credential-ref').default(''),
}

/** Native settings use the existing settings namespace and revision/CAS owner. */
export const knowledgeConnectionSchema: s<KnowledgeConnections> = s.object(knowledgeConnectionFields)

/**
 * Refuse incomplete routes before persisting or dispatching them.
 * @param value - Resolved settings or composition routes.
 * @throws When a route is incomplete or an embedding URL can redirect credentials implicitly.
 */
export function validateKnowledgeConnections(value: KnowledgeConnections): void {
  for (const fields of [
    [value.textProvider, value.textModel],
    [value.visionProvider, value.visionModel],
    [value.embeddingProvider, value.embeddingBaseUrl, value.embeddingModel, value.embeddingCredential],
  ]) {
    if (fields.some(field => field !== '') && fields.some(field => field.trim() === '')) {
      throw new Error('knowledge-wiki: configure every field of a route, or clear the complete route')
    }
  }
  if (value.embeddingBaseUrl !== '') {
    credentialRef(value.embeddingCredential)
    const url = new URL(value.embeddingBaseUrl)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('knowledge-wiki: embedding endpoint must be HTTP(S) without URL credentials, query, or fragment')
    }
    if (url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) {
      throw new Error('knowledge-wiki: embedding endpoint requires HTTPS except for a local test endpoint')
    }
  }
}
