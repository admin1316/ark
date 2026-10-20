import { describe, expect, it } from 'vitest'
import { providerApiCases } from './provider-api-cases.ts'

describe('provider API credential gates', () => {
  it('enables the official OpenAI route with only its own key', () => {
    const cases = providerApiCases({ OPENAI_API_KEY: 'synthetic-openai-key' })
    expect(cases.map(route => [route.provider, route.apiKeyEnv])).toEqual([
      ['openai', 'OPENAI_API_KEY'], ['azure-openai', undefined], ['anthropic', undefined],
    ])
    expect(JSON.stringify(cases)).not.toContain('synthetic-openai-key')
    expect(cases[0]?.credentialHeaders).toBeUndefined()
  })

  it('requires both an Azure key and an explicit Azure endpoint', () => {
    expect(providerApiCases({ AZURE_OPENAI_API_KEY: 'synthetic' })[1]?.apiKeyEnv).toBeUndefined()
    expect(providerApiCases({ DSH_PI_AI_AZURE_BASE_URL: 'https://azure.example/openai/v1' })[1]?.apiKeyEnv).toBeUndefined()
    const routes = providerApiCases({ AZURE_OPENAI_API_KEY: 'synthetic', DSH_PI_AI_AZURE_BASE_URL: 'https://azure.example/openai/v1' })
    expect(routes[0]?.apiKeyEnv).toBeUndefined()
    expect(routes[1]).toMatchObject({
      apiKeyEnv: 'AZURE_OPENAI_API_KEY', baseURL: 'https://azure.example/openai/v1',
      credentialHeaders: { 'api-key': 'AZURE_OPENAI_API_KEY' }, headers: { Authorization: '' },
    })
  })

  it('keeps all three routes independent when all are configured', () => {
    const routes = providerApiCases({ OPENAI_API_KEY: 'synthetic', AZURE_OPENAI_API_KEY: 'synthetic',
      DSH_PI_AI_AZURE_BASE_URL: 'https://azure.example/openai/v1', ANTHROPIC_API_KEY: 'synthetic' })
    expect(routes.map(route => route.apiKeyEnv)).toEqual(['OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'ANTHROPIC_API_KEY'])
    expect(new Set(routes.map(route => route.provider)).size).toBe(3)
  })

  it('skips missing and blank keys without borrowing DeepSeek credentials', () => {
    for (const environment of [{}, { OPENAI_API_KEY: ' ', ANTHROPIC_API_KEY: '', DEEPSEEK_API_KEY: 'synthetic' }]) {
      expect(providerApiCases(environment).every(route => route.apiKeyEnv === undefined)).toBe(true)
    }
  })
})
