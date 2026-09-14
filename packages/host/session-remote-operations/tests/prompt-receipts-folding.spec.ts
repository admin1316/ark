/** Incremental receipt folding contracts of the prompt-receipts projection. */
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionPromptInvocationId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { afterEach, expect, it } from 'vitest'
import { installPromptReceipts } from '../src/prompt-receipts.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const owner = ctx.plugin({ inject: ['sessionProjections'], apply: installPromptReceipts })
  await owner
  const session = ctx.sessions.create(SessionId('receipt-folding'), { meta: { cwd: '/workspace' } })
  const receipts = () => ctx.sessionProjections.stateOf(session, 'promptReceipts')
  return { ctx, session, receipts }
}

function remoteUser(invocationId: SessionPromptInvocationId, digest?: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: 'synthetic ordinary request' }],
    // The stored source keeps the canonical 'user' kind and carries the caller's
    // invocation identity plus an optional versioned prompt digest.
    source: {
      kind: 'user',
      invocationId,
      ...digest === undefined ? {} : { promptDigest: digest },
    },
  })
}

it('keeps the first accepted receipt and marks a changed re-admission as a conflict', async () => {
  const { session, receipts } = await fixture()
  const invocationId = SessionPromptInvocationId('folding-invocation')
  const first = session.append('user/message', remoteUser(invocationId, 'v1:first'), { surfaceOp: 'append' })
  expect(receipts()?.entries[invocationId]).toEqual({
    messageId: first.data.id, seq: first.seq, digest: 'v1:first', conflict: false,
  })
  const changed = remoteUser(invocationId, 'v1:changed')
  const second = session.append('user/message', changed, { surfaceOp: 'append' })
  expect(second.data.id).not.toBe(first.data.id)
  expect(receipts()?.entries[invocationId]).toEqual({
    messageId: first.data.id, seq: first.seq, digest: 'v1:first', conflict: true,
  })
  session.append('user/message', remoteUser(invocationId, 'v1:again'), { surfaceOp: 'append' })
  expect(receipts()?.entries[invocationId]).toEqual({
    messageId: first.data.id, seq: first.seq, digest: 'v1:first', conflict: true,
  })
})

it('folds every inserted message of one splice, including an undigested identity', async () => {
  const { session, receipts } = await fixture()
  const undigested = SessionPromptInvocationId('folding-undigested')
  const digested = SessionPromptInvocationId('folding-digested')
  const first = remoteUser(undigested)
  const second = remoteUser(digested, 'v1:digested')
  const splice = session.append('agent/inbox/spliced', {
    target: 'next-turn', start: 0, inserted: [first, second],
  })
  expect(receipts()?.entries[undigested]).toEqual({
    messageId: first.id, seq: splice.seq, digest: null, conflict: false,
  })
  expect(receipts()?.entries[digested]).toEqual({
    messageId: second.id, seq: splice.seq, digest: 'v1:digested', conflict: false,
  })
})

it('folds a splice whose conflicting re-admission follows a new entry', async () => {
  const { session, receipts } = await fixture()
  const accepted = SessionPromptInvocationId('folding-splice2-accepted')
  session.append('user/message', remoteUser(accepted, 'v1:origin'), { surfaceOp: 'append' })
  const newcomer = SessionPromptInvocationId('folding-splice2-new')
  session.append('agent/inbox/spliced', {
    target: 'next-turn', start: 0,
    inserted: [remoteUser(newcomer, 'v1:new'), remoteUser(accepted, 'v1:changed')],
  })
  expect(receipts()?.entries[newcomer]).toMatchObject({ digest: 'v1:new', conflict: false })
  expect(receipts()?.entries[accepted]).toMatchObject({ conflict: true, digest: 'v1:origin' })
})
