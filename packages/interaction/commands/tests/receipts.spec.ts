import { expect, it } from 'vitest'
import { Session, SessionId, SessionPromptInvocationId } from '@deepseek-ai/dsh-session'
import { CommandId, commandDigest, commandReceipt, foldCommandReceipts, type CommandReceipts } from '../src/index.ts'

it('retains settlement coordinates and refuses a repeated invocation instead of replacing its receipt', () => {
  const session = Session.create(SessionId('receipt-source'))
  const request = { sessionId: session.id, invocationId: SessionPromptInvocationId('__proto__'), line: '/record example', images: [] }
  const start = session.append('command/run', {
    commandId: CommandId('first'), name: 'record', source: { kind: 'user' },
    invocationId: request.invocationId, inputDigest: commandDigest(request),
  })
  const done = session.append('command/done', { commandId: start.data.commandId, kind: 'success', text: 'saved' })
  let state: CommandReceipts = { seedLength: 0, entries: {}, commandIds: {} }
  state = foldCommandReceipts(foldCommandReceipts(state, start), done)
  expect(commandReceipt(state, request.invocationId)).toMatchObject({ runSeq: 0, doneSeq: 1, conflict: false })
  const duplicate = session.append('command/run', { ...start.data, commandId: CommandId('second') })
  state = foldCommandReceipts(state, duplicate)
  expect(commandReceipt(state, request.invocationId)).toMatchObject({ commandId: 'first', runSeq: 0, doneSeq: 1, conflict: true })
})

it('does not adopt a parent seed identity into the fork receipt index', () => {
  const session = Session.create(SessionId('parent'))
  const event = session.append('command/run', { commandId: CommandId('seed-command'), name: 'record', source: { kind: 'user' }, invocationId: SessionPromptInvocationId('seed-input'), inputDigest: 'command-v1:' + 'a'.repeat(64) })
  const initial: CommandReceipts = { seedLength: 1, entries: {}, commandIds: {} }
  expect(foldCommandReceipts(initial, event)).toBe(initial)
})

it('rejects a corrupted command pairing shared by different invocation identities', () => {
  const session = Session.create(SessionId('duplicate-command-pairing'))
  const event = session.append('command/run', { commandId: CommandId('same-command'), name: 'record',
    source: { kind: 'user' }, invocationId: SessionPromptInvocationId('first-input'), inputDigest: 'command-v1:' + 'a'.repeat(64) })
  const state = foldCommandReceipts({ seedLength: 0, entries: {}, commandIds: {} }, event)
  const duplicate = session.append('command/run', { ...event.data, invocationId: SessionPromptInvocationId('another-input') })
  expect(() => foldCommandReceipts(state, duplicate)).toThrow('repeats commandId for another invocation')
})

it('rejects partial admission metadata and fingerprints images and exact command input', () => {
  const session = Session.create(SessionId('invalid'))
  const event = session.append('command/run', { commandId: CommandId('broken'), name: 'record', source: { kind: 'user' }, invocationId: SessionPromptInvocationId('missing-digest') })
  expect(() => foldCommandReceipts({ seedLength: 0, entries: {}, commandIds: {} }, event)).toThrow('invalid invocation metadata')
  const base = { sessionId: session.id, invocationId: SessionPromptInvocationId('input'), line: '/record value', images: [] }
  expect(commandDigest(base)).not.toBe(commandDigest({ ...base, line: '/record value ' }))
  expect(commandDigest(base)).not.toBe(commandDigest({ ...base, images: [{ type: 'image', mediaType: 'image/png', data: 'synthetic-only' }] }))
})
