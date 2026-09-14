import { expect, it } from 'vitest'
import * as TeamTools from '../src/index.ts'
import { createTeamRuntime } from '../../agent-team/tests/runtime.ts'

it('rejects Team tools invoked without a calling Agent', async () => {
  const run = await createTeamRuntime([])
  try {
    const tool = run.ctx.tools.get('list_agents', run.lead)
    expect(tool).toBeDefined()
    await expect(tool!.execute({}, { agent: undefined } as never))
      .rejects.toThrow('list_agents requires a calling Agent')
  } finally { await run.dispose() }
})
