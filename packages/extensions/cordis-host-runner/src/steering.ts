/** Model steering for post-activation Host guard failures. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CordisErrorDetails } from './types.ts'
import type { DynamicCordisPlugin, DynamicCordisRun } from './registry.ts'

/** Agent lookup surface supplied by the root runtime. */
export type AgentsService = { get(id: string): Agent | undefined } | undefined

/**
 * Render one failure's message and optional stack.
 * @param failure - The failure input.
 * @returns The value produced by format error details.
 */
export function formatErrorDetails(failure: CordisErrorDetails): string {
  return `message: ${failure.message}`
    + (failure.stack === undefined ? '' : `\nstack:\n${failure.stack}`)
}

/**
 * Steer the owner after a Host guard rejects runtime code.
 * @param agents - The agents input.
 * @param plugin - The plugin input.
 * @param run - The run input.
 * @param failure - The failure input.
 */
export function steerGuardFailure(
  agents: AgentsService,
  plugin: DynamicCordisPlugin,
  run: DynamicCordisRun,
  failure: CordisErrorDetails,
): void {
  const agent = agents?.get(plugin.sessionId)
  if (agent === undefined) return
  agent.steer(createUserMessage({
    content: [{
      type: 'text',
      text: `Cordis Host guard rejected runtime code in ${plugin.pluginId}/${run.packageId} `
        + `(${run.pluginRunId}) after activation.\n${formatErrorDetails(failure)}\n`
        + 'The Plugin remains running. Inspect it, define a corrected Package on the same Plugin, and '
        + 'activate the new Package with cordis_run mode:"update".',
    }],
    source: { kind: 'plugin', plugin: 'cordis-host-runner' },
  }))
}
