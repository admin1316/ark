/** Hard-deadline execution contract for non-cooperative Knowledge Wiki stages. */
/**
 * Recognize the declared stage-executor capability without executing it.
 * @param value - Optional service value to inspect.
 * @returns True for an owned-worker-v1/owned-subprocess-v1 marker and callable execute member.
 * This structural check does not prove that abort actually terminates the isolate.
 */
export function isKnowledgeWikiStageExecutor(value) {
    return typeof value === 'object'
        && value !== null
        && (Reflect.get(value, 'isolation') === 'owned-worker-v1'
            || Reflect.get(value, 'isolation') === 'owned-subprocess-v1')
        && typeof Reflect.get(value, 'execute') === 'function';
}
/**
 * Enforce the deadline even when an injected executor never settles.
 * Timeout/owner cancellation aborts the child signal and rejects without awaiting isolate termination.
 * @param executor - Parent-owned executor responsible for terminating its isolate on abort; absence rejects.
 * @param request - Stage input with a finite, positive timeoutMs deadline.
 * @param ownerSignal - Parent cancellation forwarded to the stage's dedicated controller.
 * @returns Stage result if it settles before cancellation/deadline; otherwise rejects and ignores late settlement.
 * @throws Rejects for unavailable execution, invalid deadlines, cancellation, timeout, or executor failure.
 */
export function executeKnowledgeWikiStage(executor, request, ownerSignal) {
    if (executor === undefined) {
        return Promise.reject(new Error('knowledge Wiki stage executor unavailable; refusing non-cooperative work'));
    }
    if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
        return Promise.reject(new Error('invalid knowledge Wiki stage deadline'));
    }
    if (ownerSignal.aborted) {
        return Promise.reject(ownerSignal.reason instanceof Error
            ? ownerSignal.reason
            : new Error('knowledge Wiki stage aborted'));
    }
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
        let settled = false;
        function finish(operation) {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            ownerSignal.removeEventListener('abort', abortFromOwner);
            operation();
        }
        const abortFromOwner = () => {
            controller.abort(ownerSignal.reason);
            finish(() => {
                reject(ownerSignal.reason instanceof Error ? ownerSignal.reason : new Error('knowledge Wiki stage aborted'));
            });
        };
        ownerSignal.addEventListener('abort', abortFromOwner, { once: true });
        const timeout = setTimeout(() => {
            const error = new Error(`knowledge Wiki ${request.kind} timed out after ${request.timeoutMs}ms`);
            controller.abort(error);
            finish(() => { reject(error); });
        }, request.timeoutMs);
        void executor.execute(request, controller.signal).then((value) => { finish(() => { resolve(value); }); }, (error) => {
            finish(() => {
                reject(error instanceof Error ? error : new Error(String(error)));
            });
        });
    });
}
//# sourceMappingURL=stage-executor.js.map