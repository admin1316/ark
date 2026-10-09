/** Conservative Phase 6 acceptance audit for the ARK intelligence upgrade. */

import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { readRunContext, type ImmutableBoundaries } from './run-context.ts'
import { asRecord, requireSha256, requireString } from './validation.ts'

type AcceptanceStatus = 'PASS' | 'UNKNOWN' | 'FAIL'

interface AcceptanceCheck {
  readonly status: AcceptanceStatus
  readonly evidence: readonly string[]
  readonly reason?: string
}

export interface AcceptanceAudit {
  readonly overall: AcceptanceStatus
  readonly checks: Readonly<Record<CheckName, AcceptanceCheck>>
  /** Presence of the requested audit artifacts, reported separately from behavioral proof. */
  readonly artifactCompleteness: AcceptanceCheck
}

/** A machine receipt is trusted only through a key supplied by the caller. */
export interface AcceptanceAuditOptions {
  readonly evidencePath?: string
  readonly trustedAuthorityKeys?: Readonly<Record<string, string>>
}

interface ArtifactRef {
  readonly path: string
  readonly sha256: string
}

export interface AcceptanceReceipt {
  readonly schemaVersion: 1
  readonly kind: 'ark-phase6-acceptance'
  readonly authorityId: string
  readonly gitSha: string
  readonly profile: string
  readonly manifestHash: string
  readonly sourceDigest: string
  readonly profileDigest: string
  readonly immutable: ImmutableBoundaries
  readonly artifactRefs: readonly ArtifactRef[]
  readonly observations: Readonly<Record<string, unknown>>
  readonly signature: string
}

const CHECK_NAMES = [
  'sourceTruth', 'immutableRunContext', 'knowledgeGovernance', 'sessionReplay', 'runtimeRecovery',
  'smartnessMetrics', 'knowledgeUtility', 'crossSessionLeakage', 'privilegeEscalation',
  'rustDifferential', 'rustPerformance', 'orphanProcesses', 'sideEffectSafety',
  'highRiskUnknown', 'githubCi', 'candidateBuildRollback',
] as const

type CheckName = typeof CHECK_NAMES[number]

const REQUIRED_ARTIFACTS = [
  'project-manifest.json',
  'progress.jsonl',
  'decision-log.md',
  'security-report.md',
  'rust-benchmark.json',
  'scripts/rust-migration/launcher-verifier-smoke.json',
  'scripts/rust-migration/native-knowledge-smoke.json',
  'scripts/rust-migration/external-verifier-runtime.json',
  'scripts/rust-migration/external-verifier-receipt.json',
  'scripts/rust-migration/candidate-ark-20261008-smoke.json',
  'scripts/rust-migration/official-stage-20261008.json',
  'docs/rust-migration/source-truth-report.md',
  'docs/rust-migration/profile-matrix.md',
  'docs/rust-migration/knowledge-runtime-report.md',
  'scripts/rust-migration/evaluate-learning.ts',
  'scripts/rust-migration/benchmark-knowledge-search.ts',
  'scripts/rust-migration/differential-replay.ts',
  'scripts/rust-migration/rust-boundary.ts',
  'scripts/rust-migration/process-isolation.ts',
  'packages/host/knowledge-wiki/src/rust-search-candidate.ts',
  'packages/host/knowledge-wiki/src/external-verifier-adapter.ts',
  'rust/knowledge-search-shadow/Cargo.toml',
] as const

function check(status: AcceptanceStatus, evidence: string[], reason?: string): AcceptanceCheck {
  return { status, evidence, ...(reason === undefined ? {} : { reason }) }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const objectValue = value as Record<string, unknown>
  return `{${Object.keys(objectValue).sort().filter(key => objectValue[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonicalJson(objectValue[key])}`).join(',')}}`
}

/** Canonical signed bytes; the signature itself is deliberately excluded. */
export function canonicalEvidencePayload(receipt: Omit<AcceptanceReceipt, 'signature'>): Buffer {
  return Buffer.from(canonicalJson(receipt), 'utf8')
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function gitFiles(root: string): string[] {
  try {
    const output = execFileSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'buffer' })
    return output.toString('utf8').split('\0').filter(Boolean)
  } catch { return [] }
}

/** Hash source inputs while excluding generated evidence and report material. */
export function currentSourceDigest(root: string): string | null {
  const paths = gitFiles(root).filter(path => /^(packages|integrations|native|scripts|rust)\//u.test(path)
    && !path.startsWith('scripts/rust-migration/evidence/'))
  if (paths.length === 0) return null
  const digest = createHash('sha256')
  for (const path of paths.sort()) {
    const bytes = readFileSync(join(root, path))
    digest.update(path).update('\0').update(bytes).update('\0')
  }
  return digest.digest('hex')
}

const PROFILE_FILES = [
  'integrations/jiuzhang/profile/package.json',
  'integrations/jiuzhang/profile/cordis.patch.yml',
  'integrations/jiuzhang/profile/pnpm-workspace.yaml',
  'integrations/jiuzhang/profile/runtime-identity-policy.json',
  'integrations/jiuzhang/profile/forbidden-runtime-packages.json',
  'packages/bundle/base/cordis.patch.yml',
  'packages/bundle/native-api-app/cordis.patch.yml',
] as const

export function currentProfileDigest(root: string): string | null {
  if (PROFILE_FILES.some(path => !existsSync(join(root, path)))) return null
  const digest = createHash('sha256')
  for (const path of PROFILE_FILES) digest.update(path).update('\0').update(readFileSync(join(root, path))).update('\0')
  return digest.digest('hex')
}

function safeRelativePath(root: string, candidate: string): string {
  if (isAbsolute(candidate) || candidate.includes('\0')) throw new Error('evidence path must be relative')
  const absolute = resolve(root, candidate)
  const rel = relative(root, absolute)
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('evidence path escapes repository')
  return rel
}

function artifactCompleteness(root: string): AcceptanceCheck {
  const missing = REQUIRED_ARTIFACTS.filter(path => !existsSync(join(root, path)))
  return missing.length === 0
    ? check('PASS', [...REQUIRED_ARTIFACTS], 'required audit artifacts are present')
    : check('UNKNOWN', [...REQUIRED_ARTIFACTS.filter(path => existsSync(join(root, path)))], `missing artifacts: ${missing.join(', ')}`)
}

function validImmutable(value: unknown): value is ImmutableBoundaries {
  try {
    const parsed = asRecord(value, 'receipt.immutable')
    for (const key of ['goalHash', 'planHash', 'scopeHash', 'permissionsHash', 'securityThresholdHash', 'acceptanceHash', 'dataFormatHash', 'publishPolicyHash']) requireSha256(parsed[key], `receipt.immutable.${key}`)
    if (!Number.isSafeInteger(parsed.stateVersion) || (parsed.stateVersion as number) < 0) return false
    return true
  } catch { return false }
}

function readReceipt(root: string, path: string, trustedAuthorityKeys: Readonly<Record<string, string>>): AcceptanceReceipt | null {
  try {
    const rel = safeRelativePath(root, path)
    const raw = asRecord(JSON.parse(readFileSync(join(root, rel), 'utf8')) as unknown, 'receipt')
    if (raw.schemaVersion !== 1 || raw.kind !== 'ark-phase6-acceptance' || !validImmutable(raw.immutable)) return null
    const authorityId = requireString(raw.authorityId, 'receipt.authorityId')
    const keyPem = trustedAuthorityKeys[authorityId]
    if (keyPem === undefined) return null
    const artifactRefsRaw = raw.artifactRefs
    if (!Array.isArray(artifactRefsRaw)) return null
    const artifactRefs: ArtifactRef[] = []
    for (const [index, value] of artifactRefsRaw.entries()) {
      const item = asRecord(value, `receipt.artifactRefs[${index}]`)
      artifactRefs.push({ path: safeRelativePath(root, requireString(item.path, 'artifact path')), sha256: requireSha256(item.sha256, 'artifact sha256') })
    }
    const observations = asRecord(raw.observations, 'receipt.observations')
    for (const name of CHECK_NAMES) {
      const observation = asRecord(observations[name], `receipt.observations.${name}`)
      if ('status' in observation || 'pass' in observation || 'result' in observation) return null
      if (!Array.isArray(observation.evidenceRefs) || observation.evidenceRefs.length === 0) return null
      for (const ref of observation.evidenceRefs) {
        const relRef = safeRelativePath(root, requireString(ref, 'observation evidenceRef'))
        const artifact = artifactRefs.find(item => item.path === relRef)
        if (artifact === undefined || sha256(readFileSync(join(root, relRef))) !== artifact.sha256) return null
      }
    }
    const unsigned = {
      schemaVersion: 1 as const, kind: 'ark-phase6-acceptance' as const, authorityId,
      gitSha: requireString(raw.gitSha, 'receipt.gitSha'), profile: requireString(raw.profile, 'receipt.profile'),
      manifestHash: requireSha256(raw.manifestHash, 'receipt.manifestHash'), sourceDigest: requireSha256(raw.sourceDigest, 'receipt.sourceDigest'),
      profileDigest: requireSha256(raw.profileDigest, 'receipt.profileDigest'), immutable: raw.immutable,
      artifactRefs, observations,
    }
    const signature = requireString(raw.signature, 'receipt.signature')
    if (!verifySignature(null, canonicalEvidencePayload(unsigned), createPublicKey(keyPem), Buffer.from(signature, 'base64'))) return null
    return { ...unsigned, signature }
  } catch { return null }
}

function derivedObservation(name: CheckName, raw: unknown): { status: AcceptanceStatus; reason: string } {
  const observation = asRecord(raw, `observation.${name}`)
  const bool = (key: string): boolean | undefined => typeof observation[key] === 'boolean' ? observation[key] : undefined
  const allBools = (keys: readonly string[]): { status: AcceptanceStatus; reason: string } => {
    const values = keys.map(key => bool(key))
    if (values.some(value => value === undefined)) return { status: 'UNKNOWN', reason: 'trusted behavioral receipt is absent or incomplete' }
    return values.every(value => value === true)
      ? { status: 'PASS', reason: 'signed behavioral evidence' }
      : { status: 'FAIL', reason: 'signed behavioral evidence records a failed acceptance condition' }
  }
  const zero = (key: string): { status: AcceptanceStatus; reason: string } => {
    const value = observation[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) return { status: 'UNKNOWN', reason: 'trusted behavioral receipt is absent or incomplete' }
    return value === 0
      ? { status: 'PASS', reason: 'signed zero-count probe' }
      : { status: 'FAIL', reason: `signed probe recorded ${String(value)} unsafe occurrences` }
  }
  const number = (key: string): number | undefined => typeof observation[key] === 'number' && Number.isFinite(observation[key]) ? observation[key] : undefined
  const unknown = (): { status: AcceptanceStatus; reason: string } => ({ status: 'UNKNOWN', reason: 'trusted behavioral receipt is absent or incomplete' })
  switch (name) {
    case 'sourceTruth': return allBools(['docsMatchSource', 'profileMatchesSource', 'runtimeMatchesProfile'])
    case 'immutableRunContext': return allBools(['boundToManifest', 'boundToGoalAndPlan'])
    case 'knowledgeGovernance': return allBools(['observeCandidateVerifyReviewTrialUtilityPromotionDowngradeExpireConflictRollback'])
    case 'sessionReplay': return allBools(['allModelVisibleKnowledgeHasReplayEvents'])
    case 'runtimeRecovery': {
      const recovery = allBools(['recoverySucceeded'])
      const orphan = zero('orphanProcesses')
      if (recovery.status === 'UNKNOWN' || orphan.status === 'UNKNOWN') return unknown()
      return recovery.status === 'PASS' && orphan.status === 'PASS' ? { status: 'PASS', reason: 'signed recovery and process-ownership evidence' } : { status: 'FAIL', reason: 'signed recovery evidence records a failed acceptance condition' }
    }
    case 'smartnessMetrics': {
      const repeatedErrorBase = number('repeatedErrorBaseline')
      const repeatedErrorCandidate = number('repeatedErrorCandidate')
      const utilityBase = number('utilityBaseline')
      const utilityCandidate = number('utilityCandidate')
      const successBase = number('verifiedSuccessBaseline')
      const successCandidate = number('verifiedSuccessCandidate')
      if ([repeatedErrorBase, repeatedErrorCandidate, utilityBase, utilityCandidate, successBase, successCandidate]
        .some(value => value === undefined)) return unknown()
      const errorBase = repeatedErrorBase as number
      const errorCandidate = repeatedErrorCandidate as number
      const utilityStart = utilityBase as number
      const utilityEnd = utilityCandidate as number
      const successStart = successBase as number
      const successEnd = successCandidate as number
      return errorCandidate < errorBase && utilityEnd > utilityStart && successEnd > successStart
        ? { status: 'PASS', reason: 'signed paired smartness outcome evidence' } : { status: 'FAIL', reason: 'signed paired smartness evidence does not meet the required direction' }
    }
    case 'knowledgeUtility': {
      const baseline = number('utilityBaseline')
      const candidate = number('utilityCandidate')
      if (baseline === undefined || candidate === undefined) return unknown()
      return candidate > baseline ? { status: 'PASS', reason: 'signed utility lift evidence' } : { status: 'FAIL', reason: 'signed utility evidence records no lift' }
    }
    case 'crossSessionLeakage': return zero('leakageCount')
    case 'privilegeEscalation': return zero('privilegeEscalationCount')
    case 'rustDifferential': return allBools(['preRegistered', 'currentOptimizedRustReplayMatches', 'realProductionBoundary'])
    case 'rustPerformance': return allBools(['preRegistered', 'endToEndThresholdsMet', 'realProductionBoundary', 'cancellationAndCrashRecoveryMeasured'])
    case 'orphanProcesses': return zero('orphanCount')
    case 'sideEffectSafety': return zero('duplicateIrreversibleSideEffects')
    case 'highRiskUnknown': return zero('highRiskUnknownCount')
    case 'githubCi': {
      const provider = observation.provider
      const runId = observation.runId
      const checks = allBools(['requiredChecksPassed'])
      if (provider === undefined || runId === undefined || checks.status === 'UNKNOWN') return unknown()
      return provider === 'github' && typeof runId === 'string' && runId.trim() !== '' && checks.status === 'PASS'
        ? { status: 'PASS', reason: 'signed GitHub CI run evidence' } : { status: 'FAIL', reason: 'signed CI evidence is not a successful GitHub run' }
    }
    case 'candidateBuildRollback': return allBools(['candidateBuildVerified', 'rollbackVerified'])
  }
}

/** Audit only signed, current, source/profile/goal-bound behavioral evidence. */
export function auditAcceptance(rootInput: string, options: AcceptanceAuditOptions = {}): AcceptanceAudit {
  const root = resolve(rootInput)
  let context
  try { context = readRunContext(root) } catch (error) {
    const checks = Object.fromEntries(CHECK_NAMES.map(name => [name, check('UNKNOWN', [], `run context invalid: ${String(error)}`)])) as Record<CheckName, AcceptanceCheck>
    return { overall: 'UNKNOWN', checks, artifactCompleteness: artifactCompleteness(root) }
  }
  const checks = Object.fromEntries(CHECK_NAMES.map(name => [name, check('UNKNOWN', [], 'behavioral receipt not authenticated')])) as Record<CheckName, AcceptanceCheck>
  const trusted = options.trustedAuthorityKeys ?? {}
  const evidencePath = options.evidencePath ?? 'phase6-acceptance.json'
  const receipt = readReceipt(root, evidencePath, trusted)
  if (receipt !== null && context.status === 'ready' && context.gitSha !== null
    && receipt.gitSha === context.gitSha && receipt.profile === context.profile
    && receipt.manifestHash === context.manifestHash
    && receipt.sourceDigest === currentSourceDigest(root)
    && receipt.profileDigest === currentProfileDigest(root)
    && canonicalJson(receipt.immutable) === canonicalJson(context.immutable)) {
    for (const name of CHECK_NAMES) {
      const derived = derivedObservation(name, receipt.observations[name])
      const observation = asRecord(receipt.observations[name], `observation.${name}`)
      const evidence = (observation.evidenceRefs as string[]).map(path => safeRelativePath(root, path))
      checks[name] = check(derived.status, [evidencePath, ...evidence], derived.reason)
    }
  }
  const statuses = Object.values(checks).map(item => item.status)
  return {
    overall: statuses.includes('FAIL') ? 'FAIL' : statuses.includes('UNKNOWN') ? 'UNKNOWN' : 'PASS',
    checks,
    artifactCompleteness: artifactCompleteness(root),
  }
}

/** Read only the caller-selected trust map; evidence cannot supply its own authority. */
function readTrustedAuthorityKeys(path: string): Readonly<Record<string, string>> {
  const maxBytes = 64 * 1024
  const before = lstatSync(path)
  if (!before.isFile()) throw new Error('trusted authority configuration must be a regular file')
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let raw: string
  try {
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > maxBytes) {
      throw new Error('trusted authority configuration must be an unchanged regular file of at most 64 KiB')
    }
    const bytes = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null)
      if (count === 0) break
      length += count
    }
    if (length > maxBytes) throw new Error('trusted authority configuration exceeds 64 KiB')
    raw = bytes.subarray(0, length).toString('utf8')
  } finally { closeSync(descriptor) }
  const entries = Object.entries(asRecord(JSON.parse(raw) as unknown, 'trusted authority configuration'))
  if (entries.length > 64) throw new Error('trusted authority configuration exceeds 64 authorities')
  const keys: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [authorityId, value] of entries) {
    if (authorityId.length === 0 || authorityId.length > 256 || /\s|[\u0000-\u001f\u007f]/u.test(authorityId)
      || typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 8192
      || !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----\s*$/u.test(value)) {
      throw new Error('trusted authority configuration requires authority IDs mapped to SPKI PEM public keys')
    }
    keys[authorityId] = createPublicKey(value).export({ type: 'spki', format: 'pem' }).toString()
  }
  return keys
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  try {
    const { values, positionals } = parseArgs({
      options: { 'trusted-authority-keys': { type: 'string' } }, allowPositionals: true,
    })
    if (positionals.length > 2) throw new Error('usage: audit-acceptance.ts [repo-root] [receipt-path] [--trusted-authority-keys caller-file]')
    const evidencePath = positionals[1]
    const keyPath = values['trusted-authority-keys']
    const result = auditAcceptance(positionals[0] ?? process.cwd(), {
      ...(evidencePath === undefined ? {} : { evidencePath }),
      ...(keyPath === undefined ? {} : { trustedAuthorityKeys: readTrustedAuthorityKeys(keyPath) }),
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`acceptance audit configuration failed: ${String(error)}\n`)
    process.exitCode = 1
  }
}
