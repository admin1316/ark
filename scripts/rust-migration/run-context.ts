/** Read-only run context and immutable-boundary checks for the ARK upgrade. */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

/** Fields that an automatic run may observe but never rewrite. */
export interface ImmutableBoundaries {
  readonly goalHash: string
  readonly planHash: string
  readonly scopeHash: string
  readonly permissionsHash: string
  readonly securityThresholdHash: string
  readonly acceptanceHash: string
  readonly dataFormatHash: string
  readonly publishPolicyHash: string
  readonly stateVersion: number
}

/** Minimal project manifest consumed before an automatic ARK run. */
interface ProjectManifest {
  readonly schemaVersion: 1
  readonly projectId: string
  readonly profile: string
  readonly immutable: ImmutableBoundaries
}

/** Evidence and hashes captured for one run; this object has no write methods. */
export interface RunContext {
  readonly status: 'ready' | 'missing-manifest'
  readonly root: string
  readonly gitSha: string | null
  readonly profile: string | null
  readonly manifestHash: string | null
  readonly immutable: ImmutableBoundaries | null
  readonly evidence: Readonly<Record<string, { readonly path: string; readonly sha256: string; readonly bytes: number }>>
  readonly missingEvidence: readonly string[]
}

const HASH_RE = /^[a-f0-9]{64}$/u

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function validateManifest(value: unknown): ProjectManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('project manifest must be an object')
  const raw = value as Record<string, unknown>
  if (raw.schemaVersion !== 1 || !nonEmpty(raw.projectId) || !nonEmpty(raw.profile)) throw new Error('project manifest header is invalid')
  if (typeof raw.immutable !== 'object' || raw.immutable === null || Array.isArray(raw.immutable)) throw new Error('project manifest immutable block is invalid')
  const immutable = raw.immutable as Record<string, unknown>
  for (const key of ['goalHash', 'planHash', 'scopeHash', 'permissionsHash', 'securityThresholdHash', 'acceptanceHash', 'dataFormatHash', 'publishPolicyHash']) {
    if (typeof immutable[key] !== 'string' || !HASH_RE.test(immutable[key])) throw new Error(`project manifest ${key} must be a SHA-256`)
  }
  if (!Number.isSafeInteger(immutable.stateVersion) || (immutable.stateVersion as number) < 0) throw new Error('project manifest stateVersion is invalid')
  return { schemaVersion: 1, projectId: raw.projectId, profile: raw.profile, immutable: immutable as unknown as ImmutableBoundaries }
}

function gitSha(root: string): string | null {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch { return null }
}

/** Read the immutable run manifest and available evidence without mutating it. */
export function readRunContext(rootInput: string, manifestPath = 'project-manifest.json'): RunContext {
  const root = resolve(rootInput)
  const manifest = join(root, manifestPath)
  if (!existsSync(manifest)) {
    return {
      status: 'missing-manifest', root, gitSha: gitSha(root), profile: null, manifestHash: null,
      immutable: null, evidence: {}, missingEvidence: [manifest],
    }
  }
  const manifestBytes = readFileSync(manifest)
  const parsed = validateManifest(JSON.parse(manifestBytes.toString('utf8')))
  const evidence: Record<string, { path: string; sha256: string; bytes: number }> = {}
  const missingEvidence: string[] = []
  for (const name of [
    'progress.jsonl',
    'decision-log.md',
    'rust-benchmark.json',
    'security-report.md',
    'scripts/rust-migration/launcher-verifier-smoke.json',
    'scripts/rust-migration/native-knowledge-smoke.json',
    'scripts/rust-migration/external-verifier-runtime.json',
    'scripts/rust-migration/external-verifier-receipt.json',
    'scripts/rust-migration/candidate-ark-20261008-smoke.json',
    'scripts/rust-migration/official-stage-20261008.json',
    'integrations/jiuzhang/profile/cordis.patch.yml',
    'packages/bundle/native-api-app/cordis.patch.yml',
    '.llm-wiki/knowledge-utility.json',
    'docs/rust-migration/source-truth-report.md',
    'docs/rust-migration/profile-matrix.md',
    'docs/rust-migration/knowledge-runtime-report.md',
  ]) {
    const path = join(root, name)
    if (!existsSync(path)) { missingEvidence.push(path); continue }
    const bytes = readFileSync(path)
    evidence[name] = { path, sha256: sha256(bytes), bytes: bytes.byteLength }
  }
  return {
    status: 'ready', root, gitSha: gitSha(root), profile: parsed.profile,
    manifestHash: sha256(manifestBytes), immutable: parsed.immutable, evidence, missingEvidence,
  }
}

/** Reject silent changes to goals, scope, policy, acceptance, formats, or versions. */
export function assertImmutableBoundaries(previous: ImmutableBoundaries, current: ImmutableBoundaries): void {
  for (const key of Object.keys(previous) as Array<keyof ImmutableBoundaries>) {
    if (previous[key] !== current[key]) throw new Error(`immutable run boundary changed: ${key}`)
  }
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  const context = readRunContext(process.argv[2] ?? process.cwd())
  process.stdout.write(`${JSON.stringify(context, null, 2)}\n`)
}
