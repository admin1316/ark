/** Explicit credential gates for the independently billed provider test routes. */
export interface ProviderCase {
  provider: 'openai' | 'azure-openai' | 'anthropic'
  api: 'openai-responses' | 'anthropic-messages'
  model: string
  apiKeyEnv?: string
  baseURL?: string
  headers?: Record<string, string>
  credentialHeaders?: Record<string, string>
}

/** Build separate official, Azure and Anthropic cases without reading credentials into reports. */
export function providerApiCases(environment: Readonly<Record<string, string | undefined>>): ProviderCase[] {
  const configured = (name: string): boolean => (environment[name]?.trim().length ?? 0) > 0
  return [
    {
      provider: 'openai', api: 'openai-responses',
      model: environment.DSH_PI_AI_OPENAI_MODEL ?? 'gpt-6.1-sol',
      ...configured('OPENAI_API_KEY') ? { apiKeyEnv: 'OPENAI_API_KEY' } : {},
      ...environment.DSH_PI_AI_OPENAI_BASE_URL ? { baseURL: environment.DSH_PI_AI_OPENAI_BASE_URL } : {},
    },
    {
      provider: 'azure-openai', api: 'openai-responses',
      model: environment.DSH_PI_AI_AZURE_MODEL ?? 'gpt-5.5',
      ...configured('AZURE_OPENAI_API_KEY') && configured('DSH_PI_AI_AZURE_BASE_URL')
        ? { apiKeyEnv: 'AZURE_OPENAI_API_KEY', credentialHeaders: { 'api-key': 'AZURE_OPENAI_API_KEY' }, headers: { Authorization: '' } }
        : {},
      ...environment.DSH_PI_AI_AZURE_BASE_URL ? { baseURL: environment.DSH_PI_AI_AZURE_BASE_URL } : {},
    },
    {
      provider: 'anthropic', api: 'anthropic-messages',
      model: environment.DSH_PI_AI_ANTHROPIC_MODEL ?? 'claude-opus-4-8',
      ...configured('ANTHROPIC_API_KEY') ? { apiKeyEnv: 'ANTHROPIC_API_KEY' } : {},
      ...environment.DSH_PI_AI_ANTHROPIC_BASE_URL ? { baseURL: environment.DSH_PI_AI_ANTHROPIC_BASE_URL } : {},
    },
  ]
}
