import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { verifyProviderIcons } from '../native/provider-icons.mjs'

const source = fileURLToPath(new URL('../native/Resources/ProviderIcons', import.meta.url))

test('native provider marks have a complete local image, license and source receipt', async () => {
  const result = await verifyProviderIcons(source)
  assert.ok(result.icons > 0 && result.providers >= result.icons && result.bytes > 0)
  const manifest = JSON.parse(await readFile(join(source, 'provenance.json'), 'utf8'))
  assert.equal(manifest.providers.deepseek, manifest.providers['deepseek-official'])
  assert.equal(manifest.providers.openai, manifest.providers['openai-codex'])
})

for (const corruption of ['image', 'license', 'missing', 'mapping', 'extra', 'symlink', 'manifest-link', 'upstream']) {
  test(`native provider artwork rejects ${corruption} corruption before packaging`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'ark-provider-icons-'))
    const directory = join(root, 'icons')
    try {
      await cp(source, directory, { recursive: true })
      const manifestPath = join(directory, 'provenance.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      const imagePath = join(directory, manifest.files[0].file)
      if (corruption === 'image') await writeFile(imagePath, 'not an image')
      if (corruption === 'license') await writeFile(join(directory, manifest.licenseFile), 'missing attribution')
      if (corruption === 'missing') await rm(imagePath)
      if (corruption === 'mapping') {
        manifest.providers.openai = 'not-present.png'
        await writeFile(manifestPath, JSON.stringify(manifest))
      }
      if (corruption === 'upstream') {
        manifest.files[0].source = 'https://untrusted.invalid/logo.png'
        await writeFile(manifestPath, JSON.stringify(manifest))
      }
      if (corruption === 'extra') await writeFile(join(directory, 'undeclared.txt'), 'not in payload')
      if (corruption === 'symlink' || corruption === 'manifest-link') {
        const selected = corruption === 'symlink' ? imagePath : manifestPath
        const target = join(root, 'link-target')
        await writeFile(target, await readFile(selected))
        await rm(selected)
        await symlink(target, selected)
      }
      await assert.rejects(verifyProviderIcons(directory))
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}
