/** Source-verified native compilation, explicit-entry bundling and reflection generation. */
import { spawnSync } from 'node:child_process'
import { existsSync, globSync, lstatSync, readFileSync } from 'node:fs'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { isBuiltin } from 'node:module'
import yaml from 'js-yaml'
import { createArkRuntimePlan } from './runtime-plan.mjs'
import { assertJavaScriptModuleSyntax, packageJavaScriptEntries } from './runtime-closure.mjs'

const JS = /\.[cm]?js$/u
const DECLARATION = /\.d\.[cm]?ts$/u
const configurationSchema = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: source => ({ expression: source }) }),
])

/** Enumerate literal first-party plugin references without evaluating configuration code. */
export function nativeConfigurationModules(value) {
  const modules = new Set()
  const visit = (node) => {
    if (Array.isArray(node)) { for (const child of node) visit(child); return }
    if (node === null || typeof node !== 'object' || node.disabled === true) return
    if (typeof node.name === 'string' && node.name.startsWith('@deepseek-ai/')) {
      modules.add(node.name.split('/').slice(0, 2).join('/'))
    }
    for (const child of Object.values(node)) visit(child)
  }
  visit(value)
  return [...modules].sort()
}

function safeRelative(value) {
  const path = value.startsWith('./') ? value.slice(2) : value
  if (isAbsolute(path) || path.includes('\\') || path.split('/').includes('..') || path === '') {
    throw new Error(`native build entry is outside its package: ${value}`)
  }
  return path
}

function exportPairs(value, pairs, types) {
  if (typeof value === 'string') {
    if (JS.test(value) && types !== undefined) pairs.set(safeRelative(value), safeRelative(types))
    return
  }
  if (Array.isArray(value)) {
    for (const child of value) exportPairs(child, pairs, types)
    return
  }
  if (value === null || typeof value !== 'object') return
  const ownTypes = typeof value.types === 'string' ? value.types : types
  for (const [key, child] of Object.entries(value)) if (key !== 'types') exportPairs(child, pairs, ownTypes)
}

/** Build an explicit source-to-artifact map; retained lib files never establish a source entry. */
export function nativePackageEntries(packageRoot, manifest, configPath) {
  const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')) },
  })
  if (config === undefined || config.errors.length > 0) throw new Error(`native build cannot parse ${configPath}`)
  const compiled = new Map()
  const declarations = new Map()
  for (const file of config.fileNames) {
    if (DECLARATION.test(file)) continue
    const sourcePath = relative(packageRoot, file)
    if (sourcePath.startsWith('..') || isAbsolute(sourcePath)) throw new Error(`native compiler source escapes its package: ${file}`)
    if (!existsSync(file)) throw new Error(`native source file is missing: ${file}`)
    const outputs = ts.getOutputFileNames(config, file, !ts.sys.useCaseSensitiveFileNames)
    for (const output of outputs) {
      const path = relative(join(packageRoot, 'lib'), output)
      if (path.startsWith('..') || isAbsolute(path)) throw new Error(`native compiler output escapes package lib: ${output}`)
    }
    const javascript = outputs.find(output => JS.test(output))
    if (javascript === undefined) continue
    compiled.set(resolve(javascript), file)
    for (const output of outputs) if (DECLARATION.test(output)) declarations.set(resolve(output), resolve(javascript))
  }
  if (compiled.size === 0) throw new Error(`native package has no compilable implementation: ${manifest.name}`)
  const pairs = new Map()
  if (typeof manifest.main === 'string' && typeof manifest.types === 'string') pairs.set(safeRelative(manifest.main), safeRelative(manifest.types))
  exportPairs(manifest.exports, pairs)
  const published = new Set([
    ...packageJavaScriptEntries(manifest),
    ...(manifest.files ?? []).filter(path => typeof path === 'string' && JS.test(path) && !path.includes('*')),
  ])
  const entries = []
  for (const raw of published) {
    const target = safeRelative(raw)
    if (target.startsWith('src/')) continue
    if (target.startsWith('lib/typert.')) continue
    if (target.includes('*')) {
      if (!target.startsWith('lib/') || target.startsWith('lib/types/')) continue
      throw new Error(`native build requires an explicit artifact mapping for ${manifest.name}: ${target}`)
    }
    if (!JS.test(target)) continue
    const output = resolve(packageRoot, target)
    if (!target.startsWith('lib/') && existsSync(output) && lstatSync(output).isFile()) {
      entries.push({ input: output, output, source: output, passthrough: true })
      continue
    }
    const declared = pairs.get(target)
    const byDeclaration = declared === undefined ? undefined : declarations.get(resolve(packageRoot, declared))
    const conventional = resolve(packageRoot, 'lib/types', target.replace(/^lib\//u, '').replace(JS, '.js'))
    const input = byDeclaration ?? (compiled.has(output) ? output : compiled.has(conventional) ? conventional : undefined)
    if (input === undefined) throw new Error(`native artifact has no current-source implementation: ${manifest.name}:${target}`)
    entries.push({ input, output, source: compiled.get(input), passthrough: input === output })
  }
  return entries.sort((a, b) => a.output.localeCompare(b.output))
}

/** Derive the native compiler roots and all declared executable exports from the runtime plan. */
export async function nativeBuildSpec(root) {
  const repositoryRoot = await realpath(resolve(root))
  const plan = await createArkRuntimePlan(repositoryRoot, { sourceOnly: true })
  const packages = []
  const references = []
  const configurations = new Set([join(repositoryRoot, 'integrations/jiuzhang/profile/cordis.patch.yml')])
  for (const entry of plan.packages) {
    const packageRoot = join(repositoryRoot, entry.directory)
    const host = join(packageRoot, 'tsconfig.host.json')
    const ordinary = join(packageRoot, 'tsconfig.json')
    const configPath = existsSync(host) ? host : ordinary
    if (!existsSync(configPath)) throw new Error(`native package lacks its compiler project: ${entry.name}`)
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
    if (typeof manifest.dsh?.bundle?.patch === 'string') configurations.add(join(packageRoot, safeRelative(manifest.dsh.bundle.patch)))
    const presets = manifest.exports?.['./config/agent-presets/*']
    if (typeof presets === 'string') {
      const directory = safeRelative(presets).split('*')[0]
      for (const file of globSync(join(packageRoot, directory, '**/*.cordis.yml'))) configurations.add(file)
    }
    references.push({ path: './' + (configPath === host ? relative(repositoryRoot, host) : entry.directory).replaceAll('\\', '/') })
    packages.push({ ...entry, packageRoot, manifest, entries: nativePackageEntries(packageRoot, manifest, configPath) })
  }
  const names = new Set(plan.packages.map(pkg => pkg.name))
  for (const path of configurations) {
    if (await realpath(path) !== resolve(path) || !lstatSync(path).isFile()) throw new Error(`native configuration must be an ordinary source file: ${path}`)
    const modules = nativeConfigurationModules(yaml.load(await readFile(path, 'utf8'), { schema: configurationSchema }))
    const missing = modules.filter(name => !names.has(name))
    if (missing.length > 0) throw new Error(`native configuration references undeclared runtime packages (${relative(repositoryRoot, path)}): ${missing.join(', ')}`)
  }
  return { plan, packages, compiler: { extends: './tsconfig.base.json', files: [], references } }
}

function runNode(root, args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' })
  if (result.error !== undefined || result.signal !== null || result.status !== 0) {
    throw new Error(`native build stage failed: ${result.error?.message ?? result.signal ?? result.status}`)
  }
}

/** Compare generated strict descriptors with the native consumer's existing route inventory. */
export function nativeEndpointCoverage(descriptors, endpoints, owners) {
  const entries = new Map()
  const duplicates = []
  for (const descriptor of descriptors) {
    const endpoint = `${descriptor.namespace}/${descriptor.method}`
    if (entries.has(endpoint)) duplicates.push(endpoint)
    entries.set(endpoint, descriptor)
  }
  const missing = endpoints.filter(endpoint => !entries.has(endpoint))
  const wrongOwners = endpoints.filter(endpoint => entries.has(endpoint) && entries.get(endpoint).service !== owners[endpoint])
  const nonStrict = endpoints.filter(endpoint => entries.has(endpoint) && entries.get(endpoint).result.mode !== 'strict')
  return { required: endpoints.length, covered: endpoints.length - missing.length, missing, wrongOwners, nonStrict, duplicates }
}

/** Generated code is executable package content and must declare its runtime imports. */
export function verifyNativeGeneratedImports(source, manifest) {
  const parsed = ts.createSourceFile('typert.host.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  for (const node of parsed.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue
    const specifier = node.moduleSpecifier.text
    if (specifier.startsWith('.') || isBuiltin(specifier)) continue
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
    if (manifest.dependencies?.[name] === undefined && manifest.peerDependencies?.[name] === undefined) {
      throw new Error(`native generated runtime import is undeclared: ${manifest.name} -> ${name}`)
    }
  }
}

/** Compile verified sources, emit each published entry independently, then generate Native reflection. */
export async function buildNative(root) {
  root = await realpath(resolve(root))
  const spec = await nativeBuildSpec(root)
  const actual = JSON.parse(await readFile(join(root, 'tsconfig.native.json'), 'utf8'))
  if (JSON.stringify(actual) !== JSON.stringify(spec.compiler)) throw new Error('tsconfig.native.json is stale; run build:native --write-config')
  runNode(root, [join(root, 'node_modules/typescript/bin/tsc'), '-b', 'tsconfig.native.json', 'packages/typert/generator', '--force', '--stopBuildOnErrors', '--pretty', 'false'])
  const { build } = await import('tsdown')
  const entries = spec.packages.flatMap(pkg => pkg.entries.map(entry => ({ pkg, entry })))
  let completed = 0
  for (const { pkg, entry } of entries) {
    if (!existsSync(entry.input)) throw new Error(`native compiler did not emit ${entry.input}`)
    if (!entry.passthrough) {
      const extension = extname(entry.output)
      const format = extension === '.cjs' ? 'cjs' : 'esm'
      await build({
        config: false, cwd: pkg.packageRoot,
        entry: { [basename(entry.output, extension)]: entry.input }, outDir: dirname(entry.output),
        format, platform: 'node', target: 'es2024', dts: false, clean: false, sourcemap: false,
        outputOptions: { codeSplitting: false },
        outExtensions: () => ({ js: extension }), envPrefix: [], logLevel: 'warn', report: false, failOnWarn: true,
        // Self-imports share the published owner's state; resolving them through source paths duplicates the owner.
        deps: { neverBundle: [pkg.manifest.name, ...Object.keys({ ...pkg.manifest.dependencies, ...pkg.manifest.peerDependencies, ...pkg.manifest.optionalDependencies })] },
      })
    }
    if (!existsSync(entry.output)) throw new Error(`native bundler did not emit ${entry.output}`)
    assertJavaScriptModuleSyntax(await readFile(entry.output, 'utf8'), `${pkg.manifest.name}:${relative(pkg.packageRoot, entry.output)}`, process.execPath, pkg.manifest.type)
    completed++
    if (completed % 25 === 0 || completed === entries.length) console.log(`native build: ${completed}/${entries.length} entries`)
  }
  const { WorkspaceTypertGenerator } = await import(pathToFileURL(join(root, 'packages/typert/generator/lib/types/workspace.js')).href)
  const { emitArtifacts } = await import(pathToFileURL(join(root, 'packages/typert/generator/lib/types/tsdown-plugin.js')).href)
  const reflected = spec.packages.filter(pkg => pkg.manifest.exports?.['./typert'] !== undefined).map(pkg => pkg.name)
  const generator = new WorkspaceTypertGenerator(root, { hostConfig: 'tsconfig.native.json', checkDiagnostics: false })
  const artifacts = generator.generate(reflected, ['host'])
  const descriptors = []
  for (const artifact of artifacts) {
    const manifest = spec.packages.find(pkg => pkg.name === artifact.package).manifest
    verifyNativeGeneratedImports(artifact.js, manifest)
    emitArtifacts(join(root, artifact.packageRoot), [artifact])
    const module = await import(pathToFileURL(join(root, artifact.packageRoot, 'lib/typert.host.js')).href)
    descriptors.push(...module.TYPERT.invocations)
  }
  const { NATIVE_TYPERT_REMOTE_ENDPOINTS, NATIVE_TYPERT_REMOTE_OWNERS } = await import(
    pathToFileURL(join(root, 'packages/api/gateway/lib/types/native-remote-routes.js')).href)
  const endpoints = nativeEndpointCoverage(descriptors, NATIVE_TYPERT_REMOTE_ENDPOINTS, NATIVE_TYPERT_REMOTE_OWNERS)
  const evidence = join(root, '.native-build')
  await mkdir(evidence, { recursive: true })
  await writeFile(join(evidence, 'build.json'), JSON.stringify({
    sourceDigestBeforeBuild: spec.plan.sourceDigest,
    packages: spec.packages.map(pkg => pkg.name),
    entries: entries.map(({ entry }) => ({ source: relative(root, entry.source), output: relative(root, entry.output) })),
    reflected: artifacts.map(artifact => artifact.package),
    endpoints,
  }, null, 2) + '\n')
  if ([endpoints.missing, endpoints.wrongOwners, endpoints.nonStrict, endpoints.duplicates].some(items => items.length > 0)) {
    throw new Error(`native endpoint implementation coverage failed: ${JSON.stringify(endpoints)}`)
  }
  console.log(`native build: ${spec.packages.length} source packages and ${artifacts.length} reflection contributions emitted`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
  const mode = process.argv[2]
  if (mode === '--write-config') {
    const spec = await nativeBuildSpec(root)
    await writeFile(join(root, 'tsconfig.native.json'), JSON.stringify(spec.compiler, null, 2) + '\n')
    console.log('native build: compiler aggregate refreshed')
  } else if (mode === '--check') {
    const spec = await nativeBuildSpec(root)
    const actual = JSON.parse(readFileSync(join(root, 'tsconfig.native.json'), 'utf8'))
    if (JSON.stringify(actual) !== JSON.stringify(spec.compiler)) throw new Error('native compiler aggregate differs from runtime closure')
    console.log(`native build: ${spec.packages.length} source packages verified`)
  } else if (mode === undefined) await buildNative(root)
  else throw new Error(`unknown native build option: ${mode}`)
}
