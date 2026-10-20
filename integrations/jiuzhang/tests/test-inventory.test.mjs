import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { arkTestInventory, verifyArkTestInventory } from './helpers/test-inventory.mjs'

test('the required runner registers every Ark test including compiler and provider artwork gates', async () => {
  const result = await verifyArkTestInventory(fileURLToPath(new URL('.', import.meta.url)))
  assert.equal(result.registered, Object.values(arkTestInventory).flat().length)
  assert.ok(arkTestInventory.portable.includes('native-build.test.mjs'))
  assert.ok(arkTestInventory.portable.includes('provider-icons.test.mjs'))
})

test('a newly added test, stale registration, or duplicate fails the inventory gate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ark-inventory-'))
  try {
    await writeFile(join(root, 'existing.test.mjs'), '')
    const inventory = { portable: ['existing.test.mjs'], macos: [] }
    await verifyArkTestInventory(root, inventory)
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'nested/new.test.ts'), '')
    await assert.rejects(verifyArkTestInventory(root, inventory), /unregistered: nested\/new\.test\.ts/u)
    await rm(join(root, 'nested'), { recursive: true })
    await assert.rejects(verifyArkTestInventory(root, { portable: ['absent.test.mjs'], macos: [] }), /missing: absent\.test\.mjs/u)
    await assert.rejects(verifyArkTestInventory(root, { portable: ['existing.test.mjs'], macos: ['existing.test.mjs'] }), /duplicate/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
