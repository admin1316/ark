import s from '@deepseek-ai/schemastery'
import KnowledgeWikiService, { type Config } from '../src/index.ts'

/** Resolve partial test deployments through the production loader schema. */
export function wikiTestConfig(config: Pick<Config, 'wikiRoot'> & Partial<Config>): Config {
  return s.resolve(config, KnowledgeWikiService.Config, {})[0]
}
