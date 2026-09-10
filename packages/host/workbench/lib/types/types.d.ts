/** Public request and result types for the Native Host Workbench Remote. */
/** Strict input to `workbench/webRead`. */
export interface WorkbenchWebReadRequest {
    readonly url: string;
}
/** One bounded, browser-free page rendered as native Markdown. */
export interface WorkbenchWebDocument {
    readonly url: string;
    readonly title: string;
    readonly statusCode: number;
    readonly markdown: string;
    readonly truncated: boolean;
}
/** Failures surfaced by the strict Workbench Remote. */
export type WorkbenchRemoteFailure = {
    readonly code: 'bad-request';
    readonly message: string;
    readonly details: {
        readonly issues: readonly unknown[];
    };
} | {
    readonly code: 'cancelled';
    readonly message: string;
    readonly details: Record<never, never>;
} | {
    readonly code: 'web-reader-error';
    readonly message: string;
    readonly details: {
        readonly url: string;
        readonly reason: string;
    };
};
//# sourceMappingURL=types.d.ts.map