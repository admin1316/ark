/** Real inbox and JSONL owners for ordinary prompt admission contracts. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { Inbox } from '@deepseek-ai/dsh-agent/src/inbox.ts'
import { onTestFinished } from 'vitest'

/**
 * Mount a real durability owner isolated to the current test.
 * @param ctx - the test's Session Store context, disposed before its files are removed.
 */
export async function installPromptPersistence(ctx: Context): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-prompt-contract-'))
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally { rmSync(root, { recursive: true, force: true }) }
  })
  await ctx.plugin(JsonlPersistence, { root, compression: 'none', packChunks: false })
}

/**
 * Build the production inbox without starting a provider loop.
 * @param session - exact Session receiving the durable splice.
 * @returns the real inbox; these tests observe persisted events instead of notifications.
 */
export function promptInbox(session: Session): Inbox {
  return new Inbox(session, { inserted() {}, discarded() {}, claimed() {} })
}
