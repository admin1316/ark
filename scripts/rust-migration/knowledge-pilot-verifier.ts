/** Fixed-project, ephemeral-test-only verifier program for the existing external authority adapter. */

import assert from 'node:assert/strict'
import { createPrivateKey, sign, type KeyObject } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import { seatbeltProfileArgs } from '../../packages/sandbox/sandbox-local/src/profiles.ts'
import z from 'zod'
import { atomicWriteFile, readRegularFileBounded, resolveConfinedPath } from '../../packages/host/knowledge-wiki/src/filesystem.ts'
import { createFileMeasuredTrialArtifactResolver } from '../../packages/host/knowledge-wiki/src/measured-trial.ts'
import { canonicalJson, sha256, type IndependentVerificationResult } from '../../packages/host/knowledge-wiki/src/verifier.ts'
import { invoiceOracle, singleLineOracle, type TaskOracleResult } from './knowledge-task-oracles.ts'
import { isolatedChildEnvironment } from './process-isolation.ts'

const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const relativePath = z.string().min(1).max(1024).refine(value => !isAbsolute(value) && !value.includes('\\')
  && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'))
const frozenFile = z.object({ path: relativePath, hash }).strict()
const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  mode: z.literal('ephemeral-test-only'),
  authorityId: z.string().regex(/^pilot-test:[A-Za-z0-9._:-]{1,140}$/u),
  projectRoot: z.string().refine(isAbsolute),
  artifactRoot: z.string().refine(isAbsolute),
  expectedRequestHash: hash,
  acceptedRuleHash: hash,
  task: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('invoice-v1'), invoices: frozenFile, rates: frozenFile, outputHash: hash }).strict(),
    z.object({ kind: z.literal('single-line-v1'), terms: frozenFile, outputHash: hash }).strict(),
    z.object({ kind: z.literal('pagination-v1'), code: frozenFile,
      protectedFiles: z.array(frozenFile).min(1), timeoutMs: z.number().int().min(1).max(120_000) }).strict(),
  ]),
}).strict()

/** Launcher-owned fixed pilot manifest; production signing and arbitrary tasks are excluded. */
export type KnowledgePilotManifest = z.infer<typeof manifestSchema>

/** Owner-only physical projection; the original manifest root remains the logical source. */
export interface KnowledgePilotExecutionRoot {
  readonly logicalProjectRoot: string
  readonly physicalProjectRoot: string
  readonly files: readonly { readonly path: string; readonly hash: string }[]
}

/** Add the pilot-only OS network fence; unsupported platforms refuse instead of running with egress. */
export function confinePilotNetwork(argv: readonly string[], platform: NodeJS.Platform): string[] {
  assert(platform === 'darwin', 'pagination pilot network confinement is only implemented on macOS')
  const profile = seatbeltProfileArgs({ mode: 'read-only', workspaceRoot: '/' })[1]
  assert((argv[0] === 'sandbox-exec' || argv[0] === '/usr/bin/sandbox-exec') && argv[1] === '-p'
    && argv[2] === profile, 'pagination pilot requires the existing exact read-only Seatbelt profile')
  // macOS refuses a second sandbox_apply; extend this one recognized profile, preserving every file rule.
  return ['/usr/bin/sandbox-exec', '-p', `${profile} (deny network*)`, ...argv.slice(3)]
}

async function paginationCheck(
  code: Buffer, timeoutMs: number, subprocess: SubprocessRuntime, sandbox: SandboxProvider, signal: AbortSignal,
  execution?: KnowledgePilotExecutionRoot & { readonly codePath: string },
): Promise<TaskOracleResult> {
  const root = execution === undefined ? await realpath(await mkdtemp(join(tmpdir(), 'ark-reviewed-pagination-'))) : await
  realpath(execution.physicalProjectRoot)
  try {
    const target = execution === undefined ? join(root, 'paginate.ts') : resolveConfinedPath(root, execution.codePath, false)
    if (execution === undefined) await writeFile(target, code, { flag: 'wx', mode: 0o400 })
    else assert(readRegularFileBounded(target, 2 * 1024 * 1024).equals(code), 'actual captured code bytes differ')
    const oracle = new URL(import.meta.url.endsWith('.ts') ? './knowledge-task-oracles.ts' : './knowledge-task-oracles.mjs',
      import.meta.url)
    const wikiSource = resolve(import.meta.dirname, '../../packages/host/knowledge-wiki/src')
    const reads = execution === undefined ? [root] : execution.files.map(file => resolveConfinedPath(root, file.path, false))
    const argv = [process.execPath, '--permission', ...reads.map(path => `--allow-fs-read=${path}`), `--allow-fs-read=${fileURLToPath(oracle)}`,
      `--allow-fs-read=${wikiSource}`, '--no-addons', '--input-type=module']
    const confined = sandbox.confine(argv, { mode: 'read-only', workspaceRoot: root })
    assert(confined.enforcement === 'full', 'pagination pilot requires full file-effect confinement')
    const program = `import { paginationOracle } from ${JSON.stringify(oracle.href)};\n`
      + 'let module; let result;\n'
      + `try { module = await import(${JSON.stringify(pathToFileURL(target).href)}); }\n`
      + 'catch (error) { if (!(error instanceof SyntaxError) && error && typeof error === "object" && "code" in error) throw error; result = {result:"fail",checks:0,expected:"loadable paginate export",detail:"registered module failed to load"}; }\n'
      + 'if (!result && typeof module.paginate !== "function") result = {result:"fail",checks:0,expected:"callable paginate export",detail:"registered module has no paginate function"};\n'
      + 'process.stdout.write(JSON.stringify(result ?? paginationOracle(module.paginate)));\n'
    const deadline = AbortSignal.timeout(timeoutMs)
    const active = AbortSignal.any([signal, deadline])
    const child = subprocess.spawn({ argv: confinePilotNetwork(confined.argv, process.platform), cwd: root,
      env: isolatedChildEnvironment(), graceMs: 100, signal: active,
      stdio: { stdin: { data: program }, stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 16 * 1024 } } })
    try {
      const outcome = await child.done
      assert(await child.waitForExit(), 'pagination process tree did not exit')
      active.throwIfAborted()
      const stdout = child.collected.stdout?.readFrom(0)
      const stderr = child.collected.stderr?.readFrom(0)
      assert(stdout !== undefined && stderr !== undefined, 'pagination owner provided no collected output')
      assert(outcome.exitCode === 0 && !stdout.lossy && !stderr.lossy,
        `pagination command failed or output was incomplete: ${stderr.text}`)
      return z.object({ result: z.enum(['pass', 'fail']), checks: z.number().int().nonnegative(), expected: z.string(), detail:
        z.string() })
        .strict().parse(JSON.parse(stdout.text) as unknown)
    } finally {
      child.terminate()
      await child.done.catch(() => {})
      assert(await child.waitForExit(), 'pagination process tree survived teardown')
    }
  } finally { if (execution === undefined) await rm(root, { recursive: true, force: true }) }
}

/**
 * Recheck the fixed registration and task artifacts without receiving signing material.
 * @param rawManifest - Launcher-owned frozen manifest.
 * @param payload - Exact preregistered verification request.
 * @param subprocess - Existing process-tree owner.
 * @param sandbox - Enforcing read-only sandbox for pagination.
 * @param signal - Operation cancellation.
 * @returns Unsigned existing-v1 verification facts for the protected evaluator owner.
 */
export async function verifyKnowledgePilotEvidence(
  rawManifest: unknown, payload: unknown,
  subprocess: SubprocessRuntime, sandbox: SandboxProvider, signal: AbortSignal, execution?: KnowledgePilotExecutionRoot,
  writeNewArtifact?: (bytes: Buffer) => Promise<void>,
): Promise<Omit<IndependentVerificationResult, 'proof'>> {
  const manifest = manifestSchema.parse(rawManifest)
  const manifestHash = sha256(canonicalJson(manifest))
  assert(execution === undefined || (execution.logicalProjectRoot === manifest.projectRoot
    && isAbsolute(execution.physicalProjectRoot)), 'physical execution projection differs from logical manifest root')
  const executionRoot = execution?.physicalProjectRoot ?? manifest.projectRoot
  const readProject = (path: string, expectedHash: string) => {
    if (execution !== undefined) assert(execution.files.filter(file => file.path === path && file.hash === expectedHash).length === 1,
      'oracle attempted an unregistered physical projection file')
    const bytes = readRegularFileBounded(resolveConfinedPath(executionRoot, path, false), 2 * 1024 * 1024)
    if (execution !== undefined) assert(sha256(bytes) === expectedHash, 'physical projection file changed')
    return bytes
  }
  const programIdentity = () => ({
    verifierSourceHash: sha256(readRegularFileBounded(import.meta.filename, 2 * 1024 * 1024)),
    oracleSourceHash: sha256(readRegularFileBounded(fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './knowledge-task-oracles.ts' :
      './knowledge-task-oracles.mjs', import.meta.url)), 2 * 1024 * 1024)),
  })
  const frozenPrograms = programIdentity()
  const input = z.object({ schemaVersion: z.literal(1), operation: z.literal('verifyCandidate'),
    request: z.record(z.string(), z.unknown()) }).strict().parse(payload)
  const request = input.request
  assert(request['schemaVersion'] === 2 && sha256(canonicalJson(request)) === manifest.expectedRequestHash,
    'verifier request was not preregistered')
  signal.throwIfAborted()
  const resolver = createFileMeasuredTrialArtifactResolver(manifest.artifactRoot)
  const readFrozen = (file: z.infer<typeof frozenFile>): Buffer => {
    const bytes = readProject(file.path, file.hash)
    assert(sha256(bytes) === file.hash, `frozen task file changed: ${file.path}`)
    return bytes
  }
  const candidatePath = z.string().startsWith('_candidates/').parse(request['candidatePath'])
  const candidate = readProject(`.llm-wiki/${candidatePath}`, hash.parse(request['candidateHash']))
  assert(sha256(candidate) === request['candidateHash'], 'actual Candidate differs from the preregistered request')
  const ruleCovered = sha256(candidate) === manifest.acceptedRuleHash
  const sourceReports: Record<string, unknown>[] = []
  const frozen = (file: z.infer<typeof frozenFile>): Buffer => {
    const bytes = readFrozen(file)
    sourceReports.push({ path: file.path, hash: file.hash, ...(execution === undefined ? {} : { originalPath:
      resolveConfinedPath(manifest.projectRoot, file.path, true), executionPath: resolveConfinedPath(executionRoot, file.path, false) }) })
    return bytes
  }
  let result: TaskOracleResult
  const task = manifest.task
  if (task.kind === 'pagination-v1') {
    const code = frozen(task.code)
    for (const file of task.protectedFiles) frozen(file)
    result = await paginationCheck(code, task.timeoutMs, subprocess, sandbox, signal, execution === undefined ? undefined : {
      ...execution, codePath: task.code.path })
    readFrozen(task.code)
    for (const file of task.protectedFiles) readFrozen(file)
  } else {
    const output = resolver.resolveArtifact(task.outputHash)
    assert(output !== undefined && sha256(Buffer.from(output)) === task.outputHash, 'complete task output artifact is absent or changed')
    result = task.kind === 'invoice-v1'
      ? invoiceOracle(frozen(task.invoices).toString('utf8'), frozen(task.rates).toString('utf8'), Buffer.from(output).toString('utf8'))
      : singleLineOracle(frozen(task.terms).toString('utf8'), Buffer.from(output).toString('utf8'))
  }
  signal.throwIfAborted()
  assert(sha256(readProject(`.llm-wiki/${candidatePath}`, hash.parse(request['candidateHash']))) === request['candidateHash'],
    'Candidate changed during verification')
  assert(canonicalJson(programIdentity()) === canonicalJson(frozenPrograms), 'verifier/oracle sources changed during verification')
  const reports = [
    { name: 'registered-request-and-frozen-sources', result: 'pass' as const, facts: { requestHash: manifest.expectedRequestHash,
      projectRoot: manifest.projectRoot, sources: sourceReports } },
    { name: 'vetted-fixed-task-rule', result: ruleCovered ? 'pass' as const : 'fail' as const,
      facts: { candidateHash: sha256(candidate), acceptedRuleHash: manifest.acceptedRuleHash, task: task.kind } },
    { name: 'independent-task-oracle', result: result.result, facts: { ...result,
      schemaVersion: 1, kind: 'fixed-task-oracle-binding-v1', manifestHash,
      taskDefinitionHash: sha256(canonicalJson({ kind: 'fixed-task-definition-v1', task,
        acceptedRuleHash: manifest.acceptedRuleHash, candidateHash: sha256(candidate),
        outputContract: task.kind === 'pagination-v1' ? 'independent-indexed-cases-v1' : 'complete-visible-assistant-text-v1' })),
      taskKind: task.kind, task, sources: sourceReports,
      outputHash: task.kind === 'pagination-v1' ? null : task.outputHash,
      executor: { nodeVersion: process.versions.node, platform: process.platform, arch: process.arch,
        network: task.kind === 'pagination-v1' ? 'macos-kernel-deny-network-v1' : 'no-child-execution',
        ...frozenPrograms },
    } },
  ]
  const outcomes = []
  for (const report of reports) {
    const bytes = Buffer.from(canonicalJson(report), 'utf8')
    const artifactHash = sha256(bytes)
    const path = resolveConfinedPath(manifest.artifactRoot, artifactHash, true)
    const existing = resolver.resolveArtifact(artifactHash)
    if (existing === undefined) {
      if (writeNewArtifact === undefined) atomicWriteFile(path, bytes)
      else await writeNewArtifact(bytes)
    }
    else assert(Buffer.from(existing).equals(bytes), 'content-addressed verifier report was replaced')
    outcomes.push({ name: report.name, result: report.result, evidence: [artifactHash] })
  }
  const unsigned = { authorityId: manifest.authorityId, requestHash: manifest.expectedRequestHash,
    result: outcomes.every(outcome => outcome.result === 'pass') ? 'pass' as const : 'fail' as const,
    methods: ['unit_test', 'integration_test'] as IndependentVerificationResult['methods'], outcomes, issuedAt: new Date().toISOString() }
  return unsigned
}

/**
 * Seal fixed-pilot evidence with an ephemeral test key; production custody is excluded.
 * @param rawManifest - Strict launcher manifest.
 * @param payload - Preregistered verification request.
 * @param privateKey - Ephemeral Ed25519 fixture key.
 * @param subprocess - Existing process-tree owner.
 * @param sandbox - Enforcing read-only sandbox.
 * @param signal - Operation cancellation.
 * @returns Existing verification result with its test proof.
 */
export async function verifyKnowledgePilot(
  rawManifest: unknown, payload: unknown, privateKey: KeyObject,
  subprocess: SubprocessRuntime, sandbox: SandboxProvider, signal: AbortSignal,
): Promise<IndependentVerificationResult> {
  assert(privateKey.type === 'private' && privateKey.asymmetricKeyType === 'ed25519', 'pilot requires an Ed25519 test private key')
  const unsigned = await verifyKnowledgePilotEvidence(rawManifest, payload, subprocess, sandbox, signal)
  return { ...unsigned, proof: sign(null, Buffer.from(canonicalJson(unsigned), 'utf8'), privateKey).toString('base64') }
}

/* v8 ignore start -- thin CLI is executed through the real managed external adapter; unit coverage owns verifyKnowledgePilot. */
async function main(): Promise<void> {
  assert(process.argv.length === 4, 'usage: knowledge-pilot-verifier.ts <ephemeral-test-manifest.json> <test-private-key.pem>')
  const manifestPath = process.argv[2]
  const keyPath = process.argv[3]
  assert(manifestPath !== undefined && keyPath !== undefined && isAbsolute(manifestPath) && isAbsolute(keyPath),
    'pilot paths must be absolute')
  const manifest: unknown = JSON.parse(readRegularFileBounded(manifestPath, 2 * 1024 * 1024).toString('utf8'))
  const key = createPrivateKey(readRegularFileBounded(keyPath, 16 * 1024))
  const input: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const part = Buffer.from(chunk as Uint8Array)
    bytes += part.byteLength
    assert(bytes <= 2 * 1024 * 1024, 'pilot request exceeds 2 MiB')
    input.push(part)
  }
  const payload: unknown = JSON.parse(Buffer.concat(input).toString('utf8'))
  const [{ Context }, { default: LocalSubprocessRuntime }, { default: SandboxLocal }] = await Promise.all([
    import('@deepseek-ai/cordis'),
    import('@deepseek-ai/dsh-subprocess-local'),
    import('@deepseek-ai/dsh-sandbox-local'),
  ])
  const context = new Context()
  try {
    await context.plugin(LocalSubprocessRuntime)
    await context.plugin(SandboxLocal)
    const result = await verifyKnowledgePilot(manifest, payload, key, context.subprocess, context.sandbox, AbortSignal.timeout(120_000))
    process.stdout.write(`${canonicalJson(result)}\n`)
  } finally { await context.fiber.dispose() }
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
/* v8 ignore stop */
