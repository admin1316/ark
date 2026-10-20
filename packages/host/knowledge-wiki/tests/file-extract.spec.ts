import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { extractFileText, decodeKnowledgeText } from '../src/file-extract.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function source(name: string, bytes: string | Buffer): string {
  const root = mkdtempSync(join(tmpdir(), 'strict-knowledge-text-'))
  roots.push(root)
  const path = join(root, name)
  writeFileSync(path, bytes)
  return path
}

describe('strict knowledge text admission', () => {
  it('reads Chinese and table content without replacing bytes', async () => {
    const text = '# 正文\n\n| 名称 | 数量 |\n|---|---|\n| 样本 | 2 |\n'
    await expect(extractFileText(source('README.MD', text))).resolves.toBe(text)
  })
  it.each(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'epub'])('rejects %s before touching a file', async (ext) => {
    await expect(extractFileText('/absent/report.' + ext)).rejects.toThrow('verified text extractor')
  })
  it.each([Buffer.from([0xff]), Buffer.from([0]), Buffer.from('PK\x03\x04word/document.xml'), Buffer.from('%PDF-1.7')])('rejects binary content disguised as text', async (bytes) => {
    await expect(extractFileText(source('disguised.txt', bytes))).rejects.toThrow()
  })
  it('refuses oversized input and unsupported formats', async () => {
    expect(() => decodeKnowledgeText('large.md', new Uint8Array(5 * 1024 * 1024 + 1))).toThrow('limit')
    await expect(extractFileText('/absent/archive.zip')).resolves.toBeNull()
  })
  it('does not follow a leaf symlink', async () => {
    const path = source('note.md', 'safe')
    const link = path + '.txt'
    symlinkSync(path, link)
    await expect(extractFileText(link)).rejects.toThrow()
  })
})
