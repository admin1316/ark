/** Durable session events emitted when Wiki evidence reaches a model. */

import type { JsonValue } from '@deepseek-ai/dsh-session'

/** Shared provenance carried by Wiki retrieval and injection events. */
export interface KnowledgeSessionEventBase {
  /** Stable Wiki-relative knowledge identity. */
  knowledgeId: string
  /** Wiki-relative page or projection identity. */
  path: string
  /** Hash of the canonical tool value that produced the model-facing result. */
  resultHash: string
  /** Hash of the exact session-visible JSON value, when different from the page hash. */
  contentHash?: string
  /** Hash of the governed source content before tool rendering. */
  sourceContentHash?: string
  /** Calling tool identity. */
  tool: string
  /** Model call identity that caused the retrieval. */
  callId: string
  /** Session and project fence used for the lookup. */
  scope: { sessionId: string; projectId?: string; workspaceId?: string }
  /** The value is retained as an explicit JSON projection for deterministic replay. */
  value?: JsonValue
  /** Provenance fields bind the model-visible projection to governed source state. */
  sourceHash?: string
  trust?: 'low' | 'medium' | 'high'
  authority?: string
  evidenceRefs?: string[]
  verificationStatus?: 'observed' | 'candidate' | 'verified' | 'rejected' | 'conflict' | 'expired'
  expiresAt?: string | null
  conflicts?: string[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** A Wiki item was selected for a model-facing result. */
    'knowledge/retrieved': KnowledgeSessionEventBase & {
      kind: 'search' | 'page' | 'graph' | 'reviews' | 'files'
      allowed: boolean
      reason: 'ok' | 'scope-denied' | 'acl-denied' | 'expired' | 'conflict' | 'unverified'
    }
    /** A Wiki result was rendered into the model-visible tool result. */
    'knowledge/injected': KnowledgeSessionEventBase & {
      kind: 'search' | 'page' | 'graph' | 'reviews' | 'files'
      contentBytes: number
      truncated?: boolean
    }
  }
}
