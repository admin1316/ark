import { applyTeamEvent, foldTeam, isTeamEvent } from "./fold.js";
const PACKAGE_NAME = '@deepseek-ai/dsh-agent-team';
export const name = 'team-invariant';
export const inject = ['invariants'];
const install = Object.assign((ctx, fail) => {
    ctx.on('internal/dispatch', (_mode, eventName, args) => {
        if (eventName !== 'session/event')
            return;
        const [session, event] = args;
        if (!isTeamEvent(event))
            return;
        try {
            applyTeamEvent(foldTeam(session.id, session.events), event);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            fail(`session event ${event.seq} violates the Agent Teams stream: ${message}`);
        }
    }, { global: true });
}, { inject: ['sessions'] });
/**
 * Register Team event invariants.
 * @param ctx - invariant registry owner.
 * @returns registration disposer after installation.
 */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//# sourceMappingURL=invariant.js.map