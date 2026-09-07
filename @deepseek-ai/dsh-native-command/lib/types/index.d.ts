/**
 * Shared no-shell `execFile` runner for host-native OS integrations (the
 * native directory chooser, the open-with-default-application hand-off):
 * utf8 stdio capture, abort propagation, Windows console hide. A library,
 * not a plugin — no ctx, no state, no events.
 * @module @deepseek-ai/dsh-native-command
 */
/** Testable command boundary; native implementations never invoke a shell. */
export type NativeCommandRunner = (command: string, args: readonly string[], signal: AbortSignal) => Promise<{
    stdout: string;
    stderr: string;
}>;
/**
 * Run a host command with utf8 stdio, abort propagation, and Windows hide.
 * @param command - executable path or PATH name.
 * @param args - argv (never a shell string).
 * @param signal - caller/connection lifetime; abort terminates the child.
 * @returns captured stdout/stderr on exit 0.
 */
export declare const runNativeCommand: NativeCommandRunner;
/**
 * Hand one Host-resolved text document to the platform editor association.
 *
 * This intentionally accepts only an already-authorized filesystem target;
 * callers own path resolution and policy. The command runner receives the
 * original cancellation signal, and no platform branch ever invokes a shell.
 * @param path - absolute Host-owned text-document path.
 * @param signal - caller/connection lifetime; abort terminates the native command.
 */
export declare function openNativeTextDocument(path: string, signal: AbortSignal): Promise<void>;
//# sourceMappingURL=index.d.ts.map