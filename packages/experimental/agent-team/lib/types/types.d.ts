/** Shared Team identities come from the supported domain; only Remote DTOs live here. */
import type { TeamMemberView, TeamTaskView } from '@deepseek-ai/dsh-agent-team/types';
export type * from '@deepseek-ai/dsh-agent-team/types';
export { TeamId, TeamMessageId, TeamTaskId } from '@deepseek-ai/dsh-agent-team';
/** Detached current roster and task board returned by the Remote view. */
export interface TeamView {
    readonly members: TeamMemberView[];
    readonly tasks: TeamTaskView[];
}
/** Keep stale task revisions distinct from other domain rejections. */
export type TeamTaskMutationResult = {
    readonly ok: true;
    readonly value: TeamTaskView;
} | {
    readonly ok: false;
    readonly error: {
        readonly code: 'team-task-conflict' | 'team-rejected';
        readonly message: string;
    };
};
//# sourceMappingURL=types.d.ts.map