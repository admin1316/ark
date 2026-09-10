/** Stable Team errors and bounded diagnostics. */
import { inspect } from 'node:util';
import { HarnessError } from '@deepseek-ai/dsh-llm';
/** Failure raised by the Team domain. */
export class TeamError extends HarnessError {
    constructor(message, code, options) {
        super(message, code, options);
        this.name = 'TeamError';
    }
}
/**
 * Describe an arbitrary failure without replacing its original identity.
 * @param error - caught failure.
 * @returns a single-line description with bounded inspection depth.
 */
export function errorMessage(error) {
    if (error instanceof Error)
        return error.message;
    if (typeof error === 'string')
        return error;
    return inspect(error, { breakLength: Infinity, compact: true, depth: 4 });
}
//# sourceMappingURL=error.js.map