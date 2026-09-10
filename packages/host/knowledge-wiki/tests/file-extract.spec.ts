import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile }))

import { extractFileText } from '../src/file-extract.ts'

afterEach(() => {
  vi.clearAllMocks()
})

describe('file text extraction', () => {
  it('reads supported text formats and reports read errors', async () => {
    mocks.readFile.mockResolvedValueOnce('# page')
    await expect(extractFileText('/project/README.MD')).resolves.toBe('# page')
    expect(mocks.readFile).toHaveBeenCalledWith('/project/README.MD', 'utf8')

    mocks.readFile.mockRejectedValueOnce(new Error('denied'))
    await expect(extractFileText('/project/data.json')).rejects.toThrow('denied')
  })

  it('refuses Office/PDF parsing before non-cooperative work starts', async () => {
    await expect(extractFileText('/project/report.PDF')).rejects.toThrow('owned stage executor')
    await expect(extractFileText('/project/report.docx')).rejects.toThrow('owned stage executor')
  })

  it('returns null for unsupported formats without touching the filesystem', async () => {
    await expect(extractFileText('/project/archive.zip')).resolves.toBeNull()
    expect(mocks.readFile).not.toHaveBeenCalled()
  })

})
