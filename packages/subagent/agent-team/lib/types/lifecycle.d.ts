/** Owns the cancellation fact shared by all Team runtime operations. */
export declare class TeamRuntimeLifecycle {
    private readonly disposalTimeoutMs;
    private readonly controller;
    private disposalDeadline;
    constructor(disposalTimeoutMs: number);
    /** Cancellation shared by all admitted runtime operations. */
    get signal(): AbortSignal;
    /** Whether shutdown has closed admission, independently of completed cleanup. */
    get disposed(): boolean;
    /** Original cancellation reason used to distinguish shutdown from unexpected failure. */
    get reason(): unknown;
    private isCancellation;
    /** Close admission and cancel interruptible work. */
    close(): void;
    /**
     * Await admitted operations and retain failures other than runtime cancellation.
     * @param operations - operations captured after admission closes.
     * @param failures - destination for unexpected rejections or timeouts.
     */
    settle(operations: readonly Promise<unknown>[], failures: unknown[]): Promise<void>;
    /**
     * Bound one shutdown operation.
     * @param operation - settlement that might otherwise wait indefinitely.
     * @returns the operation's result.
     */
    withTimeout<T>(operation: Promise<T>): Promise<T>;
}
//# sourceMappingURL=lifecycle.d.ts.map