import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('@earendil-works/pi-ai/providers/all')
  vi.resetModules()
})

it('rejects a preset whose pinned protocol owner is missing', async () => {
  vi.resetModules()
  vi.doMock('@earendil-works/pi-ai/providers/all', async importOriginal => ({
    ...await importOriginal<typeof import('@earendil-works/pi-ai/providers/all')>(),
    builtinProviders: () => [],
  }))
  const catalog = await import('../src/catalog.ts')
  expect(() => catalog.catalogProvider('bailian-cn')).toThrow('Bailian presets require the installed Qwen protocol owner')
})

it('rejects a preset when the pinned canonical model capabilities are missing', async () => {
  vi.resetModules()
  vi.doMock('@earendil-works/pi-ai/providers/all', async importOriginal => ({
    ...await importOriginal<typeof import('@earendil-works/pi-ai/providers/all')>(),
    getBuiltinModels: () => [],
  }))
  const catalog = await import('../src/catalog.ts')
  expect(() => catalog.catalogProvider('bailian-cn')).toThrow('Bailian preset model capabilities are missing')
})
