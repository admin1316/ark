/** Domain-owned Typert Remote service for the Native Ark Workbench. */
import type { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { WorkbenchWebDocument, WorkbenchWebReadRequest } from './types.ts';
export type * from './types.ts';
/** Native Workbench Remote owner for the browser-free Host Web reader. */
export declare class WorkbenchRemoteService extends TypertRemoteService {
    static inject: string[];
    constructor(ctx: Context);
    /**
     * Fetch one public HTTP(S) page through the existing SSRF-safe Host provider
     * and convert it to bounded Markdown for the Native Workbench reader.
     * @param request - strict request containing the public HTTP(S) URL.
     * @param signal - caller cancellation propagated through WebFetch.
     * @returns the bounded body-only Markdown document and structured fetch facts.
     */
    webRead(request: WorkbenchWebReadRequest, signal: AbortSignal): Promise<WorkbenchWebDocument>;
}
export default WorkbenchRemoteService;
//# sourceMappingURL=index.d.ts.map