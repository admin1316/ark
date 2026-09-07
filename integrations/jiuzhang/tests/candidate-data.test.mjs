import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { candidateDataPlan, applyCandidateDataPlan } from '../native/candidate-data.mjs'
import { createLaunchEnvironment, defaultJiuzhangHome, resolveLaunchHome } from '../src/runtime.mjs'

const root = fs.realpathSync(fs.mkdtempSync('/tmp/ark-candidate-data-tests-'))
const repository = fileURLToPath(new URL('../../../', import.meta.url))
const native = path.join(repository, 'integrations/jiuzhang/native')
const profile = path.join(repository, 'integrations/jiuzhang/profile/cordis.patch.yml')
const home = path.join(root, 'home')
fs.mkdirSync(home, { mode: 0o700 })
console.log('CANDIDATE_ISOLATION_EVIDENCE=' + root)
const environment = { JIUZHANG_CANDIDATE_BUILD: '1', JIUZHANG_CANDIDATE_DATA_HOME: home }
const infoBytes = fs.readFileSync(path.join(native, 'Resources/Info.plist'))
const hash = value => createHash('sha256').update(value).digest('hex')
const commands = []
function execute(label, program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options })
  const log = (result.stdout ?? '') + '\n' + (result.stderr ?? '')
  fs.writeFileSync(path.join(root, label + '.log'), log)
  commands.push({ label, command: [program, ...args], realRC: result.status, signal: result.signal, logSHA256: hash(log) })
  assert.ifError(result.error)
  return result
}

test('production build ignores candidate home without explicit opt-in', () => {
  assert.deepEqual(candidateDataPlan({ JIUZHANG_CANDIDATE_DATA_HOME: home }), { candidate: false })
  const output = path.join(root, 'unchanged.plist')
  fs.writeFileSync(output, infoBytes)
  applyCandidateDataPlan(output, { candidate: false })
  assert.equal(hash(fs.readFileSync(output)), hash(infoBytes))
})
test('candidate metadata binds a private home and a separate preferences domain', () => {
  const plan = candidateDataPlan(environment)
  assert.equal(plan.home, home)
  assert.match(plan.bundleIdentifier, /^cn\.jiuzhangtianmu\.industrybrain\.candidate\.[a-z0-9]+$/u)
  const app = path.join(root, 'candidate', 'Ark.app')
  fs.mkdirSync(path.join(app, 'Contents'), { recursive: true })
  const info = path.join(app, 'Contents/Info.plist')
  fs.writeFileSync(info, infoBytes)
  applyCandidateDataPlan(info, plan)
  const result = execute('read-candidate-info', '/usr/bin/plutil', ['-convert', 'json', '-o', '-', info])
  assert.equal(result.status, 0)
  const actual = JSON.parse(result.stdout)
  assert.equal(actual.ArkCandidateBuild, true)
  assert.equal(actual.ArkCandidateDataHome, home)
  assert.equal(actual.CFBundleIdentifier, plan.bundleIdentifier)
})
test('empty, invalid, shared, source and symlink homes fail closed', () => {
  for (const value of ['', 'relative', '/', repository]) assert.throws(() => candidateDataPlan({ ...environment, JIUZHANG_CANDIDATE_DATA_HOME: value }))
  const shared = path.join(root, 'shared'); fs.mkdirSync(shared, { mode: 0o755 })
  assert.throws(() => candidateDataPlan({ ...environment, JIUZHANG_CANDIDATE_DATA_HOME: shared }))
  const link = path.join(root, 'home-link'); fs.symlinkSync(home, link)
  assert.throws(() => candidateDataPlan({ ...environment, JIUZHANG_CANDIDATE_DATA_HOME: link }))
})
test('build entry uses the candidate metadata preflight without building an app', () => {
  const result = execute('build-data-preflight', '/bin/zsh', [path.join(native, 'build-app.sh'), '--check-candidate-data'], { env: { ...process.env, ...environment } })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).home, home)
})
test('native launch rejects incomplete or contradictory data ownership before profile writes', () => {
  const complete = {
    JIUZHANG_DSH_HOME: home, DSH_HOME: home,
    ARK_MAIN_ROOT: path.join(home, 'Knowledge'),
    ARK_WIKI_ROOT: path.join(home, 'Knowledge/wiki'),
    ARK_DEFAULT_WORKSPACE: path.join(home, 'Default Workspace'),
  }
  assert.equal(resolveLaunchHome(complete, { native: true }), home)
  for (const key of Object.keys(complete)) {
    for (const value of [undefined, '', path.join(root, 'wrong-owner')]) {
      const broken = { ...complete, [key]: value }
      assert.throws(() => resolveLaunchHome(broken, { native: true }))
    }
  }
  assert.throws(() => resolveLaunchHome({}, { native: true }))
  assert.equal(resolveLaunchHome({}), defaultJiuzhangHome())
  assert.equal(resolveLaunchHome({ DSH_HOME: path.join(root, 'ambient-home') }), defaultJiuzhangHome())
  assert.equal(resolveLaunchHome({ JIUZHANG_DSH_HOME: home, DSH_HOME: path.join(root, 'ambient-home') }), home)
  const productionHome = defaultJiuzhangHome()
  const productionRoot = path.dirname(productionHome)
  assert.equal(resolveLaunchHome({
    JIUZHANG_DSH_HOME: productionHome, DSH_HOME: productionHome,
    ARK_MAIN_ROOT: path.join(productionRoot, 'Knowledge'),
    ARK_WIKI_ROOT: path.join(productionRoot, 'Knowledge/wiki'),
    ARK_DEFAULT_WORKSPACE: path.join(productionRoot, 'Default Workspace'),
  }, { native: true }), productionHome)
  const rejectedHome = path.join(root, 'rejected-native-home')
  fs.mkdirSync(rejectedHome, { mode: 0o700 })
  const rejected = execute('launcher-rejects-lost-identity', process.execPath, [
    path.join(repository, 'integrations/jiuzhang/src/start.mjs'),
    '--parent-pid', String(process.pid),
  ], { env: { PATH: process.env.PATH, TMPDIR: root, DSH_HOME: rejectedHome } })
  assert.equal(rejected.status, 1, rejected.stderr)
  assert.match(rejected.stderr, /Native launch lost its explicit data-home identity/u)
  assert.deepEqual(fs.readdirSync(rejectedHome), [])
})
test('production credentials retain the provider default; isolated homes get distinct namespaces', () => {
  const production = createLaunchEnvironment(defaultJiuzhangHome(), { ARK_KEYCHAIN_SERVICE: 'injected' })
  assert.equal(production.ARK_KEYCHAIN_SERVICE, undefined)
  const candidate = createLaunchEnvironment(home, { ARK_KEYCHAIN_SERVICE: 'injected' })
  assert.equal(candidate.DSH_HOME, home)
  assert.match(candidate.ARK_KEYCHAIN_SERVICE, /^ark\.candidate\.credentials\.[a-f0-9]{64}$/u)
  assert.notEqual(candidate.ARK_KEYCHAIN_SERVICE, createLaunchEnvironment(path.join(root, 'other')).ARK_KEYCHAIN_SERVICE)
  const yaml = createRequire(path.join(repository, 'package.json'))('js-yaml')
  const js = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value })
  const patch = yaml.load(fs.readFileSync(profile, 'utf8'), { schema: yaml.DEFAULT_SCHEMA.extend(js) })
  const credentials = patch.find(entry => entry.id === 'credentials')
  assert.equal(credentials.config.keychainService, 'process.env.ARK_KEYCHAIN_SERVICE')
})
test('actual backend home resolver places sessions and workspace/projection storage under candidate home', () => {
  const baseComposition = fs.readFileSync(path.join(repository, 'packages/bundle/base/cordis.patch.yml'), 'utf8')
  const nativeComposition = fs.readFileSync(path.join(repository, 'packages/bundle/native-api-app/cordis.patch.yml'), 'utf8')
  assert.match(baseComposition, /root: !!js dshHomePath\('sessions'\)/u)
  assert.match(nativeComposition, /root: !!js dshHomePath\('storages'\)/u)
  const moduleURL = new URL('../../../packages/util/home-paths/src/index.ts', import.meta.url).href
  const script = `import { dshHomePath, resolveDshHome } from ${JSON.stringify(moduleURL)}; console.log(JSON.stringify({ home:resolveDshHome(),sessions:dshHomePath('sessions'),storages:dshHomePath('storages') }));`
  const result = execute('backend-home-resolver', process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, DSH_HOME: home } })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { home, sessions: path.join(home, 'sessions'), storages: path.join(home, 'storages') })
})
test('Swift contract resolves candidate paths, rejects production overlap, and writes only candidate state', () => {
  const probe = path.join(root, 'probe.swift')
  const body = `import Foundation\nimport Darwin\n@main struct CandidateProbe { static func main() throws {\nlet fm = FileManager.default\nlet root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)\nlet prod = root.appendingPathComponent("production", isDirectory: true)\ntry fm.createDirectory(at: prod, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])\nlet home = root.appendingPathComponent("home", isDirectory: true)\nlet id = "cn.jiuzhangtianmu.industrybrain.candidate.012345abcdef"\nlet info: [String:Any] = ["ArkCandidateBuild":true,"ArkCandidateDataHome":home.path,"CFBundleIdentifier":id]\nlet p = try JiuzhangShellContract.launchDataLocations(info: [:], productionRoot: prod)\nprecondition(p.harnessHome == prod.appendingPathComponent("Harness", isDirectory:true))\nlet ignored = try JiuzhangShellContract.launchDataLocations(info: ["ArkCandidateDataHome":home.path], productionRoot: prod)\nprecondition(ignored == p)\nlet c = try JiuzhangShellContract.launchDataLocations(info: info, productionRoot: prod)\nprecondition(c.isCandidate && c.harnessHome.path == home.path && c.harnessHome != p.harnessHome)\nfor url in [c.knowledgeRoot,c.wikiRoot,c.sessionWorkspace,c.workbenchDrafts,c.logs] { precondition(url.path.hasPrefix(home.path + "/")) }\nlet env = JiuzhangShellContract.childEnvironment(base: ["HOME":"unchanged-os-home","JIUZHANG_DSH_HOME":prod.path], harnessHome:c.harnessHome, apiToken:"nonsecret-probe", dataLocations:c)\nprecondition(env["HOME"] == "unchanged-os-home" && env["DSH_HOME"] == home.path && env["JIUZHANG_DSH_HOME"] == home.path)\nprecondition(env["ARK_MAIN_ROOT"] == c.knowledgeRoot.path && env["ARK_DEFAULT_WORKSPACE"] == c.sessionWorkspace.path && env["ARK_WIKI_ROOT"] == c.wikiRoot.path)\nfor value in ["", "relative", "/", prod.path, prod.appendingPathComponent("Harness").path] { var invalid=info; invalid["ArkCandidateDataHome"]=value; do { _=try JiuzhangShellContract.launchDataLocations(info:invalid,productionRoot:prod); fatalError("invalid home accepted") } catch is JiuzhangCandidateDataError {} }\nvar wrongID=info; wrongID["CFBundleIdentifier"]="cn.jiuzhangtianmu.industrybrain"\ndo { _=try JiuzhangShellContract.launchDataLocations(info:wrongID,productionRoot:prod); fatalError("production identity accepted for candidate") } catch is JiuzhangCandidateDataError {}\nfor name in ["sessions", "projcache", "workspace-registry", "runtime-state", "logs"] { let directory=c.harnessHome.appendingPathComponent(name,isDirectory:true); try fm.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700]); try Data("candidate".utf8).write(to:directory.appendingPathComponent("probe")) }\ntry Data("candidate".utf8).write(to:c.harnessHome.appendingPathComponent("settings.yaml"))\nlet productionContents = try fm.contentsOfDirectory(atPath:prod.path)\nprecondition(productionContents.isEmpty)\nprint("CANDIDATE_DATA_CONTRACT_PASS")\n} }\n`
  fs.writeFileSync(probe, body)
  const moduleCache = path.join(root, 'modules'); fs.mkdirSync(moduleCache)
  const binary = path.join(root, 'candidate-probe')
  const compiled = execute('compile-swift-data-contract', '/usr/bin/swiftc', ['-module-cache-path', moduleCache, path.join(native, 'Sources/JiuzhangShellCore/ShellContract.swift'), probe, '-o', binary], { env: { ...process.env, TMPDIR: root } })
  assert.equal(compiled.status, 0, compiled.stderr)
  const run = execute('swift-data-contract', binary, [root])
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /CANDIDATE_DATA_CONTRACT_PASS/u)
})
test('candidate bundle identity cannot fall back to production when its marker is missing or false', () => {
  const binary = path.join(root, 'candidate-marker-probe')
  const compiled = execute('compile-candidate-marker', '/usr/bin/swiftc', [
    '-module-cache-path', path.join(root, 'marker-modules'),
    path.join(native, 'Sources/JiuzhangShellCore/ShellContract.swift'),
    fileURLToPath(new URL('./fixtures/candidate-startup-negative.swift', import.meta.url)),
    '-o', binary,
  ], { env: { ...process.env, TMPDIR: root } })
  assert.equal(compiled.status, 0, compiled.stderr)
  const result = execute('candidate-marker-regression', binary, [root])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /CANDIDATE_MARKER_REGRESSION_PASS/u)
})
test('Swift child environment cannot be called without validated data locations', () => {
  for (const [label, argument, expected] of [
    ['missing', '', /missing argument for parameter 'dataLocations'/u],
    ['nil', ', dataLocations: nil', /nil.*not compatible.*JiuzhangDataLocations/u],
  ]) {
    const probe = path.join(root, `locations-${label}.swift`)
    const binary = path.join(root, `locations-${label}`)
    fs.writeFileSync(probe, `import Foundation\n@main enum MissingLocations { static func main() {\n_ = JiuzhangShellContract.childEnvironment(base: [:], harnessHome: URL(fileURLWithPath: CommandLine.arguments[1]), apiToken: "nonsecret-probe"${argument})\n} }\n`)
    const compiled = execute(`compile-locations-${label}`, '/usr/bin/swiftc', [
      '-module-cache-path', path.join(root, 'locations-modules'),
      path.join(native, 'Sources/JiuzhangShellCore/ShellContract.swift'), probe, '-o', binary,
    ], { env: { ...process.env, TMPDIR: root } })
    assert.equal(compiled.status, 1, compiled.stderr)
    assert.match(compiled.stderr, expected)
    assert.equal(fs.existsSync(binary), false)
  }
})
after(() => fs.writeFileSync(path.join(root, 'commands.json'), JSON.stringify(commands, null, 2) + '\n'))
