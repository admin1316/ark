/** Run two real requests against the same Loader-owned agent and persistence. */
import { boot, installFailLoud } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('time-context fixture requires its config path')
const uninstall = installFailLoud('time-context-fixture')
const ctx = await boot('time-context-fixture', configPath)
try {
  await runFixtureTurn(ctx, { task: 'Sample the time for the first turn.' })
  await runFixtureTurn(ctx, { task: 'Sample the elapsed time for the next turn.' })
} finally {
  await ctx.fiber.dispose()
  uninstall()
}
