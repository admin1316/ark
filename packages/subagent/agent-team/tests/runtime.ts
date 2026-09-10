/** Real Loader composition; only the external model is scripted. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuerySqlite from '@deepseek-ai/dsh-session-query-sqlite'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as TeamTools from '@deepseek-ai/dsh-tool-agent-team'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import TeamService from '../src/index.ts'

export async function createTeamRuntime(script: ConstructorParameters<typeof MockAdapter>[0]) {
  const root = await mkdtemp(join(tmpdir(), 'ark-team-source-'))
  const scriptedRequestLimit = script.length
  const adapter = new MockAdapter(script)
  const ctx = new Context()
  try {
    const fixture = await readFile(new URL('./fixtures/runtime.yml', import.meta.url), 'utf8')
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, fixture.replace('__PERSISTENCE_ROOT__', JSON.stringify(join(root, 'sessions'))))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, {
      include: Include,
      'team-test-llm': LlmRuntime,
      'team-test-sessions': SessionStore,
      'team-test-prompt': SystemPrompt,
      'team-test-tools': ToolRuntime,
      'team-test-agents': AgentRegistry,
      'team-test-persistence': JsonlSessionPersistence,
      'team-test-query': SessionQuerySqlite,
      'team-test-loop': AgentLoop,
      'team-test-subagents': SubagentRuntime,
      'team-test-spawn': SubagentSpawn,
      'team-test-fork': SubagentFork,
      'team-test-domain': TeamService,
      'team-test-model-tools': TeamTools,
      'team-test-model': {
        inject: ['llm'],
        apply(owner: Context) { owner.llm.registerAdapter(['mock'], adapter) },
      },
    })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    const handle = await ctx.agents.create({ sessionId: SessionId('lead'), agentOptions: { provider: 'mock', model: 'mock' } })
    return {
      ctx, root, adapter, lead: handle.agent,
      async dispose() {
        await ctx.fiber.dispose()
        if (adapter.requests.length > scriptedRequestLimit) throw new Error('Team fixture exhausted its model script')
        await rm(root, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    throw error
  }
}
