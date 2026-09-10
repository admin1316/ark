/** Validate the complete local provider-artwork payload before native packaging. */
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const pngName = /^[a-z0-9-]+\.png$/u

/** Verify ordinary files, image bounds, license and exact source hashes without network access. */
export async function verifyProviderIcons(directory) {
  if (!(await lstat(directory)).isDirectory()) throw new Error('provider artwork root must be an ordinary directory')
  const provenance = join(directory, 'provenance.json')
  if (!(await lstat(provenance)).isFile()) throw new Error('provider artwork provenance must be an ordinary file')
  const manifest = JSON.parse(await readFile(provenance, 'utf8'))
  if (manifest.upstream !== 'https://github.com/lobehub/lobe-icons'
    || manifest.license !== 'MIT' || !/^[0-9a-f]{40}$/u.test(manifest.commit)
    || manifest.licenseFile !== 'LICENSE-LobeHub.txt' || !Array.isArray(manifest.files) || manifest.files.length === 0
    || manifest.providers === null || typeof manifest.providers !== 'object' || Array.isArray(manifest.providers)) {
    throw new Error('provider artwork provenance is incomplete')
  }
  const files = new Map()
  let bytes = 0
  for (const entry of manifest.files) {
    if (typeof entry.file !== 'string' || !pngName.test(entry.file) || files.has(entry.file)) throw new Error('invalid or duplicate provider artwork name')
    const source = join(directory, entry.file)
    if (!(await lstat(source)).isFile()) throw new Error(`provider artwork must be an ordinary file: ${entry.file}`)
    const data = await readFile(source)
    if (data.length < 24 || data.length > 200_000 || data.length !== entry.bytes || digest(data) !== entry.sha256
      || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`provider artwork identity mismatch: ${entry.file}`)
    const gitBlob = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex')
    if (gitBlob !== entry.gitBlob
      || entry.source !== `https://raw.githubusercontent.com/lobehub/lobe-icons/${manifest.commit}/packages/static-png/light/${entry.file}`) {
      throw new Error(`provider artwork upstream identity mismatch: ${entry.file}`)
    }
    if (entry.width < 1 || entry.width > 1024 || entry.height < 1 || entry.height > 1024
      || data.readUInt32BE(16) !== entry.width || data.readUInt32BE(20) !== entry.height) {
      throw new Error(`provider artwork dimensions mismatch: ${entry.file}`)
    }
    files.set(entry.file, entry)
    bytes += data.length
  }
  if (!(await lstat(join(directory, manifest.licenseFile))).isFile()
    || digest(await readFile(join(directory, manifest.licenseFile))) !== manifest.licenseSha256) throw new Error('provider artwork license mismatch')
  const referenced = new Set(Object.values(manifest.providers))
  if (referenced.size !== files.size || [...referenced].some(file => !files.has(file))
    || Object.keys(manifest.providers).some(id => !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(id))) {
    throw new Error('provider artwork mapping differs from its payload')
  }
  const expected = new Set([...files.keys(), manifest.licenseFile, 'provenance.json'])
  const actual = await readdir(directory)
  if (actual.length !== expected.size || actual.some(file => !expected.has(file))) throw new Error('provider artwork contains undeclared files')
  return { icons: files.size, providers: Object.keys(manifest.providers).length, bytes }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2] ?? fileURLToPath(new URL('./Resources/ProviderIcons', import.meta.url))
  console.log(JSON.stringify(await verifyProviderIcons(directory)))
}
