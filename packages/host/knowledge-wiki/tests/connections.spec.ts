import { describe, expect, it } from 'vitest'
import { validateKnowledgeConnections, type KnowledgeConnections } from '../src/connections.ts'
const empty:KnowledgeConnections={ textProvider:'deepseek-official',textModel:'fixture',visionProvider:'',visionModel:'',embeddingProvider:'',embeddingBaseUrl:'',embeddingModel:'',embeddingCredential:'' }
describe('independent knowledge route settings',()=>{
  it('allows local keyword mode with no vector/vision credentials',()=>{expect(()=>{ validateKnowledgeConnections(empty) }).not.toThrow()})
  it.each([
    { visionProvider:'fixture' },
    { embeddingProvider:'fixture' },
    { textProvider:'' },
    { embeddingProvider:'fixture',embeddingModel:'m',embeddingBaseUrl:'https://user:password@fixture.test',embeddingCredential:'EMBED_KEY' },
    { embeddingProvider:'fixture',embeddingModel:'m',embeddingBaseUrl:'http://public.fixture.test',embeddingCredential:'EMBED_KEY' },
    { embeddingProvider:'fixture',embeddingModel:'m',embeddingBaseUrl:'https://fixture.test?key=value',embeddingCredential:'EMBED_KEY' },
    { embeddingProvider:'fixture',embeddingModel:'m',embeddingBaseUrl:'https://fixture.test',embeddingCredential:'literal-secret-value' },
  ])('rejects incomplete or credential-shaped route configuration %j',(patch)=>{expect(()=>{ validateKnowledgeConnections({ ...empty,...patch }) }).toThrow()})
  it('permits an explicitly independent local test endpoint',()=>{expect(()=>{ validateKnowledgeConnections({ ...empty,embeddingProvider:'fixture',embeddingModel:'m',embeddingBaseUrl:'http://127.0.0.1:9000/v1',embeddingCredential:'EMBED_FIXTURE_KEY' }) }).not.toThrow()})
})
