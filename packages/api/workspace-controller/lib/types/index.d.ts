/** Workspace follow Remote owner and directory-picker composition. */
import { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { WorkspaceFollowFrame } from './types.ts';
export type * from './types.ts';
export { DirectoryPickerController } from './directory-picker.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Host Workspace follow API and directory-picker composition. */
        workspaceController: WorkspaceController;
    }
}
/** Host service backing the generated `ctx.remote.workspace` namespace. */
export declare class WorkspaceController extends TypertRemoteService {
    static inject: string[];
    private readonly feed;
    /** @param ctx - Host context containing the Workspace registry. */
    constructor(ctx: Context);
    /**
     * Stream a complete Workspace baseline followed by ordered increments.
     * @param signal - generation cancellation.
     * @returns baseline followed by ordered Workspace increments.
     */
    follow(signal: AbortSignal): AsyncIterable<WorkspaceFollowFrame>;
}
export default WorkspaceController;
//# sourceMappingURL=index.d.ts.map