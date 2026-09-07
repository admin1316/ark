import { createHash, randomBytes } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertArkRuntimeClosure } from './runtime-closure.mjs'

// One launcher pair (start.mjs + this file) serves both supported layouts,
// detected at the launcher's own location:
// - repository checkout: launcher under integrations/jiuzhang/src/, product
//   files under integrations/jiuzhang/profile, Ark runner built at
//   packages/boot/native-api-runner/lib/bin.js, child working directory = repository root.
// - standalone runtime: launcher at the runtime root beside a jiuzhang/
//   product-file directory and an installed
//   node_modules/@deepseek-ai/dsh-native-api-runner/lib/bin.js, child working directory =
//   the runtime root.
const launcherRoot = resolve(fileURLToPath(new URL('.', import.meta.url)))
const standaloneAssetRoot = join(launcherRoot, 'jiuzhang')
const standaloneArkRunner = join(
  launcherRoot,
  'node_modules',
  '@deepseek-ai',
  'dsh-native-api-runner',
  'lib',
  'bin.js',
)
const isStandaloneLayout = existsSync(standaloneAssetRoot) && existsSync(standaloneArkRunner)
const integrationRoot = resolve(launcherRoot, '..')
const repositoryRoot = resolve(integrationRoot, '..', '..')

const runtimeFiles = [
  ['profile/package.json', 'profiles/jiuzhang/package.json'],
  ['profile/cordis.patch.yml', 'profiles/jiuzhang/cordis.patch.yml'],
  ['profile/pnpm-workspace.yaml', 'profiles/jiuzhang/pnpm-workspace.yaml'],
]

const dataMigrationMarker = '.ark-product-data-migration-v1'

/**
 * Verify a standalone Ark package tree before any user profile is reconciled
 * or backend process starts. Source-checkout launches skip this artifact-only
 * check because their shared development node_modules intentionally includes
 * the separate Web and headless products.
 * @returns {Promise<{skipped: true}|{packageCount: number}>} Closure result.
 */
export async function assertStandaloneRuntimeClosure() {
  if (!isStandaloneLayout) return { skipped: true }
  return assertArkRuntimeClosure(
    launcherRoot,
    join(standaloneAssetRoot, 'profile', 'forbidden-runtime-packages.json'),
  )
}

/**
 * `jiuzhang` is Ark's reserved historical preset ID, never a legal user
 * preset ID. Move its canonical store directory into an owner-only recovery
 * area before the preset service starts. The operation never follows a
 * symlink and never recursively deletes the legacy bytes. A deterministic
 * receipt lets later launches validate or complete an interrupted recovery.
 * @param {string} home - Absolute Ark Harness home.
 * @returns {Promise<{status: 'absent'|'recovered'|'already-recovered', recovery: string, receipt: string}>}
 */
export async function purgeReservedJiuzhangPreset(home) {
  const homeRoot = validateHome(home)
  await validateOwnedDirectory(homeRoot, await lstat(homeRoot), false)

  const sourceParent = await walkOwnedDirectoryChain(homeRoot, ['.agent-presets'], false)
  const source = join(homeRoot, '.agent-presets', 'jiuzhang')
  const sourceInfo = sourceParent === undefined ? undefined : await optionalLstat(source)

  const recoveryParts = ['.ark-startup-recovery', 'reserved-agent-presets', 'jiuzhang']
  let recoveryRoot = await walkOwnedDirectoryChain(homeRoot, recoveryParts, false)
  const recovery = join(homeRoot, ...recoveryParts, 'payload')
  const receipt = join(homeRoot, ...recoveryParts, 'receipt.json')

  if (sourceInfo === undefined) {
    if (recoveryRoot === undefined) {
      return { status: 'absent', recovery, receipt }
    }
    const recoveredInfo = await optionalLstat(recovery)
    const receiptInfo = await optionalLstat(receipt)
    if (recoveredInfo === undefined) {
      if (receiptInfo !== undefined) {
        throw new Error(`reserved preset recovery receipt has no payload: ${receipt}`)
      }
      return { status: 'absent', recovery, receipt }
    }
    // The owner-only recovery ancestors make a historical 0755 payload
    // private without rewriting its original mode or bytes.
    await validateOwnedDirectory(recovery, recoveredInfo, false)
    const record = await reservedPresetRecoveryRecord(recovery)
    await writeDeterministicRecoveryReceipt(receipt, record)
    return { status: 'already-recovered', recovery, receipt }
  }

  await validateOwnedDirectory(source, sourceInfo, false)
  const sourceRecord = await reservedPresetRecoveryRecord(source)
  recoveryRoot ??= await walkOwnedDirectoryChain(homeRoot, recoveryParts, true)
  const existingRecovery = await optionalLstat(recovery)
  if (existingRecovery !== undefined) {
    await validateOwnedDirectory(recovery, existingRecovery, false)
    throw new Error(`reserved preset recovery payload already exists: ${recovery}`)
  }

  await assertUnchangedOwnedDirectory(sourceParent, source, sourceInfo)
  await validateOwnedDirectory(recoveryRoot, await lstat(recoveryRoot), true)
  await rename(source, recovery)

  const recoveredInfo = await lstat(recovery)
  if (!sameFileIdentity(sourceInfo, recoveredInfo)) {
    throw new Error(`reserved preset identity changed during recovery: ${recovery}`)
  }
  const recoveredRecord = await reservedPresetRecoveryRecord(recovery)
  if (JSON.stringify(recoveredRecord) !== JSON.stringify(sourceRecord)) {
    throw new Error(`reserved preset changed during recovery: ${recovery}`)
  }
  await writeDeterministicRecoveryReceipt(receipt, recoveredRecord)
  return { status: 'recovered', recovery, receipt }
}

const inheritedEnvironmentKeys = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SHELL',
  'USER',
  'LOGNAME',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
]

/** Return the default isolated Harness home for the Jiuzhang desktop product. */
export function defaultJiuzhangHome() {
  return join(homedir(), 'Library', 'Application Support', 'Ark', 'Harness')
}

/** Return the product home used before the Ark machine-identity rename. */
export function legacyJiuzhangHome() {
  return join(homedir(), 'Library', 'Application Support', '九章天幕行业大脑', 'Harness')
}

/**
 * Copy a legacy product home into its renamed location without deleting the source or replacing destination data.
 * A completed migration is marked in the destination so later user changes are not compared with the retained rollback copy.
 * @param {string} source - Absolute legacy Harness home.
 * @param {string} target - Absolute renamed Harness home.
 * @returns {Promise<{status: 'absent' | 'migrated' | 'already-migrated', copied: string[]}>} Migration outcome.
 */
export async function migrateLegacyProductData(source, target) {
  const sourceRoot = validateHome(source)
  const targetRoot = validateHome(target)
  if (sourceRoot === targetRoot) throw new Error('legacy and Ark product homes must differ')

  const sourceStat = await optionalLstat(sourceRoot)
  if (sourceStat === undefined) return { status: 'absent', copied: [] }
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`legacy product home is not an ordinary directory: ${sourceRoot}`)
  }

  const marker = join(targetRoot, dataMigrationMarker)
  const markerStat = await optionalLstat(marker)
  if (markerStat !== undefined) {
    if (!markerStat.isFile()) {
      throw new Error(`Ark data migration marker is not an ordinary file: ${marker}`)
    }
    return { status: 'already-migrated', copied: [] }
  }

  const actions = []
  await planMigration(sourceRoot, targetRoot, '', actions)
  await mkdir(dirname(targetRoot), { recursive: true, mode: 0o700 })
  const copied = []
  for (const action of actions) {
    const destination = join(targetRoot, action.relative)
    if (action.kind === 'directory') {
      await mkdir(destination, { mode: action.mode })
    } else if (action.kind === 'file') {
      await copyFile(action.source, destination, constants.COPYFILE_EXCL)
      await chmod(destination, action.mode)
      await utimes(destination, action.atime, action.mtime)
    } else {
      await symlink(action.link, destination)
    }
    copied.push(action.relative)
  }

  // The completion marker commits only after every copy and the settings
  // import record succeeded. A failure anywhere above leaves no marker, so a
  // later retry re-runs the migration instead of reporting it done.
  await recordSettingsImport(sourceRoot, targetRoot)
  await commitMigrationMarker(targetRoot)
  return { status: 'migrated', copied }
}

/**
 * Commit the migration completion marker atomically (random-suffix temp with
 * exclusive create, then rename) so a crash cannot leave a torn marker that
 * a later launch would mistake for a completed migration.
 * @param {string} targetRoot - Absolute Ark Harness home receiving the marker.
 */
async function commitMigrationMarker(targetRoot) {
  const marker = join(targetRoot, dataMigrationMarker)
  const temp = `${marker}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, 'version: 1\n', { flag: 'wx', mode: 0o600 })
    await rename(temp, marker)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/**
 * Record the legacy default Agent preset and permission preset into an
 * auditable import file when they diverge from the Ark safe defaults.
 * Settings stay effective (the copy already preserved them); the record
 * gives the first-launch notice and any later rollback a fact source.
 * @param {string} sourceRoot - Absolute legacy Harness home.
 * @param {string} targetRoot - Absolute renamed Harness home.
 */
export async function recordSettingsImport(sourceRoot, targetRoot) {
  const settingsPath = join(sourceRoot, 'settings.yaml')
  const settingsText = await optionalReadFile(settingsPath)
  if (settingsText === undefined) return

  const agentPreset = /^agent-presets:\s*\n\s*default:\s*(\S+)/m.exec(settingsText)?.[1]
  const permissionPreset = /^permission:\s*\n\s*defaultPreset:\s*(\S+)/m.exec(settingsText)?.[1]
  if (agentPreset === undefined && permissionPreset === undefined) return
  if ((agentPreset === undefined || agentPreset === 'jiuzhang')
    && (permissionPreset === undefined || permissionPreset === 'read-only')) return

  const record = {
    version: 1,
    importedAt: new Date().toISOString(),
    agentPresetDefault: agentPreset ?? null,
    permissionPresetDefault: permissionPreset ?? null,
  }
  // The record is a derived audit artifact, not the migration's commit point:
  // every attempt (re)writes it atomically, and the completion marker decides
  // whether the migration ever finished. A stale or torn record left by a
  // failed attempt is replaced, never allowed to stall a retry.
  const recordPath = join(targetRoot, '.ark-settings-import.json')
  const recordTemp = `${recordPath}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(recordTemp, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await rename(recordTemp, recordPath)
  } catch (error) {
    await rm(recordTemp, { force: true })
    throw error
  }

  // Surface the pending decision to the GUI: append the ark-import section to
  // settings.yaml (idempotent) so the first-launch dialog can show the
  // imported values and record the user's choice.
  const settingsTarget = join(targetRoot, 'settings.yaml')
  const targetText = (await optionalReadFile(settingsTarget)) ?? ''
  if (!/^ark-import:/m.test(targetText)) {
    const section = [
      '',
      'ark-import:',
      `  agentPresetDefault: ${agentPreset ?? 'null'}`,
      `  permissionPresetDefault: ${permissionPreset ?? 'null'}`,
      '  pending: true',
      '  choice: none',
      `  importedAt: '${record.importedAt}'`,
      '',
    ].join('\n')
    await writeFile(settingsTarget, targetText.replace(/\n*$/, '\n') + section, { mode: 0o600 })
  }
}

/**
 * Read the settings-import record written by {@link recordSettingsImport}.
 * @param {string} home - Absolute Harness home.
 * @returns {Promise<{agentPresetDefault: (string|null), permissionPresetDefault: (string|null)}|undefined>} the record, or undefined.
 */
export async function readSettingsImportRecord(home) {
  const text = await optionalReadFile(join(validateHome(home), '.ark-settings-import.json'))
  if (text === undefined) return undefined
  const record = JSON.parse(text)
  if (record?.version !== 1) return undefined
  return {
    agentPresetDefault: record.agentPresetDefault ?? null,
    permissionPresetDefault: record.permissionPresetDefault ?? null,
  }
}

/**
 * Seed a ready-to-use local model provider (Ollama, OpenAI-compatible base
 * URL) into settings.yaml once, so a local model is one `ollama pull` away
 * instead of a manual provider setup. Idempotent: an existing llm-pi-ai
 * section (any user edits included) is never touched.
 * @param {string} home - Absolute Harness home.
 */
export async function seedLocalModelProvider(home) {
  const settingsPath = join(validateHome(home), 'settings.yaml')
  const current = (await optionalReadFile(settingsPath)) ?? ''
  if (/^llm-pi-ai:/m.test(current)) return
  const section = [
    '',
    'llm-pi-ai:',
    '  providers:',
    '    ollama:',
    '      displayName: Ollama（本地）',
    '      apiKeyEnv: OLLAMA_API_KEY',
    '      api: openai-completions',
    '      baseURL: http://127.0.0.1:11434/v1',
    '      models:',
    '        - id: qwen3',
    '        - id: llama3.2',
    '        - id: deepseek-r1',
    '',
  ].join('\n')
  await writeFile(settingsPath, current.replace(/\n*$/, '\n') + section, { mode: 0o600 })
}

async function optionalReadFile(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function planMigration(sourceRoot, targetRoot, relative, actions) {
  if (relative === dataMigrationMarker) {
    throw new Error(`legacy product home contains the reserved migration marker: ${relative}`)
  }

  const source = join(sourceRoot, relative)
  const target = join(targetRoot, relative)
  const sourceStat = await lstat(source)
  const targetStat = await optionalLstat(target)

  if (sourceStat.isDirectory() && !sourceStat.isSymbolicLink()) {
    if (targetStat === undefined) {
      actions.push({ kind: 'directory', relative, mode: sourceStat.mode & 0o777 })
    } else if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
      throw migrationConflict(relative)
    }
    const entries = await readdir(source)
    for (const entry of entries.sort()) {
      await planMigration(sourceRoot, targetRoot, join(relative, entry), actions)
    }
    return
  }

  if (sourceStat.isFile()) {
    if (targetStat === undefined) {
      actions.push({
        kind: 'file',
        relative,
        source,
        mode: sourceStat.mode & 0o777,
        atime: sourceStat.atime,
        mtime: sourceStat.mtime,
      })
      return
    }
    if (!targetStat.isFile() || !(await filesEqual(source, target, sourceStat, targetStat))) {
      throw migrationConflict(relative)
    }
    return
  }

  if (sourceStat.isSymbolicLink()) {
    const link = await readlink(source)
    if (targetStat === undefined) {
      actions.push({ kind: 'symlink', relative, link })
      return
    }
    if (!targetStat.isSymbolicLink() || (await readlink(target)) !== link) {
      throw migrationConflict(relative)
    }
    return
  }

  throw new Error(`legacy product home contains an unsupported file type: ${relative || '.'}`)
}

async function filesEqual(source, target, sourceStat, targetStat) {
  if (sourceStat.size !== targetStat.size) return false
  const [sourceContent, targetContent] = await Promise.all([readFile(source), readFile(target)])
  return sourceContent.equals(targetContent)
}

function migrationConflict(relative) {
  return new Error(`Ark data migration conflict at ${relative || '.'}; source data was retained`)
}

async function optionalLstat(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

function assertCurrentUserOwner(path, info) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid !== undefined && info.uid !== uid) {
    throw new Error(`Ark-owned path is not owned by the current user: ${path}`)
  }
}

async function validateOwnedDirectory(path, info, ownerOnly) {
  assertOrdinaryDirectory(path, info, ownerOnly)
  assertCurrentUserOwner(path, info)
  return realpath(path)
}

async function walkOwnedDirectoryChain(home, parts, create) {
  let current = home
  let currentReal = await validateOwnedDirectory(home, await lstat(home), false)
  for (const part of parts) {
    const child = join(current, part)
    let info = await optionalLstat(child)
    if (info === undefined) {
      if (!create) return undefined
      await mkdir(child, { mode: 0o700 })
      info = await lstat(child)
    }
    const childReal = await validateOwnedDirectory(child, info, true)
    if (dirname(childReal) !== currentReal) {
      throw new Error(`Ark-owned directory escapes its validated parent: ${child}`)
    }
    current = child
    currentReal = childReal
  }
  return current
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

async function assertUnchangedOwnedDirectory(parent, child, expected) {
  const parentReal = await validateOwnedDirectory(parent, await lstat(parent), false)
  const current = await lstat(child)
  const childReal = await validateOwnedDirectory(child, current, false)
  if (dirname(childReal) !== parentReal || !sameFileIdentity(expected, current)) {
    throw new Error(`Ark-owned directory changed before recovery: ${child}`)
  }
}

async function hashOrdinaryFileNoFollow(path, expected) {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  const handle = await open(path, flags)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || !sameFileIdentity(expected, before)) {
      throw new Error(`reserved preset file changed during inventory: ${path}`)
    }
    const digest = createHash('sha256')
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk)
    const after = await handle.stat()
    if (!sameFileIdentity(before, after)
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs) {
      throw new Error(`reserved preset file changed during inventory: ${path}`)
    }
    return digest.digest('hex')
  } finally {
    await handle.close()
  }
}

async function inventoryReservedPreset(root, relativePath, entries) {
  const path = relativePath === '' ? root : join(root, relativePath)
  const info = await lstat(path)
  assertCurrentUserOwner(path, info)

  if (info.isSymbolicLink()) {
    entries.push({
      path: relativePath || '.',
      type: 'symlink',
      target: await readlink(path),
    })
    return
  }

  if ((info.mode & 0o022) !== 0) {
    throw new Error(`reserved preset path is writable by group or others: ${path}`)
  }
  if (info.isDirectory()) {
    entries.push({ path: relativePath || '.', type: 'directory', mode: info.mode & 0o777 })
    for (const name of (await readdir(path)).sort()) {
      await inventoryReservedPreset(root, join(relativePath, name), entries)
    }
    return
  }
  if (info.isFile() && info.nlink === 1) {
    entries.push({
      path: relativePath,
      type: 'file',
      mode: info.mode & 0o777,
      size: info.size,
      sha256: await hashOrdinaryFileNoFollow(path, info),
    })
    return
  }
  throw new Error(`reserved preset contains an unsupported or linked entry: ${path}`)
}

async function reservedPresetRecoveryRecord(root) {
  const entries = []
  await inventoryReservedPreset(root, '', entries)
  return {
    version: 1,
    operation: 'recover-reserved-jiuzhang-preset',
    source: '.agent-presets/jiuzhang',
    recovery: '.ark-startup-recovery/reserved-agent-presets/jiuzhang/payload',
    treeSha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
    entries,
  }
}

async function writeDeterministicRecoveryReceipt(path, record) {
  const content = JSON.stringify(record, null, 2) + '\n'
  const existing = await optionalLstat(path)
  if (existing !== undefined) {
    assertOrdinarySingleLinkFile(path, existing)
    assertCurrentUserOwner(path, existing)
    if ((existing.mode & 0o077) !== 0 || await readFile(path, 'utf8') !== content) {
      throw new Error(`reserved preset recovery receipt is invalid: ${path}`)
    }
    return
  }

  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
  const written = await lstat(path)
  assertOrdinarySingleLinkFile(path, written)
  assertCurrentUserOwner(path, written)
  if ((written.mode & 0o077) !== 0 || await readFile(path, 'utf8') !== content) {
    throw new Error(`reserved preset recovery receipt is invalid: ${path}`)
  }
}

function assertOrdinaryDirectory(path, info, ownerOnly = false) {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Ark-owned directory path is not an ordinary directory: ${path}`)
  }
  if (ownerOnly && (info.mode & 0o077) !== 0) {
    throw new Error(`Ark-owned rollback directory is not owner-only: ${path}`)
  }
  if (!ownerOnly && (info.mode & 0o022) !== 0) {
    throw new Error(`Ark-owned directory is writable by group or others: ${path}`)
  }
}

async function ensureOrdinaryDirectory(path, ownerOnly = false) {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  assertOrdinaryDirectory(path, await lstat(path), ownerOnly)
}

function assertOrdinarySingleLinkFile(path, info) {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error(`Ark-owned profile path is not an ordinary single-link file: ${path}`)
  }
  if ((info.mode & 0o022) !== 0) {
    throw new Error(`Ark-owned profile path is writable by group or others: ${path}`)
  }
}

async function replaceOwnedFile(target, expected, content) {
  const currentStat = await lstat(target)
  assertOrdinarySingleLinkFile(target, currentStat)
  const current = await readFile(target)
  if (current.equals(content)) return false
  if (!current.equals(expected)) {
    throw new Error(`Ark-owned profile changed during reconciliation: ${target}`)
  }
  const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
    await rename(temporary, target)
    return true
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function validateExistingProfileRollback(rollbackRoot, id, entries) {
  for (const directory of [
    rollbackRoot,
    join(rollbackRoot, 'profiles'),
    join(rollbackRoot, 'profiles', 'jiuzhang'),
  ]) {
    assertOrdinaryDirectory(directory, await lstat(directory), true)
  }

  const manifestPath = join(rollbackRoot, 'manifest.json')
  const manifestStat = await lstat(manifestPath)
  assertOrdinarySingleLinkFile(manifestPath, manifestStat)
  if ((manifestStat.mode & 0o077) !== 0) {
    throw new Error(`Ark profile rollback manifest is not owner-only: ${manifestPath}`)
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest?.version !== 1
    || manifest?.digest !== id
    || manifest?.target !== 'profiles/jiuzhang'
    || !Array.isArray(manifest?.files)
    || manifest.files.length !== entries.length) {
    throw new Error(`Ark profile rollback manifest is invalid: ${manifestPath}`)
  }

  for (const [index, entry] of entries.entries()) {
    const expectedHash = createHash('sha256').update(entry.current).digest('hex')
    const manifestEntry = manifest.files[index]
    if (manifestEntry?.path !== entry.targetRelative || manifestEntry?.sha256 !== expectedHash) {
      throw new Error(`Ark profile rollback manifest is invalid: ${manifestPath}`)
    }
    const backup = join(rollbackRoot, entry.targetRelative)
    const backupStat = await lstat(backup)
    assertOrdinarySingleLinkFile(backup, backupStat)
    if ((backupStat.mode & 0o077) !== 0 || !(await readFile(backup)).equals(entry.current)) {
      throw new Error(`Ark profile rollback file is invalid: ${backup}`)
    }
  }
}

async function backupProfileDrift(home, entries) {
  const digest = createHash('sha256')
  for (const entry of entries) {
    digest.update(entry.targetRelative)
    digest.update('\0')
    digest.update(entry.current)
    digest.update('\0')
  }
  const id = digest.digest('hex')
  const rollbackParent = join(home, '.ark-profile-rollbacks', 'jiuzhang')
  const rollbackRoot = join(rollbackParent, id)
  await ensureOrdinaryDirectory(join(home, '.ark-profile-rollbacks'), true)
  await ensureOrdinaryDirectory(rollbackParent, true)
  const existingRollback = await optionalLstat(rollbackRoot)
  if (existingRollback !== undefined) {
    await validateExistingProfileRollback(rollbackRoot, id, entries)
    return rollbackRoot
  }
  const staging = join(rollbackParent, `.${id}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await mkdir(staging, { mode: 0o700 })
    const files = []
    for (const entry of entries) {
      const backup = join(staging, entry.targetRelative)
      await mkdir(dirname(backup), { recursive: true, mode: 0o700 })
      await writeFile(backup, entry.current, { flag: 'wx', mode: 0o600 })
      files.push({
        path: entry.targetRelative,
        sha256: createHash('sha256').update(entry.current).digest('hex'),
      })
    }
    await writeFile(join(staging, 'manifest.json'), JSON.stringify({
      version: 1,
      digest: id,
      target: 'profiles/jiuzhang',
      files,
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await rename(staging, rollbackRoot)
    return rollbackRoot
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

/**
 * Reconcile Ark-owned Jiuzhang profile files with the candidate source.
 * Drifted regular files receive one content-addressed owner-only rollback
 * before atomic replacement; user settings remain outside this profile.
 * @param {string} home - Absolute Harness home.
 * @returns {Promise<{created: string[], replaced: string[], kept: string[], rollback?: string}>} Reconciliation result.
 */
export async function installRuntimeConfiguration(home) {
  const targetRoot = validateHome(home)
  const sourceRoot = isStandaloneLayout ? standaloneAssetRoot : integrationRoot
  const created = []
  const replaced = []
  const kept = []
  await mkdir(targetRoot, { recursive: true, mode: 0o700 })
  const targetRootStat = await lstat(targetRoot)
  assertOrdinaryDirectory(targetRoot, targetRootStat)
  await ensureOrdinaryDirectory(join(targetRoot, 'profiles'))
  await ensureOrdinaryDirectory(join(targetRoot, 'profiles', 'jiuzhang'))

  const planned = []
  for (const [sourceRelative, targetRelative] of runtimeFiles) {
    const source = join(sourceRoot, sourceRelative)
    const target = join(targetRoot, targetRelative)
    const content = await readFile(source)
    const targetStat = await optionalLstat(target)
    if (targetStat !== undefined) assertOrdinarySingleLinkFile(target, targetStat)
    const current = targetStat === undefined ? undefined : await readFile(target)
    planned.push({ targetRelative, target, content, current })
  }

  const drifted = planned.filter(entry => entry.current !== undefined && !entry.current.equals(entry.content))
  const rollback = drifted.length === 0
    ? undefined
    : await backupProfileDrift(targetRoot, drifted)

  for (const entry of planned) {
    if (entry.current === undefined) {
      await writeFile(entry.target, entry.content, { flag: 'wx', mode: 0o600 })
      created.push(entry.target)
    } else if (entry.current.equals(entry.content)) {
      kept.push(entry.target)
    } else {
      if (await replaceOwnedFile(entry.target, entry.current, entry.content)) {
        replaced.push(entry.target)
      } else {
        kept.push(entry.target)
      }
    }
  }

  return { created, replaced, kept, ...(rollback === undefined ? {} : { rollback }) }
}

/**
 * Rebuild the standalone profile's package-resolution fallback from the
 * installed runtime. The profile scope is a real directory containing one
 * absolute link per canonical package; a scope-level symlink would let the
 * loader's healer rewrite the pnpm tree through the alias.
 * @param {string} home - Absolute Harness home.
 * @returns {Promise<{created: number, replaced: number, kept: number, pruned: number}>} Reconciliation counts.
 */
export async function ensureProfileModuleFallback(home) {
  if (!isStandaloneLayout) return { created: 0, replaced: 0, kept: 0, pruned: 0 }
  const runtimeScope = join(launcherRoot, 'node_modules', '@deepseek-ai')
  const homeRoot = validateHome(home)
  await validateOwnedDirectory(homeRoot, await lstat(homeRoot), false)
  const profileScope = await walkOwnedDirectoryChain(
    homeRoot,
    ['profiles', 'node_modules', '@deepseek-ai'],
    true,
  )
  const runtimeStat = await lstat(runtimeScope)
  if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) {
    throw new Error(`runtime package scope is not an ordinary directory: ${runtimeScope}`)
  }
  const runtimeNames = new Set()
  let created = 0
  let replaced = 0
  let kept = 0
  let pruned = 0
  for (const name of (await readdir(runtimeScope)).sort()) {
    const target = join(runtimeScope, name)
    const targetStat = await lstat(target)
    if (!targetStat.isSymbolicLink()) continue
    const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
    const expected = `@deepseek-ai/${name}`
    if (manifest.name !== expected) {
      throw new Error(`runtime package identity mismatch: ${expected} contains ${String(manifest.name)}`)
    }
    runtimeNames.add(name)
    const link = join(profileScope, name)
    const linkStat = await optionalLstat(link)
    if (linkStat !== undefined) {
      if (!linkStat.isSymbolicLink()) throw new Error(`profile package entry is not a symlink: ${link}`)
      assertCurrentUserOwner(link, linkStat)
      const currentTarget = await readlink(link)
      if (currentTarget === target) {
        kept += 1
        continue
      }
      await unlinkValidatedProfileSymlink(profileScope, link, linkStat, currentTarget)
      replaced += 1
    } else {
      created += 1
    }
    await symlink(target, link, process.platform === 'win32' ? 'junction' : undefined)
  }
  for (const name of await readdir(profileScope)) {
    if (runtimeNames.has(name)) continue
    const link = join(profileScope, name)
    const linkStat = await lstat(link)
    if (!linkStat.isSymbolicLink()) continue
    assertCurrentUserOwner(link, linkStat)
    await unlinkValidatedProfileSymlink(profileScope, link, linkStat, await readlink(link))
    pruned += 1
  }
  return { created, replaced, kept, pruned }
}

async function unlinkValidatedProfileSymlink(profileScope, link, expectedInfo, expectedTarget) {
  await validateOwnedDirectory(profileScope, await lstat(profileScope), true)
  if (dirname(resolve(link)) !== resolve(profileScope)) {
    throw new Error(`profile package link escapes its validated scope: ${link}`)
  }
  const current = await lstat(link)
  if (!current.isSymbolicLink()
    || !sameFileIdentity(expectedInfo, current)
    || await readlink(link) !== expectedTarget) {
    throw new Error(`profile package symlink changed before unlink: ${link}`)
  }
  assertCurrentUserOwner(link, current)
  await unlink(link)
}

/**
 * Build the fixed safe-by-default environment used by the Jiuzhang launcher.
 * @param {string} home - Absolute Harness home.
 * @param {NodeJS.ProcessEnv} base - Environment values to retain.
 * @returns {NodeJS.ProcessEnv} Child environment.
 */
export function createLaunchEnvironment(home, base = process.env) {
  const mainRoot = resolve(resolveRepositoryRoot(), '..')
  const harnessHome = validateHome(home)
  const environment = {
    DSH_HOME: harnessHome,
    DSH_PERMISSION_MODE: 'read-only',
    DSH_TELEMETRY_DISABLED: '1',
    // One launch-scoped token is injected into the served HTML and consumed
    // by the browser client; callers may supply one for controlled tests.
    DSH_API_TOKEN: base.DSH_API_TOKEN ?? randomBytes(32).toString('base64url'),
    ARK_MAIN_ROOT: base.ARK_MAIN_ROOT ?? mainRoot,
    ARK_WIKI_ROOT: base.ARK_WIKI_ROOT ?? join(mainRoot, 'wiki'),
    // OOM 修复：V8 默认 old-space 上限在 8GB 机器上 ~2.2GB，恢复巨型会话
    // （session.jsonl.zstd 全量解压并物化全部事件）加首次请求序列化峰值即
    // SIGABRT（node-*.ips OOMErrorHandler）。只提升 Native API runner 子进程堆上限。
    NODE_OPTIONS: '--max-old-space-size=4096',
  }

  // A non-production Harness home must never share the production Keychain service.
  if (harnessHome !== validateHome(defaultJiuzhangHome())) {
    environment.ARK_KEYCHAIN_SERVICE = `ark.candidate.credentials.${createHash('sha256').update(harnessHome).digest('hex')}`
  }

  for (const key of inheritedEnvironmentKeys) {
    if (base[key] !== undefined) environment[key] = base[key]
  }

  return environment
}

/**
 * Resolve launch data ownership before the launcher prepares any profile.
 * Native parents always supply both home identities and their data locations;
 * losing part of that contract must not select production defaults.
 * @param {NodeJS.ProcessEnv} base Parent launch environment.
 * @param {{native?: boolean}} options Whether this launch is owned by a native UI parent.
 * @returns {string} The validated Harness home.
 */
export function resolveLaunchHome(base = process.env, { native = false } = {}) {
  if (native && (!base.JIUZHANG_DSH_HOME || !base.DSH_HOME)) {
    throw new Error('Native launch lost its explicit data-home identity')
  }
  const home = validateHome(base.JIUZHANG_DSH_HOME || defaultJiuzhangHome())
  if (native && validateHome(base.DSH_HOME) !== home) {
    throw new Error('Native launcher and backend data-home identities disagree')
  }
  if (native) {
    const dataRoot = home === validateHome(defaultJiuzhangHome()) ? dirname(home) : home
    for (const [key, expected] of [
      ['ARK_MAIN_ROOT', join(dataRoot, 'Knowledge')],
      ['ARK_WIKI_ROOT', join(dataRoot, 'Knowledge', 'wiki')],
      ['ARK_DEFAULT_WORKSPACE', join(dataRoot, 'Default Workspace')],
    ]) {
      if (!base[key] || validateHome(base[key]) !== expected) {
        throw new Error(`Native launch lost or changed its ${key} data owner`)
      }
    }
  }
  return home
}

/**
 * Resolve the dedicated Ark native API runner entry for the selected layout.
 * @returns the absolute entry path, after verifying it is a readable file.
 */
export async function resolveBuiltArkNativeRunner() {
  const path = isStandaloneLayout
    ? standaloneArkRunner
    : join(repositoryRoot, 'packages', 'boot', 'native-api-runner', 'lib', 'bin.js')
  try {
    await access(path, constants.R_OK)
    if (!(await stat(path)).isFile()) throw new Error('not a regular file')
  } catch (error) {
    const instruction = isStandaloneLayout
      ? 'Jiuzhang standalone runtime is missing its Ark native API runner; reassemble the runtime.'
      : 'Jiuzhang requires a built Ark native API runner; run "pnpm run build" first.'
    throw new Error(instruction, { cause: error })
  }
  return path
}

/**
 * Return the working directory the launcher runs the Native API runner from: the repository
 * root in a source checkout, or the runtime root in a standalone runtime.
 */
export function resolveRepositoryRoot() {
  return isStandaloneLayout ? launcherRoot : repositoryRoot
}

/** Resolve the safe cwd used for ordinary chats created without a Workspace. */
export async function resolveSessionWorkingDirectory(base = process.env) {
  const requested = base.ARK_DEFAULT_WORKSPACE
  if (requested === undefined || requested === '') return resolveRepositoryRoot()
  if (!isAbsolute(requested)) {
    throw new Error('ARK_DEFAULT_WORKSPACE must be an absolute path')
  }
  const normalized = resolve(requested)
  if (normalized === parse(normalized).root) {
    throw new Error('ARK_DEFAULT_WORKSPACE cannot be a filesystem root')
  }
  const info = await stat(normalized)
  if (!info.isDirectory()) {
    throw new Error('ARK_DEFAULT_WORKSPACE must be a directory')
  }
  return normalized
}

function validateHome(home) {
  if (typeof home !== 'string' || !isAbsolute(home)) {
    throw new Error('JIUZHANG_DSH_HOME must be an absolute path')
  }
  const normalized = resolve(home)
  if (normalized === parse(normalized).root) {
    throw new Error('JIUZHANG_DSH_HOME cannot be a filesystem root')
  }
  return normalized
}
