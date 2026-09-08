/**
 * The measurement service's positional surface fold: the per-node priced
 * surface `measure()` serves and compaction plans against. The projection
 * units deliberately do NOT share this fold — their state must stay O(1)
 * for the persisted checkpoint, so they ride `surface-projection.ts`'s
 * shadow-price protocol instead. Fully metered logs stay in agreement by
 * construction: both price through `estimate.ts`, and every logged shadow
 * price is derived from THIS fold's nodes by the replace producer. A
 * projection replacement without a claim deliberately folds with zero delta.
 *
 * @module @deepseek-ai/dsh-token-meter/surface-fold
 */
import type { SurfaceEvent } from '@deepseek-ai/dsh-session';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { TokenSurfaceNode } from './types.ts';
/** Internal node retaining image occurrences for provider-aware repricing. */
export interface MeterSurfaceNode {
    readonly seq: number;
    readonly heuristicTokens: number;
    readonly imageFreeTokens: number;
    readonly images: readonly ImageAttachmentRef[];
}
/** Read-only validated transition for a provider-aware surface. */
export interface SurfaceTokenPlan {
    readonly tokens: number;
    readonly deltaTokens: number;
    readonly node: MeterSurfaceNode;
    readonly target: 'append' | {
        readonly startIdx: number;
        readonly endIdx: number;
    };
}
/**
 * Validate and price one surface event without mutating the node array.
 * @param nodes - The nodes input.
 * @param event - The event input.
 * @returns The value produced by plan surface tokens.
 */
export declare function planSurfaceTokens(nodes: readonly MeterSurfaceNode[], event: SurfaceEvent): SurfaceTokenPlan;
/**
 * Commit a previously validated provider-aware surface plan.
 * @param nodes - The nodes input.
 * @param plan - The plan input.
 */
export declare function commitSurfaceTokens(nodes: MeterSurfaceNode[], plan: SurfaceTokenPlan): void;
/** A route-priced detached surface used by the meter and compaction readers. */
export interface PricedSurface {
    readonly nodes: TokenSurfaceNode[];
    readonly surfaceTokens: number;
}
/**
 * Price image occurrences with a provider's synchronous route calculator.
 * @param nodes - The nodes input.
 * @param pricing - The pricing input.
 * @returns The value produced by price surface.
 */
export declare function priceSurface(nodes: readonly MeterSurfaceNode[], pricing: import('@deepseek-ai/dsh-llm').LlmImageRequestPricing | undefined): PricedSurface;
/** One surface event's placement and cost against the surface preceding it. */
export interface SurfaceTokenFold {
    /** Heuristic price of the event's own message; 0 when it derives none. */
    readonly tokens: number;
    /** The surface after the event, detached from the input. */
    readonly nodes: TokenSurfaceNode[];
    /** Signed change in the surface total: `tokens` minus anything shadowed. */
    readonly deltaTokens: number;
}
/**
 * Fold one surface event onto a priced surface.
 *
 * Total and allocation-fresh: the caller assigns the result rather than
 * mutating in place, so a throw here leaves the caller's state untouched and
 * the same malformed event fails identically on every retry.
 * @param nodes - the priced surface preceding this event, in model-visible order.
 * @param event - the surface event to place.
 * @returns the event's price, the next surface, and the signed total delta.
 * @throws when a replacement names a range absent from `nodes` — committed
 *   logs are surface-validated at append time, so an unresolvable range is log
 *   corruption and must fail loud rather than skip the event.
 */
export declare function foldSurfaceTokens(nodes: readonly TokenSurfaceNode[], event: SurfaceEvent): SurfaceTokenFold;
//# sourceMappingURL=surface-fold.d.ts.map