/** Host-only command receipt projection over existing command lifecycle records. */
import type { Context } from '@deepseek-ai/cordis'
import { CommandId, foldCommandReceipts, type CommandReceipts } from '@deepseek-ai/dsh-commands'
import { z } from 'zod'

/**
 * Register the incremental receipt index without exposing private command input to clients.
 * @param ctx - Context with the shared projection registry.
 */
export function installCommandReceipts(ctx: Context): void {
  ctx.sessionProjections.register({
    key: 'commandReceipts',
    stateSchema: z.object({
      seedLength: z.number().int().nonnegative(),
      commandIds: z.record(z.string(), z.string()),
      entries: z.record(z.string(), z.object({
        commandId: z.string().min(1).transform(CommandId),
        digest: z.string().regex(/^command-v1:[a-f0-9]{64}$/u), runSeq: z.number().int().nonnegative(),
        doneSeq: z.number().int().nonnegative().nullable(), conflict: z.boolean(),
      })),
    }) satisfies z.ZodType<CommandReceipts>,
    init: header => ({ seedLength: header.seedLength ?? 0, entries: {}, commandIds: {} }),
    apply: foldCommandReceipts,
    stateVersion: 1,
  })
}
