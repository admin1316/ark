/** Reload-safe ownership for the ACP process-stdio byte transport. */
import { Buffer } from 'node:buffer';
import { ndJsonStream } from '@agentclientprotocol/sdk';
/**
 * Adapt process stdio while retaining every Node listener for synchronous detach on unload.
 * @param input - Node readable byte source owned for the lifetime of this adapter.
 * @param output - Node writable byte sink that remains open after adapter teardown.
 * @returns an ACP message stream and its idempotent input-listener cleanup.
 */
export function createOwnedStdioStream(input, output) {
    let controller;
    let inputClosed = false;
    const detachInput = () => {
        input.off('data', onData);
        input.off('end', onEnd);
        input.off('close', onEnd);
        input.off('error', onError);
    };
    const finishInput = (error) => {
        if (inputClosed)
            return;
        inputClosed = true;
        detachInput();
        input.pause();
        if (error === undefined)
            controller.close();
        else
            controller.error(error);
    };
    const onData = (chunk) => {
        controller.enqueue(typeof chunk === 'string' ? Buffer.from(chunk) : Uint8Array.from(chunk));
    };
    const onEnd = () => { finishInput(); };
    const onError = (error) => { finishInput(error); };
    const inputBytes = new ReadableStream({
        start(next) {
            controller = next;
            input.on('data', onData);
            input.once('end', onEnd);
            input.once('close', onEnd);
            input.once('error', onError);
            input.resume();
        },
    });
    const outputBytes = new WritableStream({
        write(chunk) {
            return new Promise((resolveWrite, rejectWrite) => {
                output.write(chunk, (error) => {
                    if (error === null || error === undefined)
                        resolveWrite();
                    else
                        rejectWrite(error);
                });
            });
        },
    });
    return {
        stream: ndJsonStream(outputBytes, inputBytes),
        close: () => { finishInput(); },
    };
}
//# sourceMappingURL=stdio.js.map