import { describe, expect, it } from 'vitest'
import { extractFileText } from '../src/file-extract.ts'

describe('Office module boundary', () => {
  it('never imports an in-process Office parser', async () => {
    await expect(extractFileText('/project/report.pptx')).rejects.toThrow('owned stage executor')
  })
})
