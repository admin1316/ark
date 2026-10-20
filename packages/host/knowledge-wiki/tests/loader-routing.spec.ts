/** Real YAML/Loader composition with only external model/credential boundaries synthesized. */
import { boot } from '@deepseek-ai/dsh-app-boot'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import SettingsFile from '@deepseek-ai/dsh-settings-file'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import KnowledgeWiki from '../src/index.ts'

const roots:string[]=[]
const contexts:Context[]=[]
const servers:Server[]=[]
afterEach(async()=>{
  await Promise.all(contexts.splice(0).map(ctx=>ctx.fiber.dispose()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => { resolve() })
  })))
  for(const root of roots.splice(0))rmSync(root,{ recursive:true,force:true })
})
async function endpoint(kind:'text'|'embedding', beforeReply?: (index: number) => Promise<void>) {
  const received:Array<{ authorization:string|undefined;path:string|undefined;body:Record<string,unknown> }>=[]
  const server=createServer((request,response)=>{
    const chunks:Buffer[]=[]
    request.on('data',(chunk:Buffer)=>chunks.push(chunk))
    request.on('end',()=>{
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string,unknown>
      received.push({ authorization:request.headers.authorization,path:request.url,body })
      const send = (): void => {
        if(kind==='embedding'){
          response.setHeader('content-type','application/json')
          response.end(JSON.stringify({ data:(body.input as unknown[]).map(()=>({ embedding:[1,0] })) }))
        }else{
          response.setHeader('content-type','text/event-stream')
          response.end('data: '+JSON.stringify({ choices:[{ index:0,delta:{ content:received.length===1?'source analysis':'no generated blocks' },finish_reason:null }] })+'\n\ndata: '+JSON.stringify({ choices:[{ index:0,delta:{},finish_reason:'stop' }] })+'\n\ndata: [DONE]\n\n')
        }
      }
      if (beforeReply === undefined) send()
      else void beforeReply(received.length - 1).then(send, () => { response.statusCode = 500; response.end() })
    })
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>{resolve()}))
  servers.push(server)
  return { received,baseUrl:'http://127.0.0.1:'+String((server.address() as { port:number }).port)+'/v1' }
}

describe('knowledge shipping-provider Loader routes',()=>{
  it('sends distinct synthetic credentials only to their explicit local endpoints and keeps default vector/vision local',async()=>{
    const root=mkdtempSync(join(tmpdir(),'ark-knowledge-loader-'));roots.push(root)
    mkdirSync(join(root,'wiki'));mkdirSync(join(root,'raw','sources'),{ recursive:true })
    const activeContext: { value?: Context } = {}
    const replacementText = await endpoint('text')
    const text = await endpoint('text', async (index) => {
      if (index !== 0 || activeContext.value === undefined) return
      await activeContext.value.settings.update(settingsNamespace('llm-deepseek'), {
        baseURL: replacementText.baseUrl, apiKeyEnv: 'UNCONFIGURED_REPLACEMENT_FIXTURE_KEY',
      })
    })
    const embedding = await endpoint('embedding')
    const config=join(root,'cordis.yml')
    writeFileSync(config,[
      '- name: cordis:timer',
      '- name: cordis:settings\n  config:\n    path: '+JSON.stringify(join(root,'settings.json'))+'\n    watch: false',
      '- name: cordis:credentials',
      '- name: cordis:llm',
      '- name: cordis:deepseek\n  config:\n    baseURL: '+JSON.stringify(text.baseUrl)+'\n    apiKeyEnv: KNOWLEDGE_TEXT_FIXTURE_KEY\n    thinking: disabled\n    maxTokens: 64',
      '- name: cordis:wiki\n  config:\n    wikiRoot: '+JSON.stringify(join(root,'wiki'))+'\n    mainRoot: '+JSON.stringify(root)+'\n    llmModel: deepseek-v4-flash\n    ownedStageExecutor: true',
    ].join('\n')+'\n')
    const credentialReads:string[]=[]
    let embeddingSecret = 'synthetic-embedding-only-key'
    const credentials={ name:'external-fixture-credentials',apply(ctx:Context){ctx.provide('credentials',{
      async resolve(ref:string){
        credentialReads.push(ref)
        return ref==='KNOWLEDGE_TEXT_FIXTURE_KEY'?{ value:'synthetic-text-only-key',source:'fixture' }:ref==='KNOWLEDGE_EMBED_FIXTURE_KEY'?{ value:embeddingSecret,source:'fixture' }:undefined
      },
    })} }
    const ctx=await boot('knowledge-loader-test',config,[],(owner)=>{
      Object.assign(owner.loader.builtins, {
        timer: Timer, settings: SettingsFile, credentials, llm: LlmRuntime, deepseek: DeepSeek, wiki: KnowledgeWiki,
      })
    })
    contexts.push(ctx)
    activeContext.value = ctx
    const service=ctx.get('knowledgeWiki') as KnowledgeWiki | undefined
    if(service===undefined)throw new Error('knowledge service failed to activate')
    const projectContext=(await service.listProjects()).currentProjectContext
    await service.createPage({ projectContext,title:'Alpha',content:'Alpha canonical source' })
    await service.search({ projectContext,query:'Alpha' })
    expect(embedding.received).toHaveLength(0)
    expect(credentialReads).not.toContain('KNOWLEDGE_EMBED_FIXTURE_KEY')
    expect(await service.projectStatus({ projectContext })).toMatchObject({ searchMode:'keyword',visionConfigured:false,embeddingConfigured:false })
    const image=join(root,'raw','sources','image.png');writeFileSync(image,'synthetic local bytes')
    const localImage=await service.ingestSource({ projectContext,path:'image.png' })
    expect(localImage.warnings).toContain('未配置图片说明连接，图片已保留在本机。')
    expect(text.received).toHaveLength(0)
    await ctx.settings.update(settingsNamespace('knowledge-wiki'),{
      embeddingProvider:'fixture-embedding',embeddingBaseUrl:embedding.baseUrl,embeddingModel:'fixture-vector',embeddingCredential:'KNOWLEDGE_EMBED_FIXTURE_KEY',
    })
    await service.search({ projectContext,query:'Alpha' })
    writeFileSync(join(root,'raw','sources','note.md'),'A reusable source about tests and code.')
    const ingested=await service.ingestSource({ projectContext,path:'note.md' })
    expect(ingested.status).toBe('ok')
    expect(text.received).toHaveLength(2)
    expect(replacementText.received).toHaveLength(0)
    expect(embedding.received).toHaveLength(1)
    expect(text.received.every(request=>request.authorization==='Bearer synthetic-text-only-key')).toBe(true)
    expect(embedding.received.every(request=>request.authorization==='Bearer synthetic-embedding-only-key')).toBe(true)
    expect(text.received.every(request=>request.path==='/v1/chat/completions')).toBe(true)
    expect(embedding.received[0]?.path).toBe('/v1/embeddings')
    const stored=readFileSync(join(root,'settings.json'),'utf8')
    expect(stored).not.toContain('synthetic-text-only-key')
    expect(stored).not.toContain('synthetic-embedding-only-key')
    const replacementEmbedding = await endpoint('embedding')
    await ctx.settings.update(settingsNamespace('knowledge-wiki'), {
      embeddingBaseUrl: replacementEmbedding.baseUrl,
    })
    await service.search({ projectContext, query: 'Alpha' })
    expect(replacementEmbedding.received).toHaveLength(1)
    expect(embedding.received).toHaveLength(1)
    expect(replacementEmbedding.received[0]?.authorization).toBe('Bearer synthetic-embedding-only-key')
    embeddingSecret = 'synthetic-embedding-rotated-key'
    await service.search({ projectContext, query: 'Alpha' })
    expect(replacementEmbedding.received).toHaveLength(2)
    expect(replacementEmbedding.received[1]?.authorization).toBe('Bearer synthetic-embedding-rotated-key')
    const blocked=await service.deepResearch({ projectContext,topic:'no configured search' },new AbortController().signal)
    expect(blocked).toMatchObject({ findings:[],sourceCount:0,degraded:true,errorCode:'web-search-unavailable' })
    expect(text.received).toHaveLength(2)
  })
})
