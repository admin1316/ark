/**
 * Direct-call cancellation result; the Remote carrier independently preserves cancellation too.
 * @returns The value produced by workspace remote cancelled.
 */
export function workspaceRemoteCancelled() {
    return { ok: false, error: { code: 'cancelled', message: 'workspace Remote invocation was cancelled', details: {} } };
}
//# sourceMappingURL=remote.js.map