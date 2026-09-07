import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createOwnedStdioStream } from '../src/stdio.ts'

const message = { jsonrpc: '2.0' as const, method: 'test/message' }

describe('owned ACP stdio stream', () => {
  it.each([false, true])('decodes %s string-mode input and restores every listener', async (stringMode) => {
    const input = new PassThrough()
    if (stringMode) input.setEncoding('utf8')
    const output = new PassThrough()
    let outputText = ''
    output.setEncoding('utf8')
    output.on('data', (chunk: string) => { outputText += chunk })
    const inputEvents = ['data', 'end', 'close', 'error'] as const
    const baseline = new Map(inputEvents.map(event => [event, input.rawListeners(event)]))
    const owned = createOwnedStdioStream(input, output)
    const reader = owned.stream.readable.getReader()
    const writer = owned.stream.writable.getWriter()

    input.write(`${JSON.stringify(message)}\n`)
    await expect(reader.read()).resolves.toEqual({ value: message, done: false })
    await writer.write(message)
    expect(outputText).toBe(`${JSON.stringify(message)}\n`)

    owned.close()
    owned.close()
    await expect(reader.read()).resolves.toEqual({ value: undefined, done: true })
    reader.releaseLock()
    writer.releaseLock()
    for (const event of inputEvents) expect(input.rawListeners(event)).toEqual(baseline.get(event))
  })

  it('propagates an input error and detaches before a later close event', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const owned = createOwnedStdioStream(input, output)
    const reader = owned.stream.readable.getReader()
    const failure = new Error('input failed')
    input.emit('error', failure)
    await expect(reader.read()).rejects.toBe(failure)
    input.emit('close')
    owned.close()
    reader.releaseLock()
  })

  it('treats a Node close event as clean input completion', async () => {
    const input = new PassThrough()
    const owned = createOwnedStdioStream(input, new PassThrough())
    const reader = owned.stream.readable.getReader()
    input.emit('close')
    await expect(reader.read()).resolves.toEqual({ value: undefined, done: true })
    reader.releaseLock()
  })

  it('preserves output callback failures and accepts an explicit null success', async () => {
    const input = new PassThrough()
    const failure = new Error('output failed')
    const rejectedOutput = new Writable({
      write(_chunk, _encoding, callback) { callback(failure) },
    })
    rejectedOutput.on('error', () => {})
    const rejected = createOwnedStdioStream(input, rejectedOutput)
    const rejectedWriter = rejected.stream.writable.getWriter()
    await expect(rejectedWriter.write(message)).rejects.toBe(failure)
    rejected.close()
    rejectedWriter.releaseLock()

    const accepted = createOwnedStdioStream(new PassThrough(), new Writable({
      write(_chunk, _encoding, callback) { callback(null) },
    }))
    const acceptedWriter = accepted.stream.writable.getWriter()
    await expect(acceptedWriter.write(message)).resolves.toBeUndefined()
    accepted.close()
    acceptedWriter.releaseLock()
  })
})
