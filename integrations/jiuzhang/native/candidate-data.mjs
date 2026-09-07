/** Candidate build metadata. Production builds ignore candidate-home environment values. */
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const nativeRoot = fileURLToPath(new URL('.', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const canonical = value => {
  try { return fs.realpathSync(value) } catch (error) {
    if (error.code === 'ENOENT') return path.resolve(value)
    throw error
  }
}
const overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)

/**
 * Resolve an explicitly opted-in test build's private home and bundle identity.
 * @param {NodeJS.ProcessEnv} environment Build environment.
 * @returns {{candidate: boolean, home?: string, bundleIdentifier?: string}} Candidate metadata or unchanged production mode.
 */
export function candidateDataPlan(environment = process.env) {
  const enabled = environment.JIUZHANG_CANDIDATE_BUILD || '0'
  if (enabled === '0') return { candidate: false }
  if (enabled !== '1') throw new Error('JIUZHANG_CANDIDATE_BUILD must be 0 or 1')
  const raw = environment.JIUZHANG_CANDIDATE_DATA_HOME
  if (!raw || !path.isAbsolute(raw) || raw !== raw.trim() || /[\u0000-\u001f\u007f]/u.test(raw)) {
    throw new Error('Candidate data home must be a non-empty absolute path')
  }
  const info = fs.lstatSync(raw)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
    throw new Error('Candidate data home must be an existing owner-only ordinary directory')
  }
  const home = canonical(raw)
  const protectedRoots = [canonical(repositoryRoot), canonical(path.join(homedir(), 'Library/Application Support/Ark'))]
  if (home === path.parse(home).root || protectedRoots.some(root => overlaps(home, root))) {
    throw new Error('Candidate data home overlaps source or production data')
  }
  const productionID = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(nativeRoot, 'Resources/Info.plist')], { encoding: 'utf8' }).trim()
  const suffix = createHash('sha256').update(home).digest('hex').slice(0, 16)
  return { candidate: true, home, bundleIdentifier: `${productionID}.candidate.${suffix}` }
}

/**
 * Apply candidate identity only to an ordinary, non-production app Info.plist.
 * @param {string} infoPath Built candidate Info.plist path.
 * @param {ReturnType<typeof candidateDataPlan>} plan Validated build configuration.
 * @returns {void} Writes candidate metadata; production mode is a no-op.
 */
export function applyCandidateDataPlan(infoPath, plan) {
  if (!plan.candidate) return
  if (!path.isAbsolute(infoPath) || path.basename(infoPath) !== 'Info.plist' || path.basename(path.dirname(infoPath)) !== 'Contents') throw new Error('Expected an absolute app Info.plist')
  const info = fs.lstatSync(infoPath)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Candidate Info.plist must be an ordinary file')
  const app = canonical(path.resolve(infoPath, '../..'))
  if (!app.endsWith('.app') || app === '/Applications/Ark.app' || app.startsWith('/Applications/') || overlaps(plan.home, app) || overlaps(app, canonical(repositoryRoot))) {
    throw new Error('Candidate bundle overlaps a protected or data path')
  }
  for (const [operation, key, type, value] of [
    ['-replace', 'CFBundleIdentifier', '-string', plan.bundleIdentifier],
    ['-replace', 'CFBundleDisplayName', '-string', 'Ark 测试候选'],
    ['-insert', 'ArkCandidateBuild', '-bool', 'YES'],
    ['-insert', 'ArkCandidateDataHome', '-string', plan.home],
  ]) execFileSync('/usr/bin/plutil', [operation, key, type, value, infoPath])
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const plan = candidateDataPlan()
    if (process.argv[2] === 'apply' && process.argv[3]) applyCandidateDataPlan(process.argv[3], plan)
    else if (process.argv[2] !== 'plan') throw new Error('Usage: candidate-data.mjs plan | apply /candidate/Ark.app/Contents/Info.plist')
    console.log(JSON.stringify(plan))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
