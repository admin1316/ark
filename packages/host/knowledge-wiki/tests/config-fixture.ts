import s from '@deepseek-ai/schemastery'
import KnowledgeWikiService, { type Config } from '../src/index.ts'

/** Resolve partial test deployments through the production loader schema. */
export function wikiTestConfig(config: Pick<Config, 'wikiRoot'> & Partial<Config>): Config {
  const resolved: unknown = s.resolve(config, KnowledgeWikiService.Config, {})[0]
  if (!isResolvedConfig(resolved)) throw new TypeError('knowledge Wiki test config did not resolve')
  return resolved
}

/** The loader schema fills every deployment default, so a resolved config is complete. */
function isResolvedConfig(value: unknown): value is Config {
  if (typeof value !== 'object' || value === null) return false
  return typeof Reflect.get(value, 'wikiRoot') === 'string'
    && typeof Reflect.get(value, 'mainRoot') === 'string'
    && typeof Reflect.get(value, 'credential') === 'string'
    && typeof Reflect.get(value, 'llmProvider') === 'string'
    && typeof Reflect.get(value, 'llmModel') === 'string'
    && typeof Reflect.get(value, 'llmBaseUrl') === 'string'
    && typeof Reflect.get(value, 'llmCredential') === 'string'
    && typeof Reflect.get(value, 'ownedStageExecutor') === 'boolean'
}
