/** Reload-safe ownership for the ACP process-stdio byte transport. */
import type { Readable, Writable } from 'node:stream';
import { type Stream } from '@agentclientprotocol/sdk';
/** ACP message stream plus the synchronous Node-listener teardown it owns. */
export interface OwnedStdioStream {
    readonly stream: Stream;
    close(): void;
}
/**
 * Adapt process stdio while retaining every Node listener for synchronous detach on unload.
 * @param input - Node readable byte source owned for the lifetime of this adapter.
 * @param output - Node writable byte sink that remains open after adapter teardown.
 * @returns an ACP message stream and its idempotent input-listener cleanup.
 */
export declare function createOwnedStdioStream(input: Readable, output: Writable): OwnedStdioStream;
//# sourceMappingURL=stdio.d.ts.map