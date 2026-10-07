import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { auditAcceptance, canonicalEvidencePayload, currentProfileDigest, currentSourceDigest } from './audit-acceptance.ts'

const HASH = 'a'.repeat(64)

function seedAcceptanceBaseline(root: string): void {
  mkdirSync(join(root, 'docs/rust-migration'), { recursive: true })
  for (const path of ['source-truth-report.md', 'profile-matrix.md', 'knowledge-runtime-report.md']) writeFileSync(join(root, 'docs/rust-migration', path), '# report\n')
  writeFileSync(join(root, 'project-manifest.json'), JSON.stringify({ schemaVersion: 1, projectId: 'ark', profile: 'test', immutable: {
    goalHash: HASH, planHash: HASH, scopeHash: HASH, permissionsHash: HASH, securityThresholdHash: HASH,
    acceptanceHash: HASH, dataFormatHash: HASH, publishPolicyHash: HASH, stateVersion: 1,
  } }))
}

function commitFixture(root: string): void {
  execFileSync('git', ['init', '-q', root])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Acceptance Test'])
  execFileSync('git', ['-C', root, 'add', '.'])
  execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture'])
}

describe('acceptance audit', () => {
  it('binds Rust source bytes into the source digest', () => {
    const root = mkdtempSync(join(tmpdir(), 'ark-rust-digest-'))
    mkdirSync(join(root, 'rust/example'), { recursive: true })
    writeFileSync(join(root, 'rust/example/main.rs'), 'fn main() {}\n')
    execFileSync('git', ['init', '-q', root])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid'])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Acceptance Test'])
    execFileSync('git', ['-C', root, 'add', '.'])
    execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture'])
    const before = currentSourceDigest(root)
    writeFileSync(join(root, 'rust/example/main.rs'), 'fn main() { println!("changed"); }\n')
    expect(currentSourceDigest(root)).not.toBe(before)
  })

  it('keeps final acceptance UNKNOWN when benchmark, security, or utility evidence is incomplete', () => {
    const root = mkdtempSync(join(tmpdir(), 'ark-acceptance-'))
    seedAcceptanceBaseline(root)
    mkdirSync(join(root, 'packages/host/knowledge-wiki/src'), { recursive: true })
    mkdirSync(join(root, 'packages/host/knowledge-wiki-tools/src'), { recursive: true })
    mkdirSync(join(root, 'scripts/rust-migration'), { recursive: true })
    writeFileSync(join(root, 'progress.jsonl'), '{}\n')
    writeFileSync(join(root, 'decision-log.md'), '# decisions\n')
    writeFileSync(join(root, 'packages/host/knowledge-wiki/src/knowledge-governance.ts'), '')
    writeFileSync(join(root, 'packages/host/knowledge-wiki-tools/src/session-events.ts'), '')
    writeFileSync(join(root, 'docs/persistence-catalog.md'), "'knowledge/injected'\n")
    writeFileSync(join(root, 'scripts/rust-migration/evaluate-learning.ts'), '')
    // A self-reported green benchmark is artifact content only; without an
    // authenticated receipt bound to the current source it cannot pass.
    writeFileSync(join(root, 'rust-benchmark.json'), JSON.stringify({ status: 'pass' }))
    writeFileSync(join(root, 'security-report.md'), '# UNKNOWN\n')
    const audit = auditAcceptance(root)
    expect(audit.overall).toBe('UNKNOWN')
    expect(audit.checks.smartnessMetrics.status).toBe('UNKNOWN')
    expect(audit.checks.rustPerformance.status).toBe('UNKNOWN')
    expect(audit.checks.sourceTruth.status).toBe('UNKNOWN')
    expect(audit.checks.knowledgeGovernance.status).toBe('UNKNOWN')
    expect(audit.checks.sessionReplay.status).toBe('UNKNOWN')
    expect(audit.checks.knowledgeUtility.status).toBe('UNKNOWN')
    expect(audit.checks.githubCi.status).toBe('UNKNOWN')
    expect(audit.artifactCompleteness.status).toBe('UNKNOWN')
  })

  it('ignores stale absolute-path evidence and a forged status field', () => {
    const root = mkdtempSync(join(tmpdir(), 'ark-acceptance-'))
    seedAcceptanceBaseline(root)
    writeFileSync(join(root, 'phase6-acceptance.json'), JSON.stringify({
      schemaVersion: 1,
      kind: 'ark-phase6-acceptance',
      authorityId: 'untrusted',
      gitSha: 'a'.repeat(40),
      profile: 'test',
      manifestHash: HASH,
      sourceDigest: HASH,
      profileDigest: HASH,
      immutable: {
        goalHash: HASH, planHash: HASH, scopeHash: HASH, permissionsHash: HASH,
        securityThresholdHash: HASH, acceptanceHash: HASH, dataFormatHash: HASH,
        publishPolicyHash: HASH, stateVersion: 1,
      },
      artifactRefs: [],
      observations: Object.fromEntries(['sourceTruth', 'immutableRunContext', 'knowledgeGovernance', 'sessionReplay', 'runtimeRecovery', 'smartnessMetrics', 'knowledgeUtility', 'crossSessionLeakage', 'privilegeEscalation', 'rustDifferential', 'rustPerformance', 'orphanProcesses', 'sideEffectSafety', 'highRiskUnknown', 'githubCi', 'candidateBuildRollback'].map(name => [name, { evidenceRefs: [], status: 'PASS' }])),
      signature: 'not-a-signature',
    }))
    const audit = auditAcceptance(root, { trustedAuthorityKeys: { untrusted: 'not-a-public-key' } })
    expect(audit.overall).toBe('UNKNOWN')
    expect(Object.values(audit.checks).every(item => item.status === 'UNKNOWN')).toBe(true)
  })

  it('accepts only a trusted receipt bound to the current source, profile, manifest, and goal', () => {
    const root = mkdtempSync(join(tmpdir(), 'ark-acceptance-'))
    const profileFiles = [
      'integrations/jiuzhang/profile/package.json', 'integrations/jiuzhang/profile/cordis.patch.yml',
      'integrations/jiuzhang/profile/pnpm-workspace.yaml', 'integrations/jiuzhang/profile/runtime-identity-policy.json',
      'integrations/jiuzhang/profile/forbidden-runtime-packages.json', 'packages/bundle/base/cordis.patch.yml',
      'packages/bundle/native-api-app/cordis.patch.yml',
    ]
    mkdirSync(join(root, 'packages/example'), { recursive: true })
    mkdirSync(join(root, 'native/example'), { recursive: true })
    mkdirSync(join(root, 'scripts/example'), { recursive: true })
    for (const path of profileFiles) {
      mkdirSync(join(root, dirname(path)), { recursive: true })
      writeFileSync(join(root, path), '{}\n')
    }
    writeFileSync(join(root, 'packages/example/source.ts'), 'export const source = true\n')
    const immutable = {
      goalHash: HASH, planHash: HASH, scopeHash: HASH, permissionsHash: HASH,
      securityThresholdHash: HASH, acceptanceHash: HASH, dataFormatHash: HASH, publishPolicyHash: HASH, stateVersion: 1,
    }
    writeFileSync(join(root, 'project-manifest.json'), JSON.stringify({ schemaVersion: 1, projectId: 'ark', profile: 'test', immutable }))
    commitFixture(root)
    mkdirSync(join(root, 'evidence'), { recursive: true })
    writeFileSync(join(root, 'evidence/probe.json'), '{"verified":true}\n')
    const artifactHash = createHash('sha256').update(readFileSync(join(root, 'evidence/probe.json'))).digest('hex')
    const observations: Record<string, Record<string, unknown>> = {
      sourceTruth: { docsMatchSource: true, profileMatchesSource: true, runtimeMatchesProfile: true },
      immutableRunContext: { boundToManifest: true, boundToGoalAndPlan: true },
      knowledgeGovernance: { observeCandidateVerifyReviewTrialUtilityPromotionDowngradeExpireConflictRollback: true },
      sessionReplay: { allModelVisibleKnowledgeHasReplayEvents: true },
      runtimeRecovery: { recoverySucceeded: true, orphanProcesses: 0 },
      smartnessMetrics: {
        repeatedErrorBaseline: 2, repeatedErrorCandidate: 1, utilityBaseline: 1,
        utilityCandidate: 2, verifiedSuccessBaseline: 1, verifiedSuccessCandidate: 2,
      },
      knowledgeUtility: { utilityBaseline: 1, utilityCandidate: 2 },
      crossSessionLeakage: { leakageCount: 0 }, privilegeEscalation: { privilegeEscalationCount: 0 },
      rustDifferential: { preRegistered: true, currentOptimizedRustReplayMatches: true, realProductionBoundary: true },
      rustPerformance: {
        preRegistered: true, endToEndThresholdsMet: true, realProductionBoundary: true,
        cancellationAndCrashRecoveryMeasured: true,
      },
      orphanProcesses: { orphanCount: 0 }, sideEffectSafety: { duplicateIrreversibleSideEffects: 0 },
      highRiskUnknown: { highRiskUnknownCount: 0 },
      githubCi: { provider: 'github', requiredChecksPassed: true, runId: 'run-1' },
      candidateBuildRollback: { candidateBuildVerified: true, rollbackVerified: true },
    }
    for (const value of Object.values(observations)) value.evidenceRefs = ['evidence/probe.json']
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const manifestBytes = readFileSync(join(root, 'project-manifest.json'))
    const unsigned = {
      schemaVersion: 1 as const, kind: 'ark-phase6-acceptance' as const, authorityId: 'independent-authority',
      gitSha: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), profile: 'test',
      manifestHash: createHash('sha256').update(manifestBytes).digest('hex'), sourceDigest: currentSourceDigest(root) as string,
      profileDigest: currentProfileDigest(root) as string, immutable, artifactRefs: [{ path: 'evidence/probe.json', sha256: artifactHash }], observations,
    }
    writeFileSync(join(root, 'evidence/receipt.json'), JSON.stringify({ ...unsigned, signature: sign(null, canonicalEvidencePayload(unsigned), privateKey).toString('base64') }))
    const audit = auditAcceptance(root, {
      evidencePath: 'evidence/receipt.json',
      trustedAuthorityKeys: { 'independent-authority': publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    })
    expect(audit.overall).toBe('PASS')
    expect(audit.checks.rustPerformance.status).toBe('PASS')
    expect(audit.checks.crossSessionLeakage.status).toBe('PASS')
  })
})
