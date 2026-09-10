/**
 * Model-facing knowledge-base tools over the knowledgeWiki service: the
 * agent in 对话 can search, read, and query the 万相织鉴 knowledge graph
 * natively — no MCP bridge, no desktop app. Tools register through the
 * harness tool system; every call resolves the knowledgeWiki service
 * lazily so the plugin loads even when the service is absent.
 * @module @deepseek-ai/dsh-tool-knowledge-wiki
 */
import type { Context } from '@deepseek-ai/cordis';
/** Stable Cordis plugin name. */
export declare const name = "tool-knowledge-wiki";
/** Required services: the tool registry and the prompt section owner. */
export declare const inject: string[];
/**
 * Register the knowledge-base tools.
 * @param ctx - plugin context.
 */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map