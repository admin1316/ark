import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { auditAcceptance, canonicalEvidencePayload, currentProfileDigest, currentSourceDigest } from './audit-acceptance.ts'

const HASH = 'a'.repeat(64)

function runAuditCli(...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx/esm', join(import.meta.dirname, 'audit-acceptance.ts'), ...args], {
    cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8', timeout: 15_000,
  })
}

function cliAudit(...args: string[]) {
  const result = runAuditCli(...args)
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout) as ReturnType<typeof auditAcceptance>
}

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

    // These keys and observations belong only to this temporary fixture.
    const keyPath = join(root, 'caller-trust.json')
    writeFileSync(keyPath, JSON.stringify({ 'independent-authority': publicKey.export({ type: 'spki', format: 'pem' }).toString() }))
    expect(cliAudit(root, 'evidence/receipt.json').overall).toBe('UNKNOWN')
    const trustedArgs = [root, 'evidence/receipt.json', '--trusted-authority-keys', keyPath]
    const cli = cliAudit(...trustedArgs)
    expect(cli).toEqual(audit)
    expect(Object.keys(cli.checks)).toHaveLength(16)

    const { publicKey: wrongKey } = generateKeyPairSync('ed25519')
    writeFileSync(keyPath, JSON.stringify({ 'independent-authority': wrongKey.export({ type: 'spki', format: 'pem' }).toString() }))
    expect(cliAudit(...trustedArgs).overall).toBe('UNKNOWN')
    writeFileSync(keyPath, '{}')
    expect(cliAudit(...trustedArgs).overall).toBe('UNKNOWN')
    writeFileSync(keyPath, JSON.stringify({ 'independent-authority': publicKey.export({ type: 'spki', format: 'pem' }).toString() }))

    for (const path of ['packages/example/source.ts', profileFiles[1]!, 'project-manifest.json']) {
      const before = readFileSync(join(root, path))
      writeFileSync(join(root, path), Buffer.concat([before, Buffer.from(' ')]))
      expect(cliAudit(...trustedArgs).overall).toBe('UNKNOWN')
      writeFileSync(join(root, path), before)
    }
    const suppliedReceipt = JSON.parse(readFileSync(join(root, 'evidence/receipt.json'), 'utf8')) as Record<string, unknown>
    suppliedReceipt.trustedAuthorityKeys = JSON.parse(readFileSync(keyPath, 'utf8')) as unknown
    writeFileSync(join(root, 'evidence/receipt.json'), JSON.stringify(suppliedReceipt))
    expect(cliAudit(root, 'evidence/receipt.json').overall).toBe('UNKNOWN')
    const receiptAsTrust = runAuditCli(root, '--trusted-authority-keys', join(root, 'evidence/receipt.json'))
    expect(receiptAsTrust.status).toBe(1)
    expect(receiptAsTrust.stdout).toBe('')
    for (const trust of [
      { 'bad authority': publicKey.export({ type: 'spki', format: 'pem' }).toString() },
      { 'independent-authority': privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
    ]) {
      writeFileSync(keyPath, JSON.stringify(trust))
      const rejected = runAuditCli(...trustedArgs)
      expect(rejected.status).toBe(1)
      expect(rejected.stdout).toBe('')
    }
  })

  it.each([
    ['invalid JSON', '{'],
    ['array', '[]'],
    ['non-key field', '{"authority":true}'],
    ['invalid PEM', '{"authority":"not-a-key"}'],
    ['oversized file', ' '.repeat(64 * 1024 + 1)],
    ['too many authorities', JSON.stringify(Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`authority-${index}`, 'key'])))],
    ['oversized key', JSON.stringify({ authority: 'a'.repeat(8193) })],
  ])('rejects %s trust configuration before emitting an audit', (_name, content) => {
    const root = mkdtempSync(join(tmpdir(), 'ark-acceptance-cli-'))
    const keyPath = join(root, 'caller-trust.json')
    writeFileSync(keyPath, content)
    const result = runAuditCli(root, '--trusted-authority-keys', keyPath)
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('acceptance audit configuration failed:')
  })

  it('rejects missing explicit trust files, non-files, and malformed CLI arguments', () => {
    const root = mkdtempSync(join(tmpdir(), 'ark-acceptance-cli-'))
    for (const args of [
      [root, '--trusted-authority-keys', join(root, 'missing.json')],
      [root, '--trusted-authority-keys', root],
      [root, '--trusted-authority-keys'],
      [root, '--unknown-option'],
      [root, 'receipt.json', 'unexpected'],
    ]) {
      const result = runAuditCli(...args)
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('acceptance audit configuration failed:')
    }
  })

  it.skipIf(process.platform === 'win32')('rejects a trust file reached through a final-component symbolic link', () => {
    const root = mkdtempSync(join(tmpdir(), 'ark-acceptance-cli-'))
    const keyPath = join(root, 'caller-trust.json')
    writeFileSync(keyPath, '{}')
    const linked = join(root, 'linked-trust.json')
    symlinkSync(keyPath, linked)
    const result = runAuditCli(root, '--trusted-authority-keys', linked)
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
  })
})
