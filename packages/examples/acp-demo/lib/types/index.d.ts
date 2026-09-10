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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import * as agentCore from '@deepseek-ai/dsh-agent-spine-demo';
import { type Config as ToolsConfig } from '@deepseek-ai/dsh-tools';
import { type JsonlCompression } from '@deepseek-ai/dsh-session-persistence-jsonl';
export declare const name = "acp-demo";
/**
 * App config: the swappable per-deployment values. `provider` and `model` configure
 * each agent the ACP bridge creates at `session/new`; `persona` is the
 * deployment persona (forwarded to the system-prompt plugin); `toolOrder` is
 * the explicit model-facing tool order (forwarded to the system-prompt plugin);
 * `tools` is the tool registry's config (its presentation `mode`, forwarded
 * through agent-spine-demo); `persistenceRoot` is the JSONL backend's directory.
 */
export interface Config {
    /** Provider route for ACP-created agents. */
    provider: string;
    /** Model name for ACP-created agents (must have a registered adapter). */
    model: string;
    /** Bundled agent-loop concurrency cap; `1` is serial and omission uses its default. */
    maxParallelToolCalls?: number;
    /** Deployment persona (the system-prompt plugin's `persona` config). */
    persona?: string;
    /** Explicit model-facing tool order (the system-prompt plugin's `toolOrder` config; see dsh-system-prompt). */
    toolOrder?: string[];
    /** Tool-registry config — its presentation `mode` (forwarded through agent-spine-demo; see dsh-tools). */
    tools?: ToolsConfig;
    /** DeepSeek Harness home directory exposed to bash and used for local skill discovery. */
    dshHome?: string;
    /** Fallback session-title limits forwarded through agent-spine-demo. */
    sessionTitle?: NonNullable<agentCore.Config['sessionTitle']>;
    /** Directory for JSONL sessions and the derived query index. Defaults to `./.sessions`. */
    persistenceRoot?: string;
    /** Write delta-chunk runs as packed storage rows (the JSONL backend's `packChunks`). Defaults to `true`. */
    packChunks?: boolean;
    /** JSONL artifact encoding; defaults to checksummed Zstandard frames. */
    persistenceCompression?: JsonlCompression;
    /** Controls automatic AGENTS.md/CLAUDE.md loading; configure a byte budget or set `false`. */
    workspaceContext: agentCore.Config['workspaceContext'];
    /** Skill registry, local-provider, and model-facing consumer config forwarded to agent-spine-demo. */
    skills?: agentCore.SkillConfig;
    /** Model-facing bash tool config forwarded through agent-core. */
    toolBash?: NonNullable<agentCore.Config['toolBash']>;
    /** Process-local background-job admission config forwarded through agent-core. */
    jobs?: NonNullable<agentCore.Config['jobs']>;
    /** Generic background-job controls forwarded through agent-core; set false to omit their tools. */
    toolJobs?: NonNullable<agentCore.Config['toolJobs']>;
    /** Persisted same-session goals; owner defaults enable them, or false disables the stack and tools. */
    goals?: agentCore.GoalConfig | false;
}
export declare const Config: z<Config>;
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
export declare function apply(ctx: Context, config: Config): Promise<void>;
//# sourceMappingURL=index.d.ts.map