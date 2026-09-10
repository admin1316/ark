/** Reload-safe ownership for the ACP process-stdio byte transport. */

import { Buffer } from 'node:buffer'
import type { Readable, Writable } from 'node:stream'
import { ndJsonStream, type Stream } from '@agentclientprotocol/sdk'

/** ACP message stream plus the synchronous Node-listener teardown it owns. */
export interface OwnedStdioStream {
  readonly stream: Stream
  close(): void
}

/**
 * Adapt process stdio while retaining every Node listener for synchronous detach on unload.
 * @param input - Node readable byte source owned for the lifetime of this adapter.
 * @param output - Node writable byte sink that remains open after adapter teardown.
 * @returns an ACP message stream and its idempotent input-listener cleanup.
 */
export function createOwnedStdioStream(input: Readable, output: Writable): OwnedStdioStream {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let inputClosed = false

  const detachInput = (): void => {
    input.off('data', onData)
    input.off('end', onEnd)
    input.off('close', onEnd)
    input.off('error', onError)
  }
  const finishInput = (error?: unknown): void => {
    if (inputClosed) return
    inputClosed = true
    detachInput()
    input.pause()
    if (error === undefined) controller.close()
    else controller.error(error)
  }
  const onData = (chunk: Buffer | string): void => {
    controller.enqueue(typeof chunk === 'string' ? Buffer.from(chunk) : Uint8Array.from(chunk))
  }
  const onEnd = (): void => { finishInput() }
  const onError = (error: Error): void => { finishInput(error) }

  const inputBytes = new ReadableStream<Uint8Array>({
    start(next) {
      controller = next
      input.on('data', onData)
      input.once('end', onEnd)
      input.once('close', onEnd)
      input.once('error', onError)
      input.resume()
    },
  })
  const outputBytes = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolveWrite, rejectWrite) => {
        output.write(chunk, (error: Error | null | undefined) => {
          if (error === null || error === undefined) resolveWrite()
          else rejectWrite(error)
        })
      })
    },
  })

  return {
    stream: ndJsonStream(outputBytes, inputBytes),
    close: () => { finishInput() },
  }
}
