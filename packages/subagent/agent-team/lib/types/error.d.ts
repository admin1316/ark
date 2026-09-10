import { HarnessError } from '@deepseek-ai/dsh-llm';
/** Failure raised by the Team domain. */
export declare class TeamError extends HarnessError {
    constructor(message: string, code: string, options?: ErrorOptions);
}
/**
 * Describe an arbitrary failure without replacing its original identity.
 * @param error - caught failure.
 * @returns a single-line description with bounded inspection depth.
 */
export declare function errorMessage(error: unknown): string;
//# sourceMappingURL=error.d.ts.map