import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import KnowledgeWikiService from '../src/index.ts'
import { wikiTestConfig } from './config-fixture.ts'
import type { KnowledgeWikiStageExecutor } from '../src/stage-executor.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-project-boundary-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  const main = join(root, 'main')
  mkdirSync(join(main, 'wiki'), { recursive: true })
  const service = new KnowledgeWikiService(ctx, wikiTestConfig({ wikiRoot:join(main,'wiki'),mainRoot:main }))
  const a = await service.createProject({ name:'A',path:join(root,'A') })
  const b = await service.createProject({ name:'B',path:join(root,'B') })
  if (!a.projectContext || !b.projectContext) throw new Error('fixture registration failed')
  return { ctx,service,a:{ ...a,projectContext:a.projectContext },b:{ ...b,projectContext:b.projectContext } }
}

describe('knowledge RPC project identity', () => {
  it('keeps A reads, writes, utility, and queue bound to A after switching to B', async () => {
    const { service,a,b }=await fixture()
    const path='_candidates/shared.md'
    await service.writePage({ projectContext:a.projectContext,path,content:'identical initial' })
    await service.writePage({ projectContext:b.projectContext,path,content:'identical initial' })
    await service.setProject({ path:b.path })
    await expect(service.writePage({ projectContext:a.projectContext,path,content:'A only',expectedContent:'identical initial' })).resolves.toMatchObject({ ok:true })
    expect((await service.pageContent({ projectContext:a.projectContext,path })).content).toBe('A only')
    expect((await service.pageContent({ projectContext:b.projectContext,path })).content).toBe('identical initial')
    expect(readFileSync(join(b.path,'wiki',path),'utf8')).toBe('identical initial')
    const registry=await service.listProjects()
    expect(registry.projects.find(row=>row.path===a.path)?.projectContext).toBe(a.projectContext)
    expect(registry.currentProjectContext).toBe(b.projectContext)
  })

  it('revokes removed project tokens without deleting any project files', async () => {
    const { service,a }=await fixture()
    await service.writePage({ projectContext:a.projectContext,path:'_candidates/safe.md',content:'preserve' })
    await service.removeProject({ path:a.path })
    await expect(service.list({ projectContext:a.projectContext })).rejects.toThrow('project context')
    expect(readFileSync(join(a.path,'wiki','_candidates','safe.md'),'utf8')).toBe('preserve')
    const registered=await service.createProject({ name:'A again',path:a.path })
    expect(registered.projectContext).not.toBe(a.projectContext)
    await expect(service.pageContent({ projectContext:a.projectContext,path:'_candidates/safe.md' })).rejects.toThrow('project context')
  })

  it('rejects missing or fabricated identities at every project-scoped executor', async () => {
    const { service }=await fixture()
    const requests: Record<string,object>={ graph:{},fullGraph:{},list:{},search:{ query:'q' },knowledgeUtility:{},recordKnowledgeOutcome:{ paths:[],outcome:'neutral' },pageContent:{ path:'x.md' },writePage:{ path:'_candidates/x.md',content:'must not write' },createPage:{ title:'must not create' },ingestSource:{ path:'x.md' },ingestUrl:{ url:'https://fixture.test' },ingestQueueAdd:{ inputs:[] },ingestQueueStatus:{},ingestQueueCancel:{},deepResearch:{ topic:'must not call model' },reviews:{},verifyCandidate:{ reviewId:'absent',action:'Promote' },resolveReview:{ reviewId:'absent' },resolveReviews:{ ids:[] },graphInsights:{},lint:{},exportProject:{},importProject:{ path:'/absent.zip' },projectStatus:{} }
    const methods=service as unknown as Record<string,(request:object,signal:AbortSignal)=>Promise<unknown>>
    for (const token of [undefined,'fabricated']) {
      for (const [method,args] of Object.entries(requests)) {
        try {
          const input = { ...args, ...token === undefined ? {} : { projectContext: token } }
          const result = await methods[method]!.call(service, input, new AbortController().signal)
          expect(result,method).toMatchObject({ status:'error',errorCode:'invalid-input' })
        } catch (error) {
          expect(String(error),method).toContain('project context')
        }
      }
    }
  })

  it('pins research writes to A while UI selection changes to B', async () => {
    const { ctx,service,a,b }=await fixture()
    const gate=Promise.withResolvers<undefined>()
    const started=Promise.withResolvers<undefined>()
    let calls=0
    const executor:KnowledgeWikiStageExecutor={
      isolation:'owned-worker-v1',assertSearchAvailable(){},
      async execute(request){
        if(request.kind==='web-search')return { text:null,sources:[{ url:'https://source.fixture.test',title:'source' }] }
        if(request.kind!=='llm-complete')throw new Error('unexpected stage')
        if(calls++===0){started.resolve(undefined);await gate.promise;return { text:'specific query' }}
        return { text:'--- FILE: wiki/_candidates/research/proof.md ---\n---\ntitle: Proof\n---\n\nSupported finding [source](https://source.fixture.test)\n--- END FILE ---' }
      },
    }
    ctx.provide('knowledgeWikiStageExecutor',executor)
    const pending=service.deepResearch({ projectContext:a.projectContext,topic:'proof' },new AbortController().signal)
    await started.promise
    await service.setProject({ path:b.path })
    gate.resolve(undefined)
    const result=await pending
    expect(result.sourceCount).toBe(1)
    expect(result.findings).toHaveLength(1)
    expect(readFileSync(join(a.path,result.findings[0]!.path),'utf8')).toContain('Supported finding')
    expect(readdirSync(join(b.path,'wiki'))).not.toContain('_candidates')
  })
})
