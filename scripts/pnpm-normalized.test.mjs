/** Real CLI preflight and adapter regressions; all generated inputs/output live under /tmp. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {createRequire} from 'node:module';
import {spawnSync, spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const source = path.resolve(import.meta.dirname, '..');
const runner = fileURLToPath(new URL('./pnpm-normalized.mjs', import.meta.url));
const toolchain = process.env.ARK_PNPM_TOOLCHAIN;
if (!toolchain) throw new Error('ARK_PNPM_TOOLCHAIN must identify the supported original pnpm package directory; tests never download it');
const evidence = fs.realpathSync(fs.mkdtempSync('/tmp/ark-pnpm-repo-tests-'));
console.log('PNPM_TEST_EVIDENCE=' + evidence);
const yaml = createRequire(path.join(source, 'package.json'))('js-yaml');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = name => fs.readFileSync(path.join(source, name));
const original = path.join(evidence, 'original');
fs.cpSync(toolchain, original, {recursive: true});
const lockBytes = read('pnpm-lock.yaml'), workspaceBytes = read('pnpm-workspace.yaml');
const realLock = yaml.load(lockBytes.toString()), realWorkspace = yaml.load(workspaceBytes.toString());
const realState = JSON.parse(read('node_modules/.pnpm-workspace-state-v1.json'));
const manifests = Object.fromEntries(Object.keys(realLock.importers).map(id => [id, read(path.join(id, 'package.json'))]));
const subjects = ['packages/host/knowledge-wiki', 'packages/examples/acp-demo', 'packages/settings/settings'];
const dep = '@deepseek-ai/schemastery', link = 'link:../../../vendor/schemastery';
const sentinel = 'PREFLIGHT_SENTINEL';
const baseEnv = {PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', TMPDIR: evidence, NODE_DISABLE_COMPILE_CACHE: '1', COREPACK_ENABLE_NETWORK: '0', pnpm_config_verify_deps_before_run: 'error'};
const commands = [], provenance = [];
const protectedPaths = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', ...subjects.map(p => p + '/package.json'), 'node_modules/.pnpm/lock.yaml', 'node_modules/.modules.yaml', 'node_modules/.pnpm-workspace-state-v1.json'];
const protectedBefore = protectedPaths.map(p => [p, sha(read(p))]);
const globalBefore = ['package.json', 'bin/pnpm.mjs', 'dist/pnpm.mjs'].map(p => [p, sha(fs.readFileSync(path.join(toolchain, p)))]);

function write(root, name, bytes, time = 1) {
  const dest = path.join(root, name);
  fs.mkdirSync(path.dirname(dest), {recursive: true});
  fs.writeFileSync(dest, bytes);
  fs.utimesSync(dest, time, time);
}
function json(root, name, value, time = 1) { write(root, name, JSON.stringify(value, null, 2) + '\n', time); }
function identities(root, names) { return names.toSorted().map(name => [name, sha(fs.readFileSync(path.join(root, name)))]); }

function fixture(id, {target = subjects[0], simple = false, mutate, hook} = {}) {
  const root = path.join(evidence, id);
  fs.mkdirSync(root);
  let entries = {...manifests}, workspace = structuredClone(realWorkspace), lock = structuredClone(realLock), settings = structuredClone(realState.settings);
  if (simple) {
    target = 'packages/normal';
    entries = {'.': Buffer.from(JSON.stringify({name: 'proof-root', version: '1.0.0', private: true, packageManager: 'pnpm@11.7.0'})), [target]: Buffer.from(JSON.stringify({name: 'proof-normal', version: '1.0.0', dependencies: {'proof-dep': '^1.0.0'}}))};
    workspace.packages = ['packages/*'];
    delete workspace.overrides; delete workspace.patchedDependencies;
    settings.workspacePackagePatterns = workspace.packages;
    delete settings.overrides; delete settings.patchedDependencies;
    lock = {lockfileVersion: '9.0', settings: {autoInstallPeers: true, excludeLinksFromLockfile: false}, importers: {'.': {}, [target]: {dependencies: {'proof-dep': {specifier: '^1.0.0', version: '1.2.0'}}}}, packages: {'proof-dep@1.2.0': {resolution: {integrity: 'sha512-Zml4dHVyZQ=='}}}, snapshots: {'proof-dep@1.2.0': {}}};
  } else {
    for (const [pkg, p] of Object.entries(realWorkspace.patchedDependencies ?? {})) {
      write(root, p, read(p));
      settings.patchedDependencies[pkg] = path.join(root, p);
    }
  }
  if (mutate) {
    const subject = JSON.parse(entries[target]), rootManifest = JSON.parse(entries['.']);
    mutate({subject, rootManifest, lock, target});
    entries[target] = Buffer.from(JSON.stringify(subject, null, 2) + '\n');
    entries['.'] = Buffer.from(JSON.stringify(rootManifest, null, 2) + '\n');
  }
  const names = ['pnpm-workspace.yaml', 'pnpm-lock.yaml', 'node_modules/.pnpm/lock.yaml'];
  for (const [importer, manifestBytes] of Object.entries(entries)) {
    write(root, path.join(importer, 'package.json'), manifestBytes, importer === target ? 3 : 1);
    fs.mkdirSync(path.join(root, importer, 'node_modules'), {recursive: true});
    names.push(path.join(importer, 'package.json'));
  }
  let pnpmfiles = [];
  if (hook) {
    write(root, '.pnpmfile.cjs', hook);
    names.push('.pnpmfile.cjs');
    pnpmfiles = [path.join(root, '.pnpmfile.cjs')];
    lock.pnpmfileChecksum = 'sha256-' + crypto.createHash('sha256').update(hook).digest('base64');
  }
  const exact = !simple && !mutate && !hook;
  write(root, 'pnpm-workspace.yaml', exact ? workspaceBytes : yaml.dump(workspace));
  const bytes = exact ? lockBytes : yaml.dump(lock);
  write(root, 'pnpm-lock.yaml', bytes, 3); write(root, 'node_modules/.pnpm/lock.yaml', bytes, 3);
  const state = {...structuredClone(realState), lastValidatedTimestamp: 2000, settings, pnpmfiles, projects: Object.fromEntries(Object.entries(entries).map(([importer, manifestBytes]) => {
    const m = JSON.parse(manifestBytes); return [path.join(root, importer), {name: m.name, version: m.version}];
  }))};
  assert(fs.statSync(path.join(root, target, 'package.json')).mtimeMs > state.lastValidatedTimestamp);
  const f = {id, root, target, state, names, identity: identities(root, names), canonicalBytes: exact};
  provenance.push(f);
  return f;
}

function record(label, args, options = {}) {
  const result = spawnSync(process.execPath, args, {cwd: evidence, env: baseEnv, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 40000, ...options});
  const log = (result.stdout ?? '') + '\n' + (result.stderr ?? '');
  const logPath = path.join(evidence, label + '.log');
  fs.writeFileSync(logPath, log, {flag: 'wx'});
  commands.push({label, command: [process.execPath, ...args], cwd: options.cwd ?? evidence, realRC: result.status, signal: result.signal, error: result.error?.message, logPath, logSha256: sha(log)});
  fs.writeFileSync(path.join(evidence, 'commands.json'), JSON.stringify(commands, null, 2) + '\n');
  assert.ifError(result.error); assert.equal(result.signal, null);
  return {...result, log};
}
function cliArgs(bin = toolchain, script = runner) { return [script, '--toolchain', bin, '--scratch-root', evidence, '--']; }
function replay(f, variant, expected, errorText) {
  json(f.root, 'node_modules/.pnpm-workspace-state-v1.json', f.state);
  assert.deepEqual(identities(f.root, f.names), f.identity);
  const command = ['exec', process.execPath, '-e', `console.log(${JSON.stringify(sentinel)})`];
  const args = variant === 'original' ? [path.join(original, 'bin/pnpm.mjs'), '--config.verify-deps-before-run=error', ...command] : [...cliArgs(), ...command];
  const r = record(f.id + '-' + variant, args, {cwd: f.root});
  assert.equal(r.status, expected);
  assert.equal(r.stdout.split(/\r?\n/u).includes(sentinel), expected === 0);
  if (errorText) assert(r.log.includes(errorText), r.log);
  assert.deepEqual(identities(f.root, f.names), f.identity);
}

for (const [index, target] of subjects.entries()) {
  test(`M${index + 1}: current override importer accepted only after normalization`, () => {
    const raw = JSON.parse(manifests[target]);
    assert.equal(raw.devDependencies[dep], 'workspace:^'); assert.equal(raw.peerDependencies[dep], 'workspace:^');
    assert.equal(realLock.importers[target].dependencies[dep].specifier, link);
    const f = fixture('M' + (index + 1), {target});
    replay(f, 'original', 1, 'does not satisfy project of id ' + target); replay(f, 'runner', 0);
  });
}
test('matching specifier with wrong dependency grouping remains rejected', () => {
  const f = fixture('GROUPING', {mutate: ({subject, lock, target}) => {
    subject.devDependencies[dep] = link;
    lock.importers[target].devDependencies[dep] = lock.importers[target].dependencies[dep];
    delete lock.importers[target].dependencies[dep];
  }});
  replay(f, 'original', 0); replay(f, 'runner', 1, 'does not satisfy project of id ' + f.target);
});
test('truly stale normalized specifier remains rejected', () => {
  const f = fixture('STALE_SPECIFIER', {mutate: ({lock, target}) => { lock.importers[target].dependencies[dep].specifier = 'link:../../../vendor/wrong-target'; }});
  for (const variant of ['original', 'runner']) replay(f, variant, 1, 'does not satisfy project of id ' + f.target);
});
test('ordinary no-override importer preserves behavior', () => {
  const f = fixture('NORMAL', {simple: true});
  for (const variant of ['original', 'runner']) replay(f, variant, 0);
});
test('resolved version outside declared range remains rejected', () => {
  const f = fixture('STALE_VERSION', {simple: true, mutate: ({lock, target}) => { lock.importers[target].dependencies['proof-dep'].version = '2.0.0'; }});
  for (const variant of ['original', 'runner']) replay(f, variant, 1, 'does not satisfy project of id ' + f.target);
});
for (const [id, body, errorText] of [
  ['THROWING_HOOK', "throw new Error('NORMALIZATION_FAILED')", 'NORMALIZATION_FAILED'],
  ['INVALID_HOOK_RESULT', 'return undefined', 'readPackage hook did not return a package manifest object.'],
]) {
  test(id + ' fails closed without raw-manifest fallback', () => {
    const f = fixture(id, {simple: true, hook: `module.exports = {hooks: {readPackage() {${body};}}};\n`});
    replay(f, 'original', 0); replay(f, 'runner', 1, errorText);
  });
}

function badToolchain(id, change) {
  const dir = path.join(evidence, id);
  for (const p of ['package.json', 'bin/pnpm.mjs', 'dist/pnpm.mjs']) write(dir, p, fs.readFileSync(path.join(toolchain, p)));
  change(dir); return dir;
}
function reject(label, args, diagnostic, options) {
  const r = record(label, args, options);
  assert.notEqual(r.status, 0); assert(r.log.includes(diagnostic), r.log); assert(!r.stdout.split(/\r?\n/u).includes(sentinel), r.log);
}
for (const [id, change] of [
  ['WRONG_SHA', dir => fs.appendFileSync(path.join(dir, 'dist/pnpm.mjs'), '\n// changed\n')],
  ['UNSUPPORTED_VERSION', dir => { const p = path.join(dir, 'package.json'); const m = JSON.parse(fs.readFileSync(p)); m.version = '99.0.0'; fs.writeFileSync(p, JSON.stringify(m)); }],
  ['ALREADY_PATCHED', dir => {
    const first = commands.find(row => row.label === 'M1-runner');
    const ready = JSON.parse(fs.readFileSync(first.logPath, 'utf8').match(/^PNPM_TOOLCHAIN_READY (.+)$/m)[1]);
    const patched = path.resolve(path.dirname(ready.bin), '../dist/pnpm.mjs');
    assert.equal(sha(fs.readFileSync(patched)), '0acfe7b927c5c30f68aac55dbe4f8c5e0c55d86ee953f960edca8e0711d30b67');
    fs.copyFileSync(patched, path.join(dir, 'dist/pnpm.mjs'));
  }],
]) {
  test(id + ' rejects toolchain before patch or command execution', () => {
    reject(id, [...cliArgs(badToolchain(id, change)), 'exec', process.execPath, '-e', `console.log('${sentinel}')`], 'PNPM_TOOLCHAIN_IDENTITY_MISMATCH');
  });
}
test('scratch creation failure rejects without command execution', () => {
  const file = path.join(evidence, 'not-a-directory'); fs.writeFileSync(file, 'fixture');
  reject('SCRATCH_FAILURE', [runner, '--toolchain', toolchain, '--scratch-root', file, '--', 'exec', process.execPath, '-e', `console.log('${sentinel}')`], 'PNPM_SCRATCH_CREATION_FAILED');
});
for (const [id, scratchRoot, inputToolchain] of [['SOURCE_AS_SCRATCH', source, toolchain], ['TOOLCHAIN_AS_SCRATCH', original, original]]) {
  test(id + ' rejects before writing into an input directory', () => {
    const before = fs.readdirSync(scratchRoot).toSorted();
    reject(id, [runner, '--toolchain', inputToolchain, '--scratch-root', scratchRoot, '--', 'exec', process.execPath, '-e', `console.log('${sentinel}')`], 'Scratch cannot be inside the repository or original toolchain');
    assert.deepEqual(fs.readdirSync(scratchRoot).toSorted(), before);
  });
}
for (const [id, patch, diagnostic] of [
  ['MISSING_PATCH', null, 'PNPM_PATCH_MISSING'],
  ['WRONG_PATCH', 'not the verified patch\n', 'PNPM_PATCH_IDENTITY_MISMATCH'],
]) {
  test(id + ' rejects before command execution', () => {
    const dir = path.join(evidence, id); write(dir, 'pnpm-normalized.mjs', fs.readFileSync(runner));
    if (patch !== null) write(dir, 'pnpm-11.7.0-normalization.patch', patch);
    reject(id, [...cliArgs(toolchain, path.join(dir, 'pnpm-normalized.mjs')), 'exec', process.execPath, '-e', `console.log('${sentinel}')`], diagnostic);
  });
}
for (const [id, rc, diagnostic] of [['PATCH_APPLY_FAILURE', 19, 'PNPM_PATCH_APPLY_FAILED'], ['PATCH_NOOP', 0, 'PNPM_TOOLCHAIN_IDENTITY_MISMATCH']]) {
  test(id + ' cannot reach a Gate command', () => {
    const dir = path.join(evidence, id); write(dir, 'git', `#!/bin/sh\nexit ${rc}\n`); fs.chmodSync(path.join(dir, 'git'), 0o755);
    reject(id, [...cliArgs(), 'exec', process.execPath, '-e', `console.log('${sentinel}')`], diagnostic, {env: {...baseEnv, PATH: dir + path.delimiter + baseEnv.PATH}});
  });
}
test('symlink entry executes the runner instead of returning false success', () => {
  const entry = path.join(evidence, 'runner-link.mjs'); fs.symlinkSync(runner, entry);
  const f = fixture('SYMLINK_ENTRY', {simple: true}); json(f.root, 'node_modules/.pnpm-workspace-state-v1.json', f.state);
  const r = record('SYMLINK_ENTRY', [...cliArgs(toolchain, entry), 'exec', process.execPath, '-e', `console.log('${sentinel}')`], {cwd: f.root});
  assert.equal(r.status, 0, r.log); assert(r.stdout.split(/\r?\n/u).includes(sentinel), r.log); assert(r.log.includes('PNPM_TOOLCHAIN_READY'), r.log);
});
test('actual command RC is preserved', () => {
  const f = fixture('EXIT_37', {simple: true}); json(f.root, 'node_modules/.pnpm-workspace-state-v1.json', f.state);
  const r = record('EXIT_37', [...cliArgs(), 'exec', process.execPath, '-e', 'process.exit(37)'], {cwd: f.root});
  assert.equal(r.status, 37); assert(r.log.includes('"exitCode":37'), r.log);
});
test('run lifecycle and both nested pnpm entry paths keep the patched owner', () => {
  const f = fixture('NESTED', {mutate: ({rootManifest}) => { rootManifest.scripts = {'proof:nested': 'node nested.cjs'}; }});
  json(f.root, 'node_modules/.pnpm-workspace-state-v1.json', f.state);
  write(f.root, 'nested.cjs', `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const entry=process.env.npm_execpath;
if(!entry||crypto.createHash('sha256').update(fs.readFileSync(path.resolve(path.dirname(entry),'../dist/pnpm.mjs'))).digest('hex')!=='0acfe7b927c5c30f68aac55dbe4f8c5e0c55d86ee953f960edca8e0711d30b67')throw Error('wrong lifecycle owner');
for(const [command,args] of [[process.execPath,[entry]],['pnpm',[]]]) {
const newer=Date.now()/1000+60;fs.utimesSync(${JSON.stringify(f.target + '/package.json')},newer,newer);
const r=spawnSync(command,[...args,'exec',process.execPath,'-e','console.log("NESTED_PREFLIGHT_ACCEPT")'],{stdio:'inherit'});if(r.status!==0)process.exit(r.status??1);
}
console.log('NESTED_OWNER_VERIFIED');\n`);
  const r = record('NESTED', [...cliArgs(), 'run', 'proof:nested'], {cwd: f.root});
  assert.equal(r.status, 0, r.log); assert(r.log.includes('NESTED_OWNER_VERIFIED'), r.log);
  assert.equal((r.log.match(/NESTED_PREFLIGHT_ACCEPT/g) ?? []).length, 2);
  assert.deepEqual(identities(f.root, f.names), f.identity);
});
test('signal forwarding waits for the owned command and reports signal separately', async () => {
  const f = fixture('SIGNAL', {simple: true}); json(f.root, 'node_modules/.pnpm-workspace-state-v1.json', f.state);
  const args = [...cliArgs(), 'exec', process.execPath, '-e', 'console.log("SIGNAL_READY");setInterval(()=>{},1000)'];
  const child = spawn(process.execPath, args, {cwd: f.root, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe']});
  let log = '', sent = false;
  const timeout = setTimeout(() => {child.kill('SIGTERM');}, 40000);
  try {
    child.stdout.on('data', data => {log += data; if (!sent && log.includes('SIGNAL_READY')) {sent = true; child.kill('SIGTERM');}});
    child.stderr.on('data', data => {log += data;});
    const outcome = await new Promise((resolve, rejectPromise) => {child.once('error', rejectPromise); child.once('close', (rc, signal) => resolve({rc, signal}));});
    fs.writeFileSync(path.join(evidence, 'SIGNAL.log'), log);
    commands.push({label: 'SIGNAL', command: [process.execPath, ...args], cwd: f.root, realRC: outcome.rc, signal: outcome.signal, logPath: path.join(evidence, 'SIGNAL.log'), logSha256: sha(log)});
    assert(sent); assert.equal(outcome.rc, 143); assert(log.includes('"signal":"SIGTERM"'), log);
  } finally {clearTimeout(timeout);}
});
test('environment inheritance matrix uses the real parent environment', async t => {
  const f = fixture('ENVIRONMENT', {simple: true});
  // Harmless required probes are added to the full inherited environment, not an allowlist.
  const parent = {...process.env, KEYBOARD_LAYOUT: 'ark-keyboard-probe', ARK_TEST_ENV_SENTINEL: 'expected-value', TOKENIZERS_PARALLELISM: 'false', COREPACK_ENABLE_NETWORK: '1', NODE_DISABLE_COMPILE_CACHE: '0', pnpm_config_verify_deps_before_run: 'warn'};
  const script = `const c=require('node:crypto'),p=require('node:path');const h=x=>c.createHash('sha256').update(x).digest('hex');console.log('ENV_VIEW='+JSON.stringify({hashes:Object.fromEntries(Object.entries(process.env).map(([k,v])=>[k,h(v)])),pathSegments:(process.env.PATH??'').split(p.delimiter).map(h)}));`;
  const views = {};
  for (const variant of ['original', 'runner']) {
    json(f.root, 'node_modules/.pnpm-workspace-state-v1.json', f.state);
    const command = ['exec', process.execPath, '-e', script];
    const args = variant === 'original' ? [path.join(original, 'bin/pnpm.mjs'), ...command] : [...cliArgs(), ...command];
    const r = record('ENVIRONMENT-' + variant, args, {cwd: f.root, env: parent});
    assert.equal(r.status, 0, r.log);
    views[variant] = JSON.parse(r.stdout.match(/^ENV_VIEW=(.+)$/m)[1]);
    if (variant === 'runner') views.prepared = JSON.parse(r.stderr.match(/^PNPM_TOOLCHAIN_READY (.+)$/m)[1]);
  }
  const intentional = {
    PATH: 'Only the verified temporary pnpm bin directory is inserted; all ordinary PATH entries remain.',
    COREPACK_ENABLE_NETWORK: 'Pinned to 0; no automatic Corepack downloads.',
    NODE_DISABLE_COMPILE_CACHE: 'Pinned to 1; no shared compile-cache writes.',
    pnpm_config_verify_deps_before_run: 'Pinned to error for the pnpm preflight process. pnpm itself exports false to script descendants in both original and patched distributions.',
    npm_execpath: 'When pnpm exports this lifecycle field, it identifies the selected original/patched entrypoint.',
  };
  const allNames = [...new Set([...Object.keys(views.original.hashes), ...Object.keys(views.runner.hashes)])].toSorted();
  const matrix = allNames.map(name => ({name, originalSha256: views.original.hashes[name] ?? null, patchedSha256: views.runner.hashes[name] ?? null, parentSha256: parent[name] === undefined ? null : sha(parent[name]), intentionalDifference: intentional[name] ?? null}));
  fs.writeFileSync(path.join(evidence, 'environment-matrix.json'), JSON.stringify({removedVariables: [], intentional, matrix}, null, 2) + '\n');
  await t.test('ENV-1 KEYBOARD_LAYOUT is inherited exactly', () => {
    assert.equal(views.runner.hashes.KEYBOARD_LAYOUT, sha(parent.KEYBOARD_LAYOUT));
    assert.equal(views.original.hashes.KEYBOARD_LAYOUT, views.runner.hashes.KEYBOARD_LAYOUT);
  });
  await t.test('ENV-2 ordinary custom sentinel is inherited exactly', () => {
    assert.equal(views.runner.hashes.ARK_TEST_ENV_SENTINEL, sha('expected-value'));
    assert.equal(views.runner.hashes.TOKENIZERS_PARALLELISM, sha(parent.TOKENIZERS_PARALLELISM));
  });
  await t.test('ENV-3 ordinary runtime variables and PATH entries are preserved', () => {
    for (const name of ['HOME', 'TMPDIR', 'LANG', 'TERM', ...Object.keys(parent).filter(key => key.startsWith('LC_'))]) {
      assert.equal(views.runner.hashes[name], parent[name] === undefined ? undefined : sha(parent[name]), name);
    }
    const inserted = sha(path.dirname(views.prepared.bin));
    assert.equal(views.runner.pathSegments.filter(segment => segment === inserted).length, 1);
    assert.deepEqual(views.runner.pathSegments.filter(segment => segment !== inserted), views.original.pathSegments);
  });
  await t.test('ENV-4 only explicit repair controls replace incoming values', () => {
    assert.equal(views.runner.hashes.COREPACK_ENABLE_NETWORK, sha('0'));
    assert.equal(views.runner.hashes.NODE_DISABLE_COMPILE_CACHE, sha('1'));
    assert.equal(views.runner.hashes.pnpm_config_verify_deps_before_run, sha('false'));
    assert.equal(views.original.hashes.pnpm_config_verify_deps_before_run, sha('false'));
    for (const name of ['COREPACK_ENABLE_NETWORK', 'NODE_DISABLE_COMPILE_CACHE']) assert.equal(views.original.hashes[name], sha(parent[name]), name);
    const stale = fixture('ENV_CONTROL_STALE', {simple: true, mutate: ({lock, target}) => {lock.importers[target].dependencies['proof-dep'].version = '2.0.0';}});
    for (const variant of ['original', 'runner']) {
      json(stale.root, 'node_modules/.pnpm-workspace-state-v1.json', stale.state);
      const command = ['exec', process.execPath, '-e', 'console.log("ENV_CONTROL_REACHED")'];
      const args = variant === 'original' ? [path.join(original, 'bin/pnpm.mjs'), ...command] : [...cliArgs(), ...command];
      const r = record('ENV_GUARD-' + variant, args, {cwd: stale.root, env: parent});
      assert.equal(r.status, variant === 'original' ? 0 : 1, r.log);
      assert.equal(r.stdout.split(/\r?\n/u).includes('ENV_CONTROL_REACHED'), variant === 'original');
      if (variant === 'runner') assert(r.log.includes('does not satisfy project of id packages/normal'), r.log);
    }
    assert.deepEqual(identities(stale.root, stale.names), stale.identity);
  });
  await t.test('ENV-5 no additional filtering or unexplained environment differences', () => {
    for (const row of matrix) if (!Object.hasOwn(intentional, row.name)) assert.equal(row.patchedSha256, row.originalSha256, row.name);
    if (views.original.hashes.npm_execpath !== views.runner.hashes.npm_execpath) {
      assert.equal(views.original.hashes.npm_execpath, sha(path.join(original, 'bin/pnpm.mjs')));
      assert.equal(views.runner.hashes.npm_execpath, sha(views.prepared.bin));
    }
  });
  assert.deepEqual(identities(f.root, f.names), f.identity);
});
after(() => {
  fs.writeFileSync(path.join(evidence, 'commands.json'), JSON.stringify(commands, null, 2) + '\n');
  fs.writeFileSync(path.join(evidence, 'fixtures.json'), JSON.stringify(provenance, null, 2) + '\n');
  assert.deepEqual(protectedPaths.map(p => [p, sha(read(p))]), protectedBefore);
  assert.deepEqual(globalBefore.map(([p]) => [p, sha(fs.readFileSync(path.join(toolchain, p)))]), globalBefore);
});
