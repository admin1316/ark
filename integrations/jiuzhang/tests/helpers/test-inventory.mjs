import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Explicit test ownership keeps platform-only suites out of portable CI. */
export const arkTestInventory = Object.freeze({
  portable: [
    'deepseek-extension-acceptance.test.ts',
    'profile.test.mjs',
    'runtime.test.mjs',
    'runtime-closure.test.mjs',
    'runtime-plan.test.mjs',
    'native-build.test.mjs',
    'native-only.test.mjs',
    'native-artifact-safety.test.mjs',
    'provider-icons.test.mjs',
    'lifecycle.test.mjs',
    'test-inventory.test.mjs',
    'evaluation-report.test.mjs',
  ],
  macos: ['candidate-data.test.mjs'],
})

/** Reject missing, duplicate, stale, or silently unregistered executable tests. */
export async function verifyArkTestInventory(directory, inventory = arkTestInventory) {
  const registered = Object.values(inventory).flat()
  const duplicates = registered.filter((file, index) => registered.indexOf(file) !== index)
  if (duplicates.length > 0) throw new Error(`duplicate Ark tests: ${duplicates.join(', ')}`)
  const actual = []
  async function visit(path, prefix = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const relative = prefix + entry.name
      if (entry.isDirectory()) await visit(join(path, entry.name), `${relative}/`)
      else if (/\.test\.(?:mjs|ts)$/u.test(entry.name)) {
        if (!entry.isFile()) throw new Error(`Ark test must be an ordinary file: ${relative}`)
        actual.push(relative)
      }
    }
  }
  await visit(directory)
  const missing = actual.filter(file => !registered.includes(file))
  const stale = registered.filter(file => !actual.includes(file))
  if (missing.length > 0 || stale.length > 0) {
    throw new Error(`Ark test inventory mismatch; unregistered: ${missing.join(', ') || '(none)'}; missing: ${stale.join(', ') || '(none)'}`)
  }
  return { registered: registered.length, portable: inventory.portable.length, macos: inventory.macos.length }
}
