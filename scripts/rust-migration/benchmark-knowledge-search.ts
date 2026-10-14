/** Three-way benchmark scaffold with real current/optimized TypeScript measurements. */

import { createHash } from 'node:crypto'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bm25,
  bm25FromKnowledgeSearchIndex,
  collectSearchPages,
  createKnowledgeSearchIndex,
  STOP_WORDS,
  tokenize,
} from '../../packages/host/knowledge-wiki/src/search.ts'
import { WikiSnapshotStore } from '../../packages/host/knowledge-wiki/src/snapshot-store.ts'
import { isolatedChildEnvironment } from './process-isolation.ts'

export interface Page {
  readonly path: string
  readonly title: string
  readonly aliases: string[]
  readonly text: string
}

interface PreparedPage {
  readonly page: Page
  readonly tokens: string[]
  readonly frequencies: ReadonlyMap<string, number>
  readonly titleTokens: ReadonlySet<string>
}

const K1 = 1.5
const B = 0.75

function prepare(pages: readonly Page[]): {
  readonly pages: PreparedPage[]
  readonly docFreq: ReadonlyMap<string, number>
  readonly avgLen: number
} {
  const prepared = pages.map((page) => {
    const tokens = tokenize([page.title, ...page.aliases, page.text].join('\n'))
    const frequencies = new Map<string, number>()
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
    return { page, tokens, frequencies, titleTokens: new Set(tokenize([page.title, ...page.aliases].join('\n'))) }
  })
  const docFreq = new Map<string, number>()
  for (const item of prepared) for (const token of new Set(item.tokens)) docFreq.set(token, (docFreq.get(token) ?? 0) + 1)
  return { pages: prepared, docFreq, avgLen: prepared.reduce((sum, item) => sum + item.tokens.length, 0) / Math.max(1, prepared.length) }
}

function optimizedBm25(index: ReturnType<typeof prepare>, query: string): Array<{ path: string; score: number }> {
  const queryTokens = tokenize(query).filter(token => !STOP_WORDS.has(token))
  if (queryTokens.length === 0) return []
  const scores = index.pages.map((item) => {
    let score = 0
    for (const queryToken of queryTokens) {
      const df = index.docFreq.get(queryToken) ?? 0
      if (df === 0) continue
      const idf = Math.log(1 + (index.pages.length - df + 0.5) / (df + 0.5))
      const tf = item.frequencies.get(queryToken) ?? 0
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (item.tokens.length / index.avgLen))))
    }
    for (const queryToken of queryTokens) if (item.titleTokens.has(queryToken)) score *= 1.5
    return { path: item.page.path, score }
  })
  return scores.filter(item => item.score > 0).sort((left, right) => right.score - left.score)
}

export function benchmarkCorpus(): { readonly pages: Page[]; readonly queries: string[]; readonly hash: string } {
  const pages = Array.from({ length: 240 }, (_, index) => ({
    path: `concepts/page-${index}.md`,
    title: `Runtime knowledge ${index % 24}`,
    aliases: [`运行时知识 ${index % 24}`, `search alias ${index % 12}`],
    text: `The verified runtime candidate ${index} records cancellation recovery, scope boundaries, utility feedback, and deterministic replay. ${'知识治理与性能证据 '.repeat((index % 7) + 2)}`,
  }))
  const queries = ['verified runtime replay', '知识治理 性能证据', 'cancellation recovery scope', 'utility feedback', 'search alias']
  return { pages, queries, hash: createHash('sha256').update(JSON.stringify({ pages, queries })).digest('hex') }
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
}

function measurementState(resolution: number) {
  const delay = monitorEventLoopDelay({ resolution })
  delay.enable()
  return {
    delay,
    cpuBefore: process.cpuUsage(),
    rssBefore: process.memoryUsage().rss,
    durations: [] as number[],
    digests: [] as string[],
  }
}

function measure(run: () => unknown, iterations: number): {
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly cpuMicros: number
  readonly rssDelta: number
  readonly eventLoopDelayMeanMs: number
  readonly eventLoopDelaySamples: number
  readonly digest: string
} {
  const { delay, cpuBefore, rssBefore, durations, digests } = measurementState(10)
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now()
    digests.push(JSON.stringify(run()))
    durations.push(performance.now() - start)
  }
  const cpu = process.cpuUsage(cpuBefore)
  delay.disable()
  return {
    p50: percentile(durations, 0.5), p95: percentile(durations, 0.95), p99: percentile(durations, 0.99),
    cpuMicros: cpu.user + cpu.system, rssDelta: process.memoryUsage().rss - rssBefore,
    eventLoopDelayMeanMs: Number.isFinite(delay.mean) ? delay.mean / 1e6 : 0,
    eventLoopDelaySamples: delay.count,
    digest: createHash('sha256').update(digests.join('\n')).digest('hex'),
  }
}

async function measureAsync(run: () => unknown, iterations: number): Promise<{
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly cpuMicros: number
  readonly rssDelta: number
  readonly eventLoopDelayMeanMs: number | null
  readonly eventLoopDelayP95Ms: number | null
  readonly eventLoopDelayMaxMs: number | null
  readonly eventLoopDelaySamples: number
  readonly digest: string
}> {
  const { delay, cpuBefore, rssBefore, durations, digests } = measurementState(1)
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now()
    digests.push(JSON.stringify(await run()))
    durations.push(performance.now() - start)
    await new Promise<void>(resolveImmediate => setImmediate(resolveImmediate))
  }
  await new Promise<void>(resolveImmediate => setImmediate(resolveImmediate))
  const cpu = process.cpuUsage(cpuBefore)
  delay.disable()
  const eventLoopDelaySamples = delay.count
  return {
    p50: percentile(durations, 0.5), p95: percentile(durations, 0.95), p99: percentile(durations, 0.99),
    cpuMicros: cpu.user + cpu.system, rssDelta: process.memoryUsage().rss - rssBefore,
    eventLoopDelayMeanMs: eventLoopDelaySamples > 0 && Number.isFinite(delay.mean) ? delay.mean / 1e6 : null,
    eventLoopDelayP95Ms: eventLoopDelaySamples > 0 ? delay.percentile(95) / 1e6 : null,
    eventLoopDelayMaxMs: eventLoopDelaySamples > 0 ? delay.max / 1e6 : null,
    eventLoopDelaySamples,
    digest: createHash('sha256').update(digests.join('\n')).digest('hex'),
  }
}

function summarizeSamples(
  samples: readonly number[],
  digest: string,
  loop: {
    readonly meanMs: number | null
    readonly p95Ms: number | null
    readonly maxMs: number | null
    readonly samples: number
  } | undefined,
): Record<string, unknown> {
  return {
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
    sampleCount: samples.length,
    cpuMicros: null,
    rssDelta: null,
    eventLoopDelayMeanMs: loop?.meanMs ?? null,
    eventLoopDelayP95Ms: loop?.p95Ms ?? null,
    eventLoopDelayMaxMs: loop?.maxMs ?? null,
    eventLoopDelaySamples: loop?.samples ?? 0,
    digest,
  }
}

interface RustHit {
  readonly path: string
  readonly score: number
}

interface RustOutput {
  readonly schemaVersion: number
  readonly results: readonly (readonly RustHit[])[]
  readonly digest: string
  readonly inputDigest: string
}

interface RustRequest {
  readonly schemaVersion: 1
  readonly requestId: string
  readonly sessionId: string
  readonly generation: number
  readonly capability: string
  readonly deadlineMs: number
  readonly budget: number
  readonly cancellationToken: string
  readonly pages: readonly Page[]
  readonly queries: readonly string[]
}

function benchmarkRequest(input: { readonly pages: readonly Page[]; readonly queries: readonly string[] }): RustRequest {
  return {
    schemaVersion: 1,
    requestId: 'benchmark-request-1',
    sessionId: 'benchmark-session-1',
    generation: 1,
    capability: 'knowledge-search',
    deadlineMs: 30_000,
    budget: 1,
    cancellationToken: 'benchmark-cancellation-1',
    pages: input.pages,
    queries: input.queries,
  }
}

function rustBinary(explicit: string | undefined): string | undefined {
  if (explicit !== undefined) return explicit
  const bundled = fileURLToPath(new URL('../../rust/knowledge-search-shadow/target/release/knowledge-search-shadow', import.meta.url))
  return existsSync(bundled) ? bundled : undefined
}

function runRust(binary: string, input: RustRequest): RustOutput {
  const request = JSON.stringify(input)
  const result = spawnSync(binary, [], {
    input: request,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    env: isolatedChildEnvironment(),
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`Rust shadow exited ${String(result.status)}: ${result.stderr}`)
  const output = JSON.parse(result.stdout) as RustOutput
  const validSchema = output.schemaVersion === 1
    && Array.isArray(output.results)
    && /^[a-f0-9]{64}$/u.test(output.digest)
    && /^[a-f0-9]{64}$/u.test(output.inputDigest)
  if (!validSchema) {
    throw new Error('Rust shadow output failed schema validation')
  }
  if (output.inputDigest !== createHash('sha256').update(request).digest('hex')) throw new Error('Rust shadow input digest mismatch')
  if (output.digest !== createHash('sha256').update(JSON.stringify(output.results)).digest('hex')) throw new Error('Rust shadow result digest mismatch')
  return output
}

function canonicalResults(results: readonly (readonly { readonly path: string; readonly score: number }[])[]): string {
  return JSON.stringify(results)
}

function measureRustPersistent(
  binary: string,
  input: { readonly pages: readonly Page[]; readonly queries: readonly string[] },
  iterations: number,
): {
  readonly metrics: Record<string, unknown>
  readonly recovery: Record<string, unknown>
  readonly cancellation: Record<string, unknown>
  readonly resultDigest: string
  readonly inputDigest: string
} {
  const helper = fileURLToPath(new URL('./measure-rust-persistent.mjs', import.meta.url))
  const raw = execFileSync(process.execPath, [helper], {
    input: JSON.stringify({ binary, request: benchmarkRequest(input), iterations, timeoutMs: 30_000 }),
    encoding: 'utf8',
    timeout: Math.max(30_000, (iterations + 3) * 30_000),
    maxBuffer: 4 * 1024 * 1024,
    env: isolatedChildEnvironment(),
  })
  const result = JSON.parse(raw) as {
    readonly schemaVersion: number
    readonly startupMs: number
    readonly samplesMs: readonly number[]
    readonly measurementDigest: string
    readonly resultDigest: string
    readonly inputDigest: string
    readonly recovery: Record<string, unknown>
    readonly cancellation: Record<string, unknown>
    readonly eventLoopDelay: {
      readonly meanMs: number | null
      readonly p95Ms: number | null
      readonly maxMs: number | null
      readonly samples: number
    }
  }
  if (result.schemaVersion !== 1 || !Array.isArray(result.samplesMs) || result.samplesMs.length !== iterations
    || !/^[a-f0-9]{64}$/u.test(result.measurementDigest)
    || !/^[a-f0-9]{64}$/u.test(result.resultDigest) || !/^[a-f0-9]{64}$/u.test(result.inputDigest)) {
    throw new Error('Rust persistent benchmark output failed schema validation')
  }
  return {
    metrics: {
      ...summarizeSamples(result.samplesMs, result.measurementDigest, result.eventLoopDelay),
      startupMs: result.startupMs,
      startupIncludedInFirstSample: false,
      processReuse: true,
      // The persistent child reuses its process and pipes, but the current
      // Rust kernel still rebuilds its document index for each request.
      indexReuse: false,
      resultDigest: result.resultDigest,
    },
    recovery: result.recovery,
    cancellation: result.cancellation,
    resultDigest: result.resultDigest,
    inputDigest: result.inputDigest,
  }
}

/** Run deterministic current/optimized TypeScript and optional Rust shadow measurements. */
export function runBenchmark(iterations = 30, explicitRustBinary?: string): Record<string, unknown> {
  const input = benchmarkCorpus()
  const index = prepare(input.pages)
  const current = measure(() => input.queries.map(query => bm25(input.pages, query)), iterations)
  const optimized = measure(() => input.queries.map(query => optimizedBm25(index, query)), iterations)
  const currentResults = input.queries.map(query => bm25(input.pages, query))
  const optimizedResults = input.queries.map(query => optimizedBm25(index, query))
  const equal = canonicalResults(currentResults) === canonicalResults(optimizedResults)
  const missingEvidence: string[] = []
  let rust: Record<string, unknown> | null = null
  let differentialReplay = equal ? 'current-and-optimized-ts-match' : 'typescript-mismatch'
  const binary = rustBinary(explicitRustBinary)
  if (binary === undefined) {
    missingEvidence.push('Rust shadow implementation')
  } else {
    try {
      const request = benchmarkRequest(input)
      const shadow = runRust(binary, request)
      const rustMatches = canonicalResults(currentResults) === canonicalResults(shadow.results)
      differentialReplay = rustMatches && equal ? 'current-optimized-rust-match' : 'differential-mismatch'
      const measured = measure(() => runRust(binary, request).results, iterations)
      let warm: Record<string, unknown> | null = null
      let recovery: Record<string, unknown> | null = null
      let cancellation: Record<string, unknown> | null = null
      try {
        const persistent = measureRustPersistent(binary, input, iterations)
        warm = persistent.metrics
        recovery = persistent.recovery
        cancellation = persistent.cancellation
      } catch (error) {
        missingEvidence.push(`Rust warm persistent measurement: ${error instanceof Error ? error.message : String(error)}`)
      }
      rust = {
        cold: {
          ...measured,
          startupIncluded: true,
          processReuse: false,
          indexReuse: false,
        },
        warm,
        recovery,
        cancellation,
        ...measured,
        transport: 'stdin/stdout process IPC',
        cpuScope: 'node-parent',
        rssScope: 'node-parent',
        resultDigest: shadow.digest,
        inputDigest: shadow.inputDigest,
      }
      if (!rustMatches) missingEvidence.push('Rust shadow differential replay')
    } catch (error) {
      missingEvidence.push(`Rust shadow execution: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  missingEvidence.push(
    'production candidate profile exercise and authenticated enforcement receipt',
    'cross-platform Rust measurements',
    'child CPU/RSS accounting',
    'end-to-end production cancellation and crash-recovery measurements',
  )
  if (rust === null) missingEvidence.push('Rust cold and warm envelope measurements')
  else if (rust.warm === null) missingEvidence.push('Rust warm persistent envelope measurement')
  const cancellationStatus = rust !== null && typeof rust.cancellation === 'object' && rust.cancellation !== null
    ? (rust.cancellation as Record<string, unknown>).status
    : undefined
  if (cancellationStatus === 'not-measured') missingEvidence.push('benchmark cancellation latency (AbortSignal is owned by the TypeScript boundary)')
  if (current.eventLoopDelaySamples === 0 || optimized.eventLoopDelaySamples === 0) missingEvidence.push('event-loop delay samples for the synchronous harness')
  const implementation = { currentTypeScript: current, optimizedTypeScript: optimized, rust }
  return {
    schemaVersion: 1,
    status: 'unknown',
    candidate: 'knowledge-search-bm25',
    implementation,
    envelopes: {
      typescriptCold: { ...current, name: 'typescript-cold-rebuild', indexReuse: false, processReuse: true },
      typescriptWarm: { ...optimized, name: 'typescript-warm-cached-index', indexReuse: true, processReuse: true },
      rustCold: rust?.cold ?? null,
      rustWarm: rust?.warm ?? null,
    },
    corpusHash: input.hash,
    stopWordCount: STOP_WORDS.size,
    iterations,
    differentialReplay,
    missingEvidence,
  }
}

interface FileBackedInput {
  readonly root: string
  readonly pages: Page[]
  readonly query: string
}

function createFileBackedInput(): FileBackedInput {
  const corpus = benchmarkCorpus()
  const root = mkdtempSync(join(tmpdir(), 'ark-knowledge-search-benchmark-'))
  try {
    for (const page of corpus.pages) {
      const path = join(root, page.path)
      mkdirSync(resolve(path, '..'), { recursive: true })
      writeFileSync(path, `---\ntitle: ${JSON.stringify(page.title)}\naliases: ${JSON.stringify(page.aliases)}\n---\n${page.text}\n`)
    }
    const pages = collectSearchPages(root).map(page => ({
      path: page.path,
      title: page.title,
      aliases: page.aliases,
      text: page.text,
    }))
    if (pages.length !== corpus.pages.length) throw new Error(`file-backed corpus loaded ${pages.length}/${corpus.pages.length} pages`)
    return { root, pages, query: corpus.queries[0] ?? '' }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

function median(values: readonly number[]): number {
  return percentile(values, 0.5)
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function metricMedians(
  runs: readonly Record<string, unknown>[],
  key: string,
): Record<string, unknown> {
  const samples = runs.map(run => run[key]).filter((value): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value))
  const numericKeys = ['p50', 'p95', 'p99', 'cpuMicros', 'rssDelta', 'eventLoopDelayMeanMs', 'eventLoopDelayP95Ms', 'eventLoopDelayMaxMs', 'eventLoopDelaySamples']
  return Object.fromEntries(numericKeys.map((field) => {
    const eligible = field === 'eventLoopDelayMeanMs'
      ? samples.filter(sample => typeof sample['eventLoopDelaySamples'] === 'number' && sample['eventLoopDelaySamples'] > 0)
      : samples
    const values = eligible.map(sample => sample[field]).filter((value): value is number =>
      typeof value === 'number' && Number.isFinite(value))
    return [field, values.length === 0 ? null : median(values)]
  }))
}

/**
 * Reproduce the production-shaped, file-backed one-query comparison documented in the migration report.
 * @param independentRuns - Number of fresh fixture/store runs.
 * @param iterations - Timed samples in each run.
 * @param explicitRustBinary - Optional isolated Rust candidate executable.
 * @returns Per-run evidence and median scenario metrics.
 */
export async function runFileBackedComparisonSeries(
  independentRuns = 3,
  iterations = 30,
  explicitRustBinary?: string,
): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(independentRuns) || independentRuns < 1 || independentRuns > 20
    || !Number.isSafeInteger(iterations) || iterations < 2 || iterations > 1000) {
    throw new Error('file-backed benchmark bounds are invalid')
  }
  const binary = rustBinary(explicitRustBinary)
  const runs: Array<Record<string, unknown>> = []
  const firstIndexMissMs: number[] = []
  let allDifferentialsMatch = binary !== undefined
  let cleanRustRuns = 0

  for (let runIndex = 0; runIndex < independentRuns; runIndex += 1) {
    const input = createFileBackedInput()
    const snapshotStore = new WikiSnapshotStore()
    try {
      const loadedPages = collectSearchPages(input.root)
      const indexBuildStart = performance.now()
      const productionIndex = await snapshotStore.get(input.root, 'knowledge-search-index', () =>
        Promise.resolve(createKnowledgeSearchIndex(collectSearchPages(input.root))))
      const cacheBuildMs = performance.now() - indexBuildStart
      firstIndexMissMs.push(cacheBuildMs)

      const currentResults = bm25(collectSearchPages(input.root), input.query)
      const optimizedResults = bm25(loadedPages, input.query)
      const cachedResults = bm25FromKnowledgeSearchIndex(productionIndex, input.query)
      const currentAndOptimizedMatch = canonicalResults([currentResults]) === canonicalResults([optimizedResults])
      const currentAndCacheMatch = canonicalResults([currentResults]) === canonicalResults([cachedResults])
      const currentMetrics = await measureAsync(() => bm25(collectSearchPages(input.root), input.query), iterations)
      const optimizedMetrics = await measureAsync(() => bm25(loadedPages, input.query), iterations)
      const cacheMetrics = await measureAsync(
        () => snapshotStore.get(input.root, 'knowledge-search-index', () =>
          Promise.resolve(createKnowledgeSearchIndex(collectSearchPages(input.root)))).then(index =>
          bm25FromKnowledgeSearchIndex(index, input.query)),
        iterations,
      )
      const run: Record<string, unknown> = {
        currentTypeScript: currentMetrics,
        optimizedTypeScriptRebuiltIndex: optimizedMetrics,
        productionCachedTypeScript: cacheMetrics,
        firstIndexMissMs: cacheBuildMs,
        currentAndOptimizedMatch,
        productionCacheDifferentialMatch: currentAndCacheMatch,
        pageCount: loadedPages.length,
      }

      if (binary !== undefined) {
        const request = benchmarkRequest({ pages: input.pages, queries: [input.query] })
        const rustOutput = runRust(binary, request)
        const rustResults = rustOutput.results
        const rustMatches = canonicalResults([currentResults]) === canonicalResults(rustResults)
        const rustFreshMetrics = await measureAsync(() => runRust(binary, request).results, iterations)
        const persistent = measureRustPersistent(binary, { pages: input.pages, queries: [input.query] }, iterations)
        const expectedRustDigest = createHash('sha256').update(JSON.stringify(rustResults)).digest('hex')
        const persistentMatches = persistent.resultDigest === expectedRustDigest
        run['rustIpc'] = rustFreshMetrics
        run['persistentRust'] = persistent.metrics
        run['rustDifferentialMatch'] = rustMatches && persistentMatches
        run['persistentRustRecovery'] = persistent.recovery
        run['persistentRustCancellation'] = persistent.cancellation
        run['rustResultDigest'] = rustOutput.digest
        if (rustMatches && persistentMatches) cleanRustRuns += 1
        else allDifferentialsMatch = false
      } else {
        run['rustIpc'] = null
        run['persistentRust'] = null
        run['rustDifferentialMatch'] = false
        allDifferentialsMatch = false
      }
      if (!currentAndOptimizedMatch || !currentAndCacheMatch) allDifferentialsMatch = false
      runs.push(run)
    } finally {
      snapshotStore.dispose()
      rmSync(input.root, { recursive: true, force: true })
    }
  }

  const corpus = benchmarkCorpus()
  const sourceRoot = fileURLToPath(new URL('../..', import.meta.url))
  const scenarioNames = [
    'currentTypeScript', 'optimizedTypeScriptRebuiltIndex', 'productionCachedTypeScript', 'rustIpc', 'persistentRust',
  ]
  const scenarios = Object.fromEntries(scenarioNames.map(name => [name, metricMedians(runs, name)]))
  return {
    schemaVersion: 1,
    status: binary !== undefined && allDifferentialsMatch && cleanRustRuns === independentRuns
      ? 'bounded-source-comparison-pass'
      : 'unknown',
    releaseDecision: 'unknown',
    execution: 'independent-file-backed-single-query-comparison',
    activeProfileMode: 'disabled',
    runtime: { platform: process.platform, arch: process.arch, node: process.versions.node },
    fixture: {
      pages: corpus.pages.length,
      queryDigest: createHash('sha256').update(inputQuery(corpus)).digest('hex'),
      independentRuns,
      iterationsPerRun: iterations,
      queryPerRequest: 1,
      indexInvalidationVerifiedBy: 'WikiSnapshotStore and Knowledge Wiki search regression suites',
    },
    scenarios,
    productionCacheFirstIndexMissMs: firstIndexMissMs,
    productionCacheBuildsPerRun: Array(independentRuns).fill(1),
    differentialMatches: cleanRustRuns,
    rustWorkerCleanExits: cleanRustRuns,
    sourceSha256: {
      benchmark: sha256File(fileURLToPath(import.meta.url)),
      search: sha256File(resolve(sourceRoot, 'packages/host/knowledge-wiki/src/search.ts')),
      snapshotStore: sha256File(resolve(sourceRoot, 'packages/host/knowledge-wiki/src/snapshot-store.ts')),
      rustKernel: sha256File(resolve(sourceRoot, 'rust/knowledge-search-shadow/src/main.rs')),
    },
    runs,
    limitations: [
      'Synthetic fixture only; no real user Wiki, embeddings, model provider latency, ACL replay, or whole Ark profile call.',
      'Rust child CPU and RSS are not included in Node-parent measurements; collect process-tree resources before any production decision.',
      'Cancellation, crash recovery, cross-platform packaging, stress, and authenticated candidate-profile enforcement remain separate gates.',
    ],
  }
}

function inputQuery(corpus: ReturnType<typeof benchmarkCorpus>): string {
  return corpus.queries[0] ?? ''
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  const args = process.argv.slice(2)
  if (args[0] === '--series') {
    const output = args[3]
    void runFileBackedComparisonSeries(Number.parseInt(args[1] ?? '3', 10), Number.parseInt(args[2] ?? '30', 10))
      .then((result) => {
        const serialized = `${JSON.stringify(result, null, 2)}\n`
        if (output !== undefined) writeFileSync(output, serialized)
        else process.stdout.write(serialized)
      })
      .catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
        process.exitCode = 1
      })
  } else {
    const result = runBenchmark(Number.parseInt(args[0] ?? '30', 10))
    const output = args[1]
    if (output !== undefined) writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`)
    else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  }
}
