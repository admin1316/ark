/** Real YAML/Loader assembly; only search and model output are synthetic. */
import { boot } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { LlmAdapter, LlmRuntime, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import WebRuntime from '@deepseek-ai/dsh-web'
import SettingsFile from '@deepseek-ai/dsh-settings-file'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import KnowledgeWikiService from '../src/index.ts'

it('boots research and snapshots invalid citations, governed success, and all-collision failure without a key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'research-loader-'))
  mkdirSync(join(root, 'wiki')); mkdirSync(join(root, 'raw/sources'), { recursive: true })
  const outputs = [
    '[invented](https://invented.test/)', '[actual](https://actual.test/report)', '[actual](https://actual.test/report)',
  ]
  let calls = 0
  class FixtureAdapter extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      calls++
      const prompt = options.messages.at(-1)?.content.find(block => block.type === 'text')
      yield { type: 'text-delta', index: 0, text: prompt?.type === 'text' && prompt.text.startsWith('You are a research assistant.')
        ? 'synthetic focused query'
        : `--- FILE: wiki/_candidates/research/result.md ---\n---\ntitle: Result\nstatus: canonical\norigin: human\n---\n\n${outputs.shift()!}\n--- END FILE ---` }
    }
  }
  const external = { name: 'synthetic-search-and-model', inject: ['llm', 'web'], apply(ctx: Context) {
    ctx.llm.registerAdapter(['synthetic-research'], new FixtureAdapter())
    ctx.web.registerSearchProvider({ id: 'synthetic-search', available: () => true,
      async search() { return { sources: [{ url: 'https://actual.test/report', title: 'Actual search result', snippet: 'Synthetic search snippet.' }], truncated: false } } })
  } }
  const credentials = { name: 'synthetic-empty-credentials', apply(ctx: Context) {
    ctx.provide('credentials', { async resolve() { return undefined } })
  } }
  const config = join(root, 'cordis.yml')
  writeFileSync(config, [
    '- name: cordis:timer', '- name: cordis:llm', '- name: cordis:web', '- name: cordis:external', '- name: cordis:credentials',
    '- name: cordis:settings\n  config:\n    path: ' + JSON.stringify(join(root, 'settings.json')) + '\n    watch: false',
    '- name: cordis:wiki\n  config:\n    mainRoot: ' + JSON.stringify(root) + '\n    wikiRoot: ' + JSON.stringify(join(root, 'wiki'))
      + '\n    llmProvider: synthetic-research\n    llmModel: synthetic-model\n    ownedStageExecutor: true',
  ].join('\n') + '\n')
  let ctx: Context | undefined
  try {
    ctx = await boot('research-evidence-loader', config, [], (owner) => {
      Object.assign(owner.loader.builtins, {
        timer: Timer, llm: LlmRuntime, web: WebRuntime, external, settings: SettingsFile, credentials, wiki: KnowledgeWikiService,
      })
    })
    const service = ctx.get('knowledgeWiki') as KnowledgeWikiService | undefined
    if (service === undefined) throw new Error('assembled knowledge service is unavailable')
    const projectContext = (await service.listProjects()).currentProjectContext
    const results = []
    for (const topic of ['invalid', 'valid', 'collision']) {
      const result = await service.deepResearch({ projectContext, topic }, new AbortController().signal)
      results.push({ errorCode: result.errorCode ?? null, findings: result.findings, sources: result.sources, degraded: result.degraded })
    }
    expect(calls).toBe(6)
    expect(readFileSync(join(root, 'wiki/_candidates/research/result.md'), 'utf8')).toContain('status: candidate\norigin: research')
    expect(results).toMatchInlineSnapshot(`
      [
        {
          "degraded": true,
          "errorCode": "invalid-citations",
          "findings": [],
          "sources": [
            {
              "evidence": "search-snippet",
              "title": "Actual search result",
              "url": "https://actual.test/report",
            },
          ],
        },
        {
          "degraded": false,
          "errorCode": null,
          "findings": [
            {
              "path": "wiki/_candidates/research/result.md",
              "sourceURLs": [
                "https://actual.test/report",
              ],
              "title": "result.md",
            },
          ],
          "sources": [
            {
              "evidence": "search-snippet",
              "title": "Actual search result",
              "url": "https://actual.test/report",
            },
          ],
        },
        {
          "degraded": true,
          "errorCode": "no-pages",
          "findings": [],
          "sources": [
            {
              "evidence": "search-snippet",
              "title": "Actual search result",
              "url": "https://actual.test/report",
            },
          ],
        },
      ]
    `)
  } finally {
    await ctx?.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
