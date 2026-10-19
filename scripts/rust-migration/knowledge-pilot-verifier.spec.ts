import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SandboxLocal from '@deepseek-ai/dsh-sandbox-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createExternalVerifierAuthority } from '../../packages/host/knowledge-wiki/src/external-verifier-adapter.ts'
import { canonicalJson, encodeKnowledgeWikiPromotionSealRequest, sha256, type IndependentVerificationRequest, type KnowledgeWikiPromotionSealRequest } from '../../packages/host/knowledge-wiki/src/verifier.ts'
import { confinePilotNetwork, verifyKnowledgePilot, type KnowledgePilotManifest } from './knowledge-pilot-verifier.ts'

const roots: string[] = []
const keys = generateKeyPairSync('ed25519')
const identity = { commit: 'a'.repeat(40), sourceDigest: sha256('source'), dirty: true, dirtyDigest: sha256('dirty'), buildDigest: sha256('build') }
let context: Context
let subprocess: SubprocessRuntime
let sandbox: SandboxProvider

beforeAll(async () => {
  context = new Context()
  await context.plugin(LocalSubprocessRuntime)
  await context.plugin(SandboxLocal)
  subprocess = context.subprocess
  sandbox = context.sandbox
})
afterAll(async () => { await context.fiber.dispose() })
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture(kind: 'invoice-v1' | 'single-line-v1' | 'pagination-v1' = 'single-line-v1') {
  const root = await mkdtemp(join(tmpdir(), 'ark-pilot-verifier-test-'))
  roots.push(root)
  const project = join(root, 'project')
  const artifacts = join(root, 'artifacts')
  await mkdir(join(project, '.llm-wiki/_candidates/concepts'), { recursive: true })
  await mkdir(artifacts)
  const rule = 'This fixed pilot rule applies only to the registered task.\n'
  const candidatePath = '_candidates/concepts/rule.md'
  await writeFile(join(project, '.llm-wiki', candidatePath), rule)
  const request: IndependentVerificationRequest = {
    schemaVersion: 2, review: { id: 'review-1' }, reviewHash: sha256('review'), candidatePath, candidateHash: sha256(rule),
    sourceHash: sha256('actual frozen source'), targetPath: 'concepts/rule.md', governanceAction: 'Promote',
    governanceDecision: { action: 'Promote', targetPath: 'concepts/rule.md', policyVersion: 'pilot-policy' },
    sourceIdentity: identity, environment: { nodeVersion: process.versions.node, platform: process.platform, arch: process.arch, policyVersion: 'pilot-policy' },
  }
  const payload = { schemaVersion: 1, operation: 'verifyCandidate', request }
  const put = async (path: string, value: string) => { await writeFile(join(project, path), value); return { path, hash: sha256(value) } }
  const output = async (value: string) => { const hash = sha256(value); await writeFile(join(artifacts, hash), value); return hash }
  let task: KnowledgePilotManifest['task']
  if (kind === 'invoice-v1') {
    task = { kind, invoices: await put('invoices.csv', 'invoice_id,status,currency,amount\nA,approved,USD,0.005\nB,pending,unknown,invalid\n'),
      rates: await put('rates.csv', 'currency,minor_units,usd_numerator,usd_denominator\nUSD,3,1,1\n'),
      outputHash: await output('{"approved_invoice_count":1,"pending_invoice_count":1,"rejected_row_ids":[],"usd_total_cents":1,"usd_cents_by_currency":{"USD":1}}') }
  } else if (kind === 'single-line-v1') {
    task = { kind, terms: await put('terms.csv', 'row_id,quantity,unit_value\nA,17,29\nB,23,-11\nC,-7,31\n'), outputHash: await output('SUM=23') }
  } else {
    task = { kind, code: await put('paginate.ts', 'export function paginate(items: readonly object[], page: number, pageSize: number) {\nif (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1) throw new RangeError("invalid");\nconst start = (page - 1) * pageSize;\nreturn { items: items.slice(start, start + pageSize), page, pageSize, totalItems: items.length, totalPages: Math.ceil(items.length / pageSize) };\n}\n'),
      protectedFiles: [await put('original-tests.txt', 'Original tests retained, not project-reported green.\n')], timeoutMs: 30_000 }
  }
  const manifest: KnowledgePilotManifest = { schemaVersion: 1, mode: 'ephemeral-test-only',
    authorityId: 'pilot-test:semantic-v1',
    projectRoot: project, artifactRoot: artifacts, expectedRequestHash: sha256(canonicalJson(request)),
    acceptedRuleHash: sha256(rule), task }
  return { root, manifest, payload, request, artifacts, project, rule, candidatePath }
}

async function run(f: Awaited<ReturnType<typeof fixture>>, signal = new AbortController().signal) {
  return await verifyKnowledgePilot(f.manifest, f.payload, keys.privateKey, subprocess, sandbox, signal)
}

async function refusesUnsupportedPagination(f: Awaited<ReturnType<typeof fixture>>): Promise<boolean> {
  if (process.platform === 'darwin') return false
  await expect(run(f)).rejects.toThrow(/full file-effect confinement|only implemented on macOS/u)
  return true
}

describe('fixed-project semantic test verifier', () => {
  it.each(['single-line-v1', 'invoice-v1'] as const)('computes %s and signs only actual bound reports', async (kind) => {
    const f = await fixture(kind)
    const result = await run(f)
    expect(result.result).toBe('pass')
    const { proof, ...unsigned } = result
    expect(verify(null, Buffer.from(canonicalJson(unsigned)), keys.publicKey, Buffer.from(proof, 'base64'))).toBe(true)
    for (const outcome of result.outcomes) {
      const hash = outcome.evidence[0]
      if (hash === undefined) throw new Error('missing report hash')
      expect(sha256(await readFile(join(f.artifacts, hash)))).toBe(hash)
    }
    const oracle = result.outcomes.find(outcome => outcome.name === 'independent-task-oracle')!
    const report = JSON.parse(await readFile(join(f.artifacts, oracle.evidence[0]!), 'utf8')) as { facts: Record<string, unknown> }
    expect(report.facts).toMatchObject({ schemaVersion: 1, kind: 'fixed-task-oracle-binding-v1',
      manifestHash: sha256(canonicalJson(f.manifest)), taskKind: kind, task: f.manifest.task,
      outputHash: f.manifest.task.kind === 'pagination-v1' ? null : f.manifest.task.outputHash,
      executor: { nodeVersion: process.versions.node, platform: process.platform, arch: process.arch } })
    expect(report.facts['taskDefinitionHash']).toMatch(/^[a-f0-9]{64}$/u)
    const executor = report.facts['executor'] as Record<string, unknown>
    expect(executor['verifierSourceHash']).toBe(sha256(await readFile(new URL('./knowledge-pilot-verifier.ts', import.meta.url))))
    expect(executor['oracleSourceHash']).toBe(sha256(await readFile(new URL('./knowledge-task-oracles.ts', import.meta.url))))
    expect((await run(f)).result).toBe('pass')
  })
  it.each(['export function paginate(', 'export const differentName = 1'])('retains frozen module task failure: %s', async (code) => {
    const f = await fixture('pagination-v1')
    if (await refusesUnsupportedPagination(f)) return
    if (f.manifest.task.kind !== 'pagination-v1') throw new Error('wrong fixture')
    await writeFile(join(f.project, f.manifest.task.code.path), code)
    f.manifest.task.code.hash = sha256(code)
    const result = await run(f)
    expect(result.result).toBe('fail')
    expect(result.outcomes.find(outcome => outcome.name === 'registered-request-and-frozen-sources')?.result).toBe('pass')
    expect(result.outcomes.find(outcome => outcome.name === 'independent-task-oracle')?.result).toBe('fail')
  })

  it('runs the frozen pagination snapshot under real file confinement with all 853 independent cases', async () => {
    const f = await fixture('pagination-v1')
    if (await refusesUnsupportedPagination(f)) return
    const result = await run(f)
    expect(result.result).toBe('pass')
    const outcome = result.outcomes.find(item => item.name === 'independent-task-oracle')
    const evidence = outcome?.evidence[0]
    if (evidence === undefined) throw new Error('missing pagination report')
    const report = JSON.parse((await readFile(join(f.artifacts, evidence))).toString('utf8')) as { facts: { checks: number; outputHash: null; sources: unknown[] } }
    expect(report.facts.checks).toBe(853)
    expect(report.facts.outputHash).toBeNull()
    if (f.manifest.task.kind !== 'pagination-v1') throw new Error('wrong fixture')
    expect(report.facts.sources).toEqual([f.manifest.task.code, ...f.manifest.task.protectedFiles])
  }, 45_000)
  it('refuses an unsupported network fence instead of silently weakening the pilot', () => {
    expect(() => confinePilotNetwork(['node'], 'linux')).toThrow(/only implemented on macOS/u)
    const readOnly = ['sandbox-exec', '-p', '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))', '--', 'node']
    const restricted = confinePilotNetwork(readOnly, 'darwin')
    expect(restricted.slice(3)).toEqual(readOnly.slice(3))
    expect(restricted[2]).toBe(`${readOnly[2]} (deny network*)`)
    expect(restricted[2]).toContain('(deny file-write*)')
    expect(confinePilotNetwork(['/usr/bin/sandbox-exec', ...readOnly.slice(1)], 'darwin')).toEqual(restricted)
    for (const argv of [['custom-runner', ...readOnly.slice(1)], ['sandbox-exec', '-f', ...readOnly.slice(2)],
      ['sandbox-exec', '-p', '(version 1) (allow default)', 'node']]) {
      expect(() => confinePilotNetwork(argv, 'darwin')).toThrow(/exact read-only/u)
    }
  })
  it('retains the file fence and denies an actual loopback connection from frozen code', async () => {
    const f = await fixture('pagination-v1')
    if (await refusesUnsupportedPagination(f)) return
    let connections = 0
    const server = createServer((socket) => { connections += 1; socket.end() })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('missing loopback port')
      const connect = `import net from 'node:net'; await new Promise((resolve, reject) => { const socket = net.connect(${address.port}, '127.0.0.1'); socket.once('connect', () => { socket.end(); resolve(); }); socket.once('error', reject); });\n`
      const control = subprocess.spawn({ argv: [process.execPath, '--input-type=module', '-e', connect],
        cwd: process.cwd(), env: {}, graceMs: 100, signal: AbortSignal.timeout(10_000),
        stdio: { stdin: { data: '' }, stdout: { maxBytes: 1024 }, stderr: { maxBytes: 4096 } } })
      try {
        expect((await control.done).exitCode).toBe(0)
        expect(await control.waitForExit()).toBe(true)
      } finally { control.terminate(); await control.done; expect(await control.waitForExit()).toBe(true) }
      expect(connections).toBe(1)
      if (f.manifest.task.kind !== 'pagination-v1') throw new Error('wrong fixture')
      const path = join(f.project, f.manifest.task.code.path)
      const code = connect + await readFile(path, 'utf8')
      await writeFile(path, code)
      f.manifest.task.code.hash = sha256(code)
      await expect(run(f)).rejects.toThrow(/EPERM/u)
      expect(connections).toBe(1)
      const write = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(join(f.project, 'outside-child.txt'))}, 'blocked');\n`
      const codeWrite = write + (await readFile(path, 'utf8')).slice(connect.length)
      await writeFile(path, codeWrite)
      f.manifest.task.code.hash = sha256(codeWrite)
      await expect(run(f)).rejects.toThrow(/ERR_ACCESS_DENIED|EPERM/u)
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    }
  }, 45_000)
  it('rejects the original endpoint defect even when the current snapshot hash is reviewed', async () => {
    const f = await fixture('pagination-v1')
    if (await refusesUnsupportedPagination(f)) return
    if (f.manifest.task.kind !== 'pagination-v1') throw new Error('wrong fixture')
    const path = join(f.project, f.manifest.task.code.path)
    const broken = (await readFile(path, 'utf8')).replace('start + pageSize)', 'start + pageSize - 1)')
    await writeFile(path, broken)
    f.manifest.task.code.hash = sha256(broken)
    const result = await run(f)
    expect(result.result).toBe('fail')
    expect(result.outcomes.find(item => item.name === 'independent-task-oracle')?.result).toBe('fail')
  }, 45_000)
  it('refuses broader or different knowledge rules despite a correct task answer', async () => {
    const f = await fixture()
    f.manifest.acceptedRuleHash = sha256('Different, broader rule')
    const result = await run(f)
    expect(result.result).toBe('fail')
    expect(result.outcomes.find(item => item.name === 'vetted-fixed-task-rule')?.result).toBe('fail')
  })
  it('refuses a correct final pane accompanied by progress prose', async () => {
    const f = await fixture()
    if (f.manifest.task.kind !== 'single-line-v1') throw new Error('wrong fixture')
    const text = 'I will compute.\nSUM=23'
    f.manifest.task.outputHash = sha256(text)
    await writeFile(join(f.artifacts, sha256(text)), text)
    expect((await run(f)).result).toBe('fail')
  })
  it.each([
    ['request hash', (f: Awaited<ReturnType<typeof fixture>>) => { f.manifest.expectedRequestHash = sha256('other') }],
    ['unknown mode', (f: Awaited<ReturnType<typeof fixture>>) => { Object.assign(f.manifest, { mode: 'production' }) }],
    ['production id', (f: Awaited<ReturnType<typeof fixture>>) => { f.manifest.authorityId = 'production-signer' }],
    ['unknown task', (f: Awaited<ReturnType<typeof fixture>>) => { Object.assign(f.manifest.task, { kind: 'arbitrary-command', command: 'true' }) }],
    ['unknown input field', (f: Awaited<ReturnType<typeof fixture>>) => { Object.assign(f.payload, { command: 'true' }) }],
    ['relative project', (f: Awaited<ReturnType<typeof fixture>>) => { f.manifest.projectRoot = 'relative' }],
    ['parent traversal', (f: Awaited<ReturnType<typeof fixture>>) => { if (f.manifest.task.kind === 'single-line-v1') f.manifest.task.terms.path = '../terms.csv' }],
  ])('refuses unauthorized %s before signing', async (_name, mutate) => {
    const f = await fixture(); mutate(f); await expect(run(f)).rejects.toThrow()
  })
  it('refuses changed original files, output artifacts and Candidate bytes', async () => {
    const f = await fixture()
    await writeFile(join(f.project, 'terms.csv'), 'modified test input')
    await expect(run(f)).rejects.toThrow(/changed/u)
    const c = await fixture()
    await writeFile(join(c.project, '.llm-wiki', c.candidatePath), 'modified candidate')
    await expect(run(c)).rejects.toThrow(/Candidate/u)
    const o = await fixture()
    if (o.manifest.task.kind !== 'single-line-v1') throw new Error('wrong fixture')
    await writeFile(join(o.artifacts, o.manifest.task.outputHash), 'SUM=999')
    await expect(run(o)).rejects.toThrow(/output/u)
  })
  it('refuses missing output and an already cancelled request', async () => {
    const f = await fixture()
    if (f.manifest.task.kind !== 'single-line-v1') throw new Error('wrong fixture')
    await rm(join(f.artifacts, f.manifest.task.outputHash))
    await expect(run(f)).rejects.toThrow(/output/u)
    const stopped = await fixture()
    await expect(run(stopped, AbortSignal.abort(new Error('cancelled test')))).rejects.toThrow(/cancelled/u)
  })
  it('refuses a public signing key and partial confinement', async () => {
    const f = await fixture()
    const active = new AbortController().signal
    await expect(verifyKnowledgePilot(f.manifest, f.payload, keys.publicKey, subprocess, sandbox, active)).rejects.toThrow(/private key/u)
    const p = await fixture('pagination-v1')
    const partial = { confine: () => ({ enforcement: 'partial', argv: [], denialSignatures: [],
      runnerFailureRules: [] }) } as unknown as SandboxProvider
    await expect(verifyKnowledgePilot(p.manifest, p.payload, keys.privateKey, subprocess, partial,
      new AbortController().signal)).rejects.toThrow(/confinement/u)
  })
  it('joins a spawn failure without issuing a receipt', async () => {
    const f = await fixture('pagination-v1')
    if (await refusesUnsupportedPagination(f)) return
    const missing = { spawn: (spec: Parameters<SubprocessRuntime['spawn']>[0]) => subprocess.spawn({ ...spec, argv: ['/no-such-ark-verifier-program'] }) } as unknown as SubprocessRuntime
    await expect(verifyKnowledgePilot(f.manifest, f.payload, keys.privateKey, missing, sandbox,
      new AbortController().signal)).rejects.toThrow()
  })
  it('refuses truncated output and terminates a frozen-code deadline', async () => {
    const f = await fixture('pagination-v1')
    if (await refusesUnsupportedPagination(f)) return
    if (f.manifest.task.kind !== 'pagination-v1') throw new Error('wrong fixture')
    const path = join(f.project, f.manifest.task.code.path)
    const source = await readFile(path, 'utf8')
    const flooded = 'process.stdout.write("x".repeat(128 * 1024));\n' + source
    await writeFile(path, flooded)
    f.manifest.task.code.hash = sha256(flooded)
    await expect(run(f)).rejects.toThrow(/incomplete/u)
    const stalled = 'await new Promise(() => {});\n' + source
    await writeFile(path, stalled)
    f.manifest.task.code.hash = sha256(stalled)
    f.manifest.task.timeoutMs = 10
    await expect(run(f)).rejects.toThrow()
  }, 45_000)
  it('uses the real managed external adapter JSON protocol with an ephemeral test-key file', async () => {
    const f = await fixture()
    const manifestPath = join(f.root, 'manifest.json')
    const keyPath = join(f.root, 'test-key.pem')
    await writeFile(manifestPath, canonicalJson(f.manifest), { mode: 0o600 })
    await writeFile(keyPath, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
    const require = createRequire(import.meta.url)
    const authority = createExternalVerifierAuthority({ authorityId: f.manifest.authorityId, sourceIdentity: identity,
      executable: process.execPath, args: [require.resolve('tsx/cli'), '--tsconfig', fileURLToPath(new URL('../../tsconfig.base.json', import.meta.url)),
        fileURLToPath(new URL('./knowledge-pilot-verifier.ts', import.meta.url)), manifestPath, keyPath],
      publicKey: keys.publicKey,
      promotionSealer: {
        authorityId: f.manifest.authorityId,
        async sealPromotion(request: KnowledgeWikiPromotionSealRequest) {
          if (request.authorityId !== f.manifest.authorityId) throw new Error('fixture promotion sealer authority mismatch')
          return {
            authorityId: f.manifest.authorityId,
            proof: sign(null, Buffer.from(encodeKnowledgeWikiPromotionSealRequest(request), 'utf8'), keys.privateKey).toString('base64'),
          }
        },
      },
      subprocess })
    const result = await authority.verifyCandidate(f.request, new AbortController().signal)
    expect(result.result).toBe('pass')
    expect(authority.validateCandidateResult(f.request, result)).toBe(true)
    await expect(authority.verifyCandidate({ ...f.request, sourceHash: sha256('different source') }, new AbortController().signal)).rejects.toThrow(/preregistered/u)
  }, 45_000)
})
