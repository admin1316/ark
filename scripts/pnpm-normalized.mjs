/**
 * Run the repository's existing pnpm commands with the pinned preflight repair.
 * Invoke with Node, not with the broken original pnpm run preflight:
 *   node scripts/pnpm-normalized.mjs --toolchain "$PNPM_TOOLCHAIN" -- run check:ci
 * PNPM_TOOLCHAIN is an operator-supplied pnpm package directory (not a store path).
 * Preparing a toolchain never installs dependencies or modifies the original.
 * Private /tmp copies and identity/result receipts remain available for audit.
 * This entrypoint does not authorize a Gate; callers must obtain its authorization.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {spawn, spawnSync} from 'node:child_process';

const VERSION = '11.7.0';
const ORIGINAL_SHA = 'd3a7f4bde2f32c5acc5f012d1edc24c24ea247c2f6c8823146f8cd69ed70b22f';
const PATCHED_SHA = '0acfe7b927c5c30f68aac55dbe4f8c5e0c55d86ee953f960edca8e0711d30b67';
const ENTRY_SHA = 'ff3224d46b47fbb24a7e9fe15fededef7e00892d07d4e376b6762d4899906bfd';
const METADATA_SHA = '2b20455ee8d69d072df339bf9851edea94ee08a9ea14db9289a7fca0bbb7abb0';
const PATCH_SHA = 'f1ac9ce46472e739705ad9d713769d62282337c29f6681f143caae5edace81c8';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fail(code, detail, cause) {
  throw new Error(`${code}: ${detail}`, {cause});
}

function regularFile(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('Expected an ordinary file');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

function assertIdentity(root, implementationSha) {
  try {
    const metadataBytes = regularFile(path.join(root, 'package.json'));
    const metadata = JSON.parse(metadataBytes);
    if (metadata.name !== 'pnpm' || metadata.version !== VERSION) throw new Error('Unsupported pnpm name/version');
    if (sha(metadataBytes) !== METADATA_SHA || sha(regularFile(path.join(root, 'bin/pnpm.mjs'))) !== ENTRY_SHA || sha(regularFile(path.join(root, 'dist/pnpm.mjs'))) !== implementationSha) {
      throw new Error('Unexpected pnpm metadata, entrypoint or implementation bytes');
    }
  } catch (error) { fail('PNPM_TOOLCHAIN_IDENTITY_MISMATCH', error.message, error); }
}

function treeIdentity(root, prefix = '') {
  const rows = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), {withFileTypes: true}).toSorted((a, b) => a.name < b.name ? -1 : 1)) {
    const name = path.join(prefix, entry.name);
    const absolute = path.join(root, name);
    if (entry.isDirectory()) rows.push(...treeIdentity(root, name));
    else if (entry.isFile()) rows.push([name.split(path.sep).join('/'), fs.statSync(absolute).mode & 0o7777, sha(regularFile(absolute))]);
    else fail('PNPM_TOOLCHAIN_IDENTITY_MISMATCH', 'Symlink or special file in toolchain');
  }
  return rows;
}

/**
 * Verify and patch a private copy of the supported pnpm distribution.
 * @param {{toolchainRoot: string, scratchRoot?: string}} options Original pnpm package directory and optional existing /tmp subdirectory.
 * @returns {{scratch: string, bin: string, identity: object}} Retained scratch path, verified entrypoint and reproducibility receipt.
 */
export function preparePnpm({toolchainRoot, scratchRoot = '/tmp'}) {
  let original;
  try { original = fs.realpathSync(toolchainRoot); }
  catch (error) { fail('PNPM_TOOLCHAIN_IDENTITY_MISMATCH', 'Cannot resolve the supplied toolchain directory', error); }
  assertIdentity(original, ORIGINAL_SHA);
  const before = treeIdentity(original);
  let patch;
  try { patch = regularFile(new URL('./pnpm-11.7.0-normalization.patch', import.meta.url)); }
  catch (error) { fail('PNPM_PATCH_MISSING', 'Cannot read repository patch artifact', error); }
  if (sha(patch) !== PATCH_SHA) fail('PNPM_PATCH_IDENTITY_MISMATCH', 'Repository patch differs from the reviewed artifact');
  let scratch;
  try {
    const tmp = fs.realpathSync('/tmp');
    const destination = fs.realpathSync(scratchRoot);
    if (destination !== tmp && !destination.startsWith(tmp + path.sep)) throw new Error('Scratch must be under /tmp');
    const repository = fs.realpathSync(new URL('../', import.meta.url));
    if ([original, repository].some(input => destination === input || destination.startsWith(input + path.sep))) {
      throw new Error('Scratch cannot be inside the repository or original toolchain');
    }
    scratch = fs.mkdtempSync(path.join(destination, 'ark-pnpm-normalized-'));
    fs.chmodSync(scratch, 0o700);
  } catch (error) { fail('PNPM_SCRATCH_CREATION_FAILED', `Cannot create a private /tmp toolchain copy: ${error.message}`, error); }
  const copied = path.join(scratch, 'pnpm');
  fs.cpSync(original, copied, {recursive: true, errorOnExist: true, force: false, filter: file => {
    if (fs.lstatSync(file).isSymbolicLink()) fail('PNPM_TOOLCHAIN_IDENTITY_MISMATCH', 'Toolchain changed to a symlink during copying');
    return true;
  }});
  assertIdentity(copied, ORIGINAL_SHA);
  if (JSON.stringify(treeIdentity(copied)) !== JSON.stringify(before) || JSON.stringify(treeIdentity(original)) !== JSON.stringify(before)) {
    fail('PNPM_TOOLCHAIN_IDENTITY_MISMATCH', 'Toolchain changed during copying');
  }
  const patchPath = path.join(scratch, 'normalization.patch');
  fs.writeFileSync(patchPath, patch, {flag: 'wx', mode: 0o600});
  const gitEnv = {PATH: process.env.PATH, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'};
  for (const args of [['--check'], []]) {
    const result = spawnSync('git', ['--no-optional-locks', 'apply', '--no-index', '--whitespace=error-all', ...args, patchPath], {cwd: copied, env: gitEnv, encoding: 'utf8'});
    if (result.error || result.status !== 0 || result.signal) fail('PNPM_PATCH_APPLY_FAILED', `git apply RC=${result.status}, signal=${result.signal}: ${result.stderr ?? ''}`, result.error);
  }
  assertIdentity(copied, PATCHED_SHA);
  const after = treeIdentity(copied);
  const expected = before.map(row => row[0] === 'dist/pnpm.mjs' ? [row[0], row[1], PATCHED_SHA] : row);
  if (JSON.stringify(after) !== JSON.stringify(expected)) fail('PNPM_PATCH_SCOPE_MISMATCH', 'Patch changed more than the reviewed implementation');
  const identity = {version: VERSION, original, originalSha256: ORIGINAL_SHA, patchedSha256: PATCHED_SHA, patchSha256: PATCH_SHA, originalTreeSha256: sha(JSON.stringify(before)), patchedTreeSha256: sha(JSON.stringify(after))};
  fs.writeFileSync(path.join(scratch, 'identity.json'), JSON.stringify(identity, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  // Plain nested `pnpm` and the existing npm_execpath-based invoker select this copy.
  fs.symlinkSync('pnpm.mjs', path.join(copied, 'bin/pnpm'));
  return {scratch, bin: path.join(copied, 'bin/pnpm.mjs'), identity};
}

async function main() {
  const {values, positionals} = parseArgs({options: {toolchain: {type: 'string'}, 'scratch-root': {type: 'string'}, help: {type: 'boolean'}}, allowPositionals: true});
  if (values.help) {
    console.log('node scripts/pnpm-normalized.mjs --toolchain <original-pnpm-package-directory> [--scratch-root <existing-/tmp-directory>] -- <run|exec> <command> [args...]');
    return;
  }
  if (!values.toolchain || !['run', 'exec'].includes(positionals[0]) || !positionals[1] || positionals[1].startsWith('-')) {
    fail('PNPM_RUNNER_ARGUMENTS', 'Supply --toolchain and a run/exec command; installation commands are not supported');
  }
  if (process.platform === 'win32') fail('PNPM_RUNNER_PLATFORM_UNSUPPORTED', 'This Ark toolchain entrypoint currently supports POSIX hosts');
  const prepared = preparePnpm({toolchainRoot: values.toolchain, scratchRoot: values['scratch-root']});
  console.error('PNPM_TOOLCHAIN_READY ' + JSON.stringify(prepared));
  const env = {...process.env};
  env.PATH = path.dirname(prepared.bin) + path.delimiter + (env.PATH ?? '');
  env.COREPACK_ENABLE_NETWORK = '0';
  env.NODE_DISABLE_COMPILE_CACHE = '1';
  env.pnpm_config_verify_deps_before_run = 'error';
  const command = [process.execPath, prepared.bin, '--config.verify-deps-before-run=error', ...positionals];
  const startTimestamp = new Date().toISOString();
  const child = spawn(command[0], command.slice(1), {stdio: 'inherit', env, detached: true});
  const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => {
    try { if (child.pid) process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') console.error('PNPM_SIGNAL_FORWARD_FAILED: ' + error.message); }
  }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, signal) => resolve({exitCode, signal}));
    });
    const binding = {...result, command, pid: child.pid, startTimestamp, endTimestamp: new Date().toISOString()};
    fs.writeFileSync(path.join(prepared.scratch, 'result.json'), JSON.stringify(binding) + '\n', {flag: 'wx', mode: 0o600});
    console.error('PNPM_COMMAND_RESULT ' + JSON.stringify(binding));
    process.exitCode = result.exitCode ?? (result.signal ? 128 + os.constants.signals[result.signal] : 1);
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {console.error(error.message); process.exitCode = 1;});
}
