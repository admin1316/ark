/** Conservative Phase 6 acceptance audit for the ARK intelligence upgrade. */

import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readRunContext, type ImmutableBoundaries } from './run-context.ts'

export type AcceptanceStatus = 'PASS' | 'UNKNOWN' | 'FAIL'

export interface AcceptanceCheck {
  readonly status: AcceptanceStatus
  readonly evidence: readonly string[]
  readonly reason?: string
}

export interface AcceptanceAudit {
  readonly overall: AcceptanceStatus
  readonly checks: Readonly<Record<string, AcceptanceCheck>>
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

const HASH_RE = /^[a-f0-9]{64}$/u
const CHECK_NAMES = [
  'sourceTruth', 'immutableRunContext', 'knowledgeGovernance', 'sessionReplay', 'runtimeRecovery',
  'smartnessMetrics', 'knowledgeUtility', 'crossSessionLeakage', 'privilegeEscalation',
  'rustDifferential', 'rustPerformance', 'orphanProcesses', 'sideEffectSafety',
  'highRiskUnknown', 'githubCi', 'candidateBuildRollback',
] as const

type CheckName = typeof CHECK_NAMES[number]

function check(status: AcceptanceStatus, evidence: string[], reason?: string): AcceptanceCheck {
  return { status, evidence, ...(reason === undefined ? {} : { reason }) }
}

function object(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${context} must be an object`)
  return value as Record<string, unknown>
}

function string(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${context} must be a non-empty string`)
  return value
}

function hash(value: unknown, context: string): string {
  const result = string(value, context)
  if (!HASH_RE.test(result)) throw new Error(`${context} must be a lowercase SHA-256`)
  return result
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
  const paths = gitFiles(root).filter(path => /^(packages|integrations|native|scripts)\//u.test(path)
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

function validImmutable(value: unknown): value is ImmutableBoundaries {
  try {
    const parsed = object(value, 'receipt.immutable')
    for (const key of ['goalHash', 'planHash', 'scopeHash', 'permissionsHash', 'securityThresholdHash', 'acceptanceHash', 'dataFormatHash', 'publishPolicyHash']) hash(parsed[key], `receipt.immutable.${key}`)
    if (!Number.isSafeInteger(parsed.stateVersion) || (parsed.stateVersion as number) < 0) return false
    return true
  } catch { return false }
}

function readReceipt(root: string, path: string, trustedAuthorityKeys: Readonly<Record<string, string>>): AcceptanceReceipt | null {
  try {
    const rel = safeRelativePath(root, path)
    const raw = object(JSON.parse(readFileSync(join(root, rel), 'utf8')) as unknown, 'receipt')
    if (raw.schemaVersion !== 1 || raw.kind !== 'ark-phase6-acceptance' || !validImmutable(raw.immutable)) return null
    const authorityId = string(raw.authorityId, 'receipt.authorityId')
    const keyPem = trustedAuthorityKeys[authorityId]
    if (keyPem === undefined) return null
    const artifactRefsRaw = raw.artifactRefs
    if (!Array.isArray(artifactRefsRaw)) return null
    const artifactRefs: ArtifactRef[] = []
    for (const [index, value] of artifactRefsRaw.entries()) {
      const item = object(value, `receipt.artifactRefs[${index}]`)
      artifactRefs.push({ path: safeRelativePath(root, string(item.path, 'artifact path')), sha256: hash(item.sha256, 'artifact sha256') })
    }
    const observations = object(raw.observations, 'receipt.observations')
    for (const name of CHECK_NAMES) {
      const observation = object(observations[name], `receipt.observations.${name}`)
      if ('status' in observation || 'pass' in observation || 'result' in observation) return null
      if (!Array.isArray(observation.evidenceRefs) || observation.evidenceRefs.length === 0) return null
      for (const ref of observation.evidenceRefs) {
        const relRef = safeRelativePath(root, string(ref, 'observation evidenceRef'))
        const artifact = artifactRefs.find(item => item.path === relRef)
        if (artifact === undefined || sha256(readFileSync(join(root, relRef))) !== artifact.sha256) return null
      }
    }
    const unsigned = {
      schemaVersion: 1 as const, kind: 'ark-phase6-acceptance' as const, authorityId,
      gitSha: string(raw.gitSha, 'receipt.gitSha'), profile: string(raw.profile, 'receipt.profile'),
      manifestHash: hash(raw.manifestHash, 'receipt.manifestHash'), sourceDigest: hash(raw.sourceDigest, 'receipt.sourceDigest'),
      profileDigest: hash(raw.profileDigest, 'receipt.profileDigest'), immutable: raw.immutable,
      artifactRefs, observations,
    }
    const signature = string(raw.signature, 'receipt.signature')
    if (!verifySignature(null, canonicalEvidencePayload(unsigned), createPublicKey(keyPem), Buffer.from(signature, 'base64'))) return null
    return { ...unsigned, signature }
  } catch { return null }
}

function derivedObservation(name: CheckName, raw: unknown): { status: AcceptanceStatus; reason: string } {
  const observation = object(raw, `observation.${name}`)
  const bool = (key: string): boolean | undefined => typeof observation[key] === 'boolean' ? observation[key] as boolean : undefined
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
  const number = (key: string): number | undefined => typeof observation[key] === 'number' && Number.isFinite(observation[key]) ? observation[key] as number : undefined
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
    const checks = Object.fromEntries(CHECK_NAMES.map(name => [name, check('UNKNOWN', [], `run context invalid: ${String(error)}`)])) as Record<string, AcceptanceCheck>
    return { overall: 'UNKNOWN', checks }
  }
  const checks: Record<string, AcceptanceCheck> = Object.fromEntries(CHECK_NAMES.map(name => [name, check('UNKNOWN', [], 'behavioral receipt not authenticated')]))
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
      const observation = object(receipt.observations[name], `observation.${name}`)
      const evidence = (observation.evidenceRefs as string[]).map(path => safeRelativePath(root, path))
      checks[name] = check(derived.status, [evidencePath, ...evidence], derived.reason)
    }
  }
  const statuses = Object.values(checks).map(item => item.status)
  return { overall: statuses.includes('FAIL') ? 'FAIL' : statuses.includes('UNKNOWN') ? 'UNKNOWN' : 'PASS', checks }
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  const evidencePath = process.argv[3]
  process.stdout.write(`${JSON.stringify(auditAcceptance(process.argv[2] ?? process.cwd(), evidencePath === undefined ? {} : { evidencePath }), null, 2)}\n`)
}
