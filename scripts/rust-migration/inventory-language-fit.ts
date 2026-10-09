/** Source census for language selection; declarations are not runtime or performance evidence. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { globSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries } from '../../packages/boot/app-boot/src/profile.ts'
import { contextKeyMap, contextMergeFiles, eventNameList } from '../cordis-walk.ts'
import { isJsExpr, loadCordisYaml } from '../cordis-yaml.ts'
import { collectToolCatalog } from '../gen-tool-catalog.ts'
import { collectPackageGraph } from '../package-graph.ts'

interface Surface {
  kind: 'function' | 'method' | 'remote' | 'tool-declaration' | 'tool-registration' | 'command'
  name: string
  line: number
  resolution: 'literal' | 'expression'
  contextScope?: string
}

const assessments = [
  {
    file: 'packages/session/session-persistence-jsonl/src/zstd.ts', names: ['scanZstdFrames'],
    decision: 'READ_ONLY_KERNEL_UNMEASURED',
    reason: 'Bounded byte scanning can be isolated; preserve frame ranges, maxFrames, torn-tail and corruption errors. Writers and repair stay with the persistence owner.',
  },
  {
    file: 'packages/session/session-persistence-jsonl/src/zstd.ts', names: ['compressZstdFrame', 'decompressZstdFrame', 'decompressZstdPrefix'],
    decision: 'KEEP_EXISTING_NATIVE', reason: 'These functions already delegate compression to node:zlib; no replacement benefit is measured.',
  },
  {
    file: 'packages/llm/token-meter/src/estimate.ts', names: ['estimateStructuralBlock', 'estimateContent', 'estimateMessage', 'estimateSystemTokens', 'estimateToolsTokens', 'estimateHeader'],
    decision: 'PURE_KERNEL_UNMEASURED',
    reason: 'The fixed heuristic is separable over immutable content. Preserve UTF-16 length, recursive blocks and framing constants; change neither pricing semantics nor the replay owner. Profile batch work before adding IPC.',
  },
  {
    file: 'packages/llm/token-meter/src/index.ts', names: ['TokenMeter.measure', 'TokenMeter._sync', 'TokenMeter._foldEvent', 'TokenMeter._estimateProviderAssistant'],
    decision: 'KEEP_TS_AUTHORITY', reason: 'Session-keyed mutable state, provider pricing, source-event reconstruction and event-order checks belong to the existing replay owner.',
  },
  {
    file: 'packages/session/session-projection/src/index.ts', prefix: 'SessionProjectionRegistry.',
    decision: 'KEEP_TS_AUTHORITY', reason: 'Registered JS folds are synchronous and preserve object identity plus one consistency cut. Async IPC would change this contract; a separately profiled read-only batch projection requires another explicit contract.',
  },
  {
    file: 'packages/fs/tool-str-replace-editor/src/index.ts', names: ['matchOffsets', 'lineNumbersAt'],
    decision: 'PURE_KERNEL_UNMEASURED',
    reason: 'Text scans are separable, but JS indexOf already owns substring matching. Preserve UTF-16 offsets, non-overlapping matches and ordered line mapping; authorization and file writes stay in TS.',
  },
  {
    file: 'packages/util/output-retention/src/index.ts', names: ['trimTrailingPartialUtf8', 'trimLeadingContinuationUtf8'],
    decision: 'PURE_KERNEL_UNMEASURED', reason: 'Byte trimming is separable; the trailing scan is already bounded to a UTF-8 sequence. Stream ownership and backpressure stay in TS. No measured IPC benefit exists.',
  },
  {
    file: 'packages/util/crypto/src/index.ts', names: ['randomUUID'],
    decision: 'KEEP_EXISTING_NATIVE', reason: 'The implementation uses crypto.getRandomValues. This utility is UUID/base64, not the project hash/signature authority.',
  },
  {
    file: 'packages/util/crypto/src/index.ts', names: ['bytesToBase64'],
    decision: 'PURE_KERNEL_UNMEASURED', reason: 'Encoding is separable. Compare platform Buffer/base64 paths and batch/IPC costs before considering Rust; retain the cross-context contract.',
  },
] as const

function propertyName(node: ts.Node | undefined, sf: ts.SourceFile): string {
  if (node === undefined) return '<anonymous>'
  return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : node.getText(sf)
}

function memberName(node: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) return node.argumentExpression.text
  return undefined
}

function configuredName(node: ts.Expression | undefined, sf: ts.SourceFile, tools: ReadonlySet<string>): Pick<Surface, 'name' | 'resolution'> {
  if (node !== undefined && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && tools.has(node.expression.text)) {
    return configuredName(node.arguments[0], sf, tools)
  }
  if (node !== undefined && ts.isObjectLiteralExpression(node)) {
    const name = node.properties.find(item => ts.isPropertyAssignment(item) && propertyName(item.name, sf) === 'name')
    if (name !== undefined && ts.isPropertyAssignment(name)) {
      return ts.isStringLiteralLike(name.initializer)
        ? { name: name.initializer.text, resolution: 'literal' }
        : { name: name.initializer.getText(sf), resolution: 'expression' }
    }
  }
  return { name: node?.getText(sf).replace(/\s+/gu, ' ').slice(0, 160) ?? '<missing>', resolution: 'expression' }
}

/**
 * Enumerate callable declarations, Remote decorators, and tool/command registration sites with the TS parser.
 * @param file - source path, also selecting the parser's language mode.
 * @param source - source bytes decoded as UTF-8; never executed.
 * @returns source-located declarations, with dynamic registration names preserved as expressions.
 */
export function declaredSurfaces(file: string, source: string): Surface[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const surfaces: Surface[] = []
  const remotes = new Set(['Remote'])
  const scopedRemotes = new Set(['RemoteScope'])
  const tools = new Set(['defineTool'])
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    const bindings = stmt.importClause?.namedBindings
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue
    for (const binding of bindings.elements) {
      const original = binding.propertyName?.text ?? binding.name.text
      if (original === 'Remote') remotes.add(binding.name.text)
      if (original === 'RemoteScope') scopedRemotes.add(binding.name.text)
      if (original === 'defineTool') tools.add(binding.name.text)
    }
  }
  const add = (
    node: ts.Node, kind: Surface['kind'], name: string,
    resolution: Surface['resolution'] = 'literal', contextScope?: string,
  ): void => {
    surfaces.push({
      kind, name, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, resolution,
      ...contextScope === undefined ? {} : { contextScope },
    })
  }
  const walk = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node)) add(node, 'function', propertyName(node.name, sf))
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      add(node, 'function', propertyName(node.name, sf))
    }
    if (ts.isMethodDeclaration(node)) {
      const owner = ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent)
        ? propertyName(node.parent.name, sf)
        : '<object>'
      const name = propertyName(node.name, sf)
      add(node, 'method', `${owner}.${name}`)
      for (const decorator of ts.getDecorators(node) ?? []) {
        const expression = decorator.expression
        const callee = ts.isCallExpression(expression) ? expression.expression : expression
        const scoped = ts.isCallExpression(expression)
          && ((ts.isIdentifier(callee) && scopedRemotes.has(callee.text)) || memberName(callee) === 'RemoteScope')
        if (!scoped && !(ts.isIdentifier(callee) && remotes.has(callee.text)) && memberName(callee) !== 'Remote') continue
        const arg = ts.isCallExpression(expression) ? expression.arguments[scoped ? 1 : 0] : undefined
        const scope = scoped ? expression.arguments[0] : undefined
        const exported = arg !== undefined && ts.isStringLiteralLike(arg) ? arg.text
          : scoped && arg !== undefined ? arg.getText(sf) : name
        const dynamic = scoped && (scope === undefined || !ts.isStringLiteralLike(scope)
          || (arg !== undefined && !ts.isStringLiteralLike(arg)))
        add(node, 'remote', `${owner}.${exported}`, dynamic ? 'expression' : 'literal',
          scope === undefined ? undefined : ts.isStringLiteralLike(scope) ? scope.text : scope.getText(sf))
      }
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && tools.has(node.expression.text)) {
        const name = configuredName(node.arguments[0], sf, tools)
        add(node, 'tool-declaration', name.name, name.resolution)
      }
      if (memberName(node.expression) === 'register'
        && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))) {
        const registry = memberName(node.expression.expression)
        if (registry === 'tools' || registry === 'commands') {
          const name = configuredName(node.arguments[0], sf, tools)
          add(node, registry === 'tools' ? 'tool-registration' : 'command', name.name, name.resolution)
        }
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(sf)
  return surfaces
}

/**
 * Classify census inputs without deleting excluded paths from the coverage record.
 * @param file - repository-relative path normalized to `/`.
 * @param source - source text used only to recognize a generated-file marker.
 * @returns the source's role, not a statement that its behavior has been reviewed.
 */
export function sourceRole(file: string, source: string): 'runtime' | 'test' | 'generated' | 'tooling' {
  if (/(?:^|\/)(?:tests?|fixtures|__tests__)(?:\/|$)/iu.test(file)
    || file.includes('/Sources/JiuzhangShellContractTests/') || /\.(?:spec|test)\.[^/]+$/u.test(file)) return 'test'
  if (/(?:^|\/)(?:lib|types|dist|target|\.build|build)(?:\/|$)/u.test(file)
    || /(?:GENERATED|@generated|auto-generated)/u.test(source.slice(0, 800))) return 'generated'
  if (/(?:^|\/)(?:scripts|website)(?:\/|$)/u.test(file)
    || file.endsWith('/Package.swift')
    || file.startsWith('packages/test-support/')
    || /(?:^|\/)(?:tsdown|vitest|vite|rollup)\.config\./u.test(file)
    || /\/(?:build-native|pack-runtime|runtime-plan|runtime-closure)\.mjs$/u.test(file)) return 'tooling'
  return 'runtime'
}

function fit(file: string, surface: Surface): string {
  for (const assessment of assessments) {
    if (assessment.file !== file) continue
    if ('prefix' in assessment ? surface.name.startsWith(assessment.prefix) : (assessment.names as readonly string[]).includes(surface.name)) {
      return assessment.decision
    }
  }
  if (['remote', 'tool-declaration', 'tool-registration', 'command'].includes(surface.kind)) return 'KEEP_TS_AUTHORITY'
  if (file === 'packages/host/knowledge-wiki/src/search.ts' && ['tokenize', 'bm25', 'scorePages'].includes(surface.name)) {
    return 'PURE_KERNEL_CANDIDATE_RETAIN_TS'
  }
  if (file === 'packages/host/knowledge-wiki/src/graph.ts' && ['louvain', 'buildTargetLookup', 'resolveTarget', 'extractWikiLinkTargets'].includes(surface.name)) {
    return 'PURE_KERNEL_CANDIDATE_UNMEASURED'
  }
  if (file === 'packages/host/knowledge-wiki/src/search.ts' && surface.name === 'cosine') return 'PURE_KERNEL_CANDIDATE_UNMEASURED'
  return 'KEEP_CURRENT_PENDING_REVIEW'
}

function parseLayer(root: string, file: string): PatchOptions[] {
  const value = loadCordisYaml(readFileSync(resolve(root, file), 'utf8'))
  if (!Array.isArray(value)) throw new Error(`language census: ${file} is not a patch list`)
  // Repository-owned configuration is composed by its existing owner; !!js remains inert data.
  return value as PatchOptions[]
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, '../..')
  const packages = collectPackageGraph(root, [], 'language census').sort((a, b) => a.rel.localeCompare(b.rel))
  const manifests = globSync('packages/*/*/package.json', { cwd: root }).map(file => file.replaceAll('\\', '/'))
  if (packages.length === 0 || packages.length !== manifests.length) throw new Error('language census: narrowed or empty package graph')
  const workspace = loadCordisYaml(readFileSync(resolve(root, 'pnpm-workspace.yaml'), 'utf8')) as { packages: string[] }
  const areas = [...new Set([...workspace.packages.map(path => path.split('/')[0] ?? path), 'integrations', 'rust', 'python'])].sort()
  const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...areas], { cwd: root, encoding: 'utf8' })
  const files = [...new Set(tracked.split('\0').filter(file => /\.(?:[cm]?tsx?|jsx?|[cm]js|swift|rs|py|c|h)$/u.test(file)))].sort()
  const hash = createHash('sha256')
  const sources = files.map((file) => {
    const bytes = readFileSync(resolve(root, file))
    hash.update(file).update('\0').update(bytes).update('\0')
    const source = bytes.toString('utf8')
    const role = sourceRole(file, source)
    const language = file.endsWith('.swift') ? 'Swift' : file.endsWith('.rs') ? 'Rust' : file.endsWith('.py') ? 'Python'
      : /\.[ch]$/u.test(file) ? 'C' : /\.[cm]?tsx?$/u.test(file) ? 'TypeScript' : 'JavaScript'
    const surfaces = role === 'runtime' && ['TypeScript', 'JavaScript'].includes(language) ? declaredSurfaces(file, source) : []
    return {
      file, role, language, sha256: createHash('sha256').update(bytes).digest('hex'),
      surfaces: surfaces.map(surface => ({ ...surface, fit: fit(file, surface) })),
    }
  })
  for (const area of ['packages', 'vendor', 'apps', 'integrations', 'native', 'python', 'rust']) {
    if (!sources.some(source => source.file.startsWith(`${area}/`))) throw new Error(`language census: empty ${area} corpus`)
  }
  const sourceFiles = sources.filter(source => source.role === 'runtime').map(source => source.file)
  const context = contextMergeFiles(root, sourceFiles.filter(file => file.endsWith('.ts'))).map(({ rel, sf, body }) => ({
    file: rel,
    services: Object.fromEntries(contextKeyMap(body, sf)),
    events: eventNameList(body, sf),
  }))
  const catalog = await collectToolCatalog()
  const toolNames = [...new Set([
    ...catalog.flatMap(entry => entry.schemas.map(schema => schema.name)),
    ...sources.flatMap(source => source.surfaces.filter(surface =>
      ['tool-declaration', 'tool-registration'].includes(surface.kind) && surface.resolution === 'literal').map(surface => surface.name)),
  ])].sort()
  const profile = 'integrations/jiuzhang/profile/cordis.patch.yml'
  const layers = ['packages/bundle/base/cordis.patch.yml', 'packages/bundle/native-api-app/cordis.patch.yml', profile]
  const warnings: string[] = []
  const rows = composeEntries(layers.map(file => parseLayer(root, file)), warning => warnings.push(warning))
  if (warnings.length > 0) throw new Error(`language census: composition warnings ${warnings.join('; ')}`)
  const flatten = (
    entries: readonly Record<string, unknown>[], parentDisabled: unknown = false,
  ): Record<string, unknown>[] => entries.flatMap(entry => [{
    id: entry.id, name: entry.name,
    disabled: isJsExpr(entry.disabled) ? entry.disabled.__jsExpr : entry.disabled ?? false,
    parentDisabled,
  }, ...Array.isArray(entry.config) ? flatten(entry.config, entry.disabled ?? parentDisabled) : []])
  const presets = globSync('packages/boot/profile-runner/config/agent-presets/*/agent.cordis.yml', { cwd: root }).map(file => file.replaceAll('\\', '/')).sort()
  if (presets.length === 0) throw new Error('language census: empty Native preset corpus')
  const allSurfaces = sources.flatMap(source => source.surfaces)
  const reviewed = assessments.map((assessment) => {
    const matches = sources.filter(source => source.file === assessment.file).flatMap(source => source.surfaces.filter(surface =>
      'prefix' in assessment ? surface.name.startsWith(assessment.prefix) : (assessment.names as readonly string[]).includes(surface.name)))
    if (matches.length === 0 || ('names' in assessment && assessment.names.some(name => !matches.some(surface => surface.name === name)))) {
      throw new Error(`language census: assessment has no current declaration ${assessment.file}`)
    }
    return { ...assessment, declarations: matches.map(({ kind, name, line }) => ({ kind, name, line })), performanceEvidence: 'UNKNOWN' }
  })
  const counts = <T>(values: readonly T[], key: (value: T) => string): Record<string, number> => {
    const result: Record<string, number> = {}
    for (const value of values) result[key(value)] = (result[key(value)] ?? 0) + 1
    return result
  }
  const output = {
    schemaVersion: 1,
    gitSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    generatorHash: createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex'),
    codeDigest: hash.digest('hex'),
    scope: { areas, sourceDiscovery: 'git tracked and non-ignored untracked code; exclusions remain listed with their role' },
    status: { sourceCensus: 'COMPLETE_FOR_DECLARED_SCOPE', semanticReview: 'PARTIAL', runtimeVerification: 'UNKNOWN', languageBenefit: 'UNKNOWN' },
    limitations: [
      'Declarations and catalog harvest are not a complete enumeration of user behaviors or successful runtime calls.',
      'Dynamic imports, MCP server schemas, user plugins/presets/settings and environment expressions require a live composition receipt.',
      'Swift/C/Rust/Python source files are enumerated; their individual controls/functions are not parsed by the TypeScript AST.',
      'KEEP_TS_AUTHORITY preserves the contract owner; it does not prove that every internal computation should use TypeScript.',
      'KEEP_CURRENT_PENDING_REVIEW is an unreviewed item, not a measured TypeScript win.',
    ],
    summary: {
      harnessPackages: packages.length, groups: new Set(packages.map(pkg => pkg.group)).size,
      codeFiles: sources.length, byRole: counts(sources, source => source.role),
      runtimeLanguages: counts(sources.filter(source => source.role === 'runtime'), source => source.language),
      declaredSurfaces: counts(allSurfaces, surface => surface.kind), fit: counts(allSurfaces, surface => surface.fit),
      harvestedTools: catalog.reduce((sum, entry) => sum + entry.schemas.length, 0),
      harvestedToolNames: new Set(catalog.flatMap(entry => entry.schemas.map(schema => schema.name))).size,
      catalogAndLiteralToolNames: toolNames.length,
      unresolvedRegistrationSites: allSurfaces.filter(surface =>
        ['tool-declaration', 'tool-registration', 'command'].includes(surface.kind) && surface.resolution === 'expression').length,
      contextServices: context.reduce((sum, entry) => sum + Object.keys(entry.services).length, 0),
    },
    packages: packages.map(pkg => ({
      ...pkg, decision: 'KEEP_CURRENT_PENDING_FUNCTION_REVIEW',
      manifestHash: createHash('sha256').update(readFileSync(resolve(root, pkg.rel, 'package.json'))).digest('hex'),
      codeFiles: sources.filter(source => source.file.startsWith(`${pkg.rel}/`)).length,
    })),
    functionAssessments: reviewed,
    catalogAndLiteralToolNames: toolNames,
    sourceComposition: {
      profile: 'jiuzhang',
      inputs: [...layers, ...presets, 'integrations/jiuzhang/profile/package.json', 'pnpm-workspace.yaml'].map(file => ({
        file, sha256: createHash('sha256').update(readFileSync(resolve(root, file))).digest('hex'),
      })),
      rows: flatten(rows as unknown as Record<string, unknown>[]),
      presets: presets.map(file => ({ file, rows: flatten(parseLayer(root, file) as Record<string, unknown>[]) })),
      expressionsEvaluated: false, runtimeConfirmed: false,
    },
    harvestedTools: catalog.map(entry => ({
      package: entry.pkg, sources: entry.sources, names: entry.schemas.map(schema => schema.name),
      requires: entry.requires, writes: entry.writes, shippedNames: entry.shippedNames ?? [],
    })),
    context,
  }
  const metadata = JSON.stringify(output, null, 2).slice(0, -2)
  const records = sources.map(source => JSON.stringify(source)).join(',\n')
  writeFileSync(resolve(root, 'scripts/rust-migration/function-language-inventory.json'), `${metadata},\n  "sources": [\n${records}\n  ]\n}\n`)
  process.stdout.write(JSON.stringify(output.summary, null, 2) + '\n')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) await main()
