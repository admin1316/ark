/**
 * The ACP automation server app: the default agent spine
 * ({@link @deepseek-ai/dsh-agent-spine-demo}), JSONL session persistence, and
 * the {@link @deepseek-ai/dsh-acp} bridge. The app owns those plugins through one
 * ordered lifecycle so ACP sessions quiesce before persistence detaches. It
 * writes nothing to stdout.
 * It pre-creates no agents and leaves adapters, executors, and optional tools to
 * the leaf, which must likewise avoid stdout loggers. Named exports are
 * required so Loader retains this plugin's `Config` schema (see
 * docs/postmortem/0001).
 * @module @deepseek-ai/dsh-acp-demo
 */
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import * as acp from '@deepseek-ai/dsh-acp';
import * as agentCore from '@deepseek-ai/dsh-agent-spine-demo';
import * as workspaceContext from '@deepseek-ai/dsh-agent-instructions';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import JsonlSessionPersistence, { JsonlCompressionSchema, } from '@deepseek-ai/dsh-session-persistence-jsonl';
import * as sessionCheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy';
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite';
export const name = 'acp-demo';
const DEFAULT_PERSISTENCE_ROOT = './.sessions';
// Each entry point owns a complete, directly readable config schema; extracting
// the common fields would make two small app contracts depend on a new facade.
/* jscpd:ignore-start */
export const Config = z.object({
    provider: z.string().required(),
    model: z.string().required(),
    maxParallelToolCalls: z.number().step(1).min(1),
    persona: z.string(),
    // The array default is forced to undefined: ABSENT means "lexicographic
    // order" (the owning dsh-system-prompt schema does the same), while
    // schemastery's native [] default would read as an invalid configured list.
    toolOrder: z.array(z.string()).default(undefined),
    tools: ToolRuntime.Config,
    dshHome: z.string(),
    sessionTitle: agentCore.SessionTitleConfigSchema,
    persistenceRoot: z.string().default(DEFAULT_PERSISTENCE_ROOT),
    packChunks: z.boolean().default(true),
    persistenceCompression: JsonlCompressionSchema,
    workspaceContext: z.union([z.const(false), workspaceContext.Config]).required(),
    skills: agentCore.SkillConfigSchema,
    toolBash: agentCore.ToolBashConfigSchema,
    jobs: agentCore.JobsConfigSchema,
    toolJobs: z.union([z.const(false), agentCore.ToolJobsConfigSchema]),
    goals: z.union([z.const(false), agentCore.GoalConfigSchema]),
});
/* jscpd:ignore-end */
/**
 * Compose the spine with the ACP automation transport. The agent-spine-demo bundle pre-creates
 * NO agents (its `agents` list defaults to `[]`) and carries the deployment
 * `persona`; the JSONL backend and derived query index persist under
 * `persistenceRoot`; the ACP bridge owns stdout for JSON-RPC and creates one
 * agent per `session/new` from the provider/model pair. The composite effect
 * unloads in reverse order, keeping checkpoint and persistence listeners
 * attached until ACP agents have flushed their closing events. No logger, no
 * `hmr` — stdout stays pure.
 */
export async function apply(ctx, config) {
    const goals = config.goals ?? {};
    const persistenceRoot = config.persistenceRoot ?? DEFAULT_PERSISTENCE_ROOT;
    await ctx.effect(async function* () {
        const spine = ctx.plugin(agentCore, { ...agentCore.pickSpineConfig(config), goals });
        await spine;
        yield spine.dispose;
        // Same rationale as the Config schema above: each entry point forwards its own
        // persistence passthroughs rather than sharing a facade with stdio-demo.
        /* jscpd:ignore-start */
        const persistence = ctx.plugin(JsonlSessionPersistence, {
            root: persistenceRoot,
            ...config.packChunks !== undefined ? { packChunks: config.packChunks } : {},
            ...(config.persistenceCompression === undefined ? {} : { compression: config.persistenceCompression }),
        });
        await persistence;
        yield persistence.dispose;
        /* jscpd:ignore-end */
        const checkpoint = ctx.plugin(sessionCheckpointPolicy);
        await checkpoint;
        yield checkpoint.dispose;
        const query = ctx.plugin(SqliteSessionQueryEngine, { path: join(persistenceRoot, 'session-query.db') });
        await query;
        yield query.dispose;
        const transport = ctx.plugin(acp, { provider: config.provider, model: config.model });
        await transport;
        yield transport.dispose;
    }, 'acp-demo.composition');
}
//# sourceMappingURL=index.js.map