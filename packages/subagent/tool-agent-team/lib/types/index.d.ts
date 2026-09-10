/** Agent-scoped model tools over the Team service. */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Cordis plugin name. */
export declare const name = "tool-agent-team";
/** Services required by Team tools. */
export declare const inject: string[];
/** Continuable provider routes used for new teammates. */
export interface Config {
    readonly freshProvider?: string;
    readonly forkProvider?: string;
}
/** Validated defaults for teammate creation. */
export declare const Config: z<Config>;
/**
 * Install the Team tool set in exact live member scopes.
 * @param ctx - owning composition context.
 * @param config - continuable provider routes.
 */
export declare function apply(ctx: Context, config?: Config): void;
//# sourceMappingURL=index.d.ts.map