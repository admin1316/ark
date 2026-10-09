/** Shared test-only wiring to real artifact/proof owners, with no dispatch or production signing capability. */
import { createLearningArtifactOwner } from '../src/learning-artifacts.ts'
import { createReadOnlyLearningVerifier } from '../src/external-verifier-adapter.ts'
import type { LearningGraphOwner } from '../src/learning-graph-context.ts'
import * as S from '../src/learning-graph-schema.ts'
import { evaluateLearning } from '../src/learning-evaluation.ts'
import { validateSemanticReceipt } from '../src/verifier.ts'
import type { createLearningGraphFixture } from './learning-graph-fixture.ts'

/** Captured public anchors are synthetic; proof and bounded traversal behavior is production code. */
export function graphFixtureOwner(
  value: ReturnType<typeof createLearningGraphFixture>, currentJournal = value.currentJournal,
): LearningGraphOwner {
  const descriptor = value.descriptor
  const artifactOwner = createLearningArtifactOwner({ artifactRoot: value.artifacts.root,
    limits: { maxArtifactBytes: descriptor.maxArtifactBytes, maxArtifactsPerReceipt: descriptor.maxArtifactsPerReceipt,
      maxTotalArtifactBytes: descriptor.maxTotalArtifactBytes, maxArtifactGraphDepth: descriptor.maxArtifactGraphDepth,
      maxChildRequestBytes: descriptor.maxChildRequestBytes, maxChildResponseBytes: descriptor.maxChildResponseBytes,
      timeoutMs: descriptor.timeoutMs },
    evaluator: { authorityId: value.signers.evaluatorId, ...value.signers.evaluatorPublic },
    journal: { signerId: value.signers.journalId, ...value.signers.journalPublic },
  })
  const authority = createReadOnlyLearningVerifier({ descriptor,
    captureContext: value.captureContext, reducerSourceHash: value.reducerSourceHash })
  return { ...value.captureContext(), currentJournal, artifacts: artifactOwner.createTraversal(), proofs: artifactOwner.proofs,
    source: descriptor.sourceIdentity, profile: String(descriptor.profile), profileDigest: String(descriptor.profileDigest),
    mission: S.mission.parse(descriptor.mission), allowedDefinitions: descriptor.evaluator.allowedDefinitions,
    allowedInitiationCapabilities: descriptor.evaluator.allowedInitiationCapabilities,
    reducer: { sourceHash: value.reducerSourceHash, evaluate: evaluateLearning },
    validateSemanticReceipt: raw => validateSemanticReceipt(authority, raw) }
}
