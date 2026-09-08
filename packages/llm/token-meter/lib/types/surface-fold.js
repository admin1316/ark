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
import { deriveEventMessage } from '@deepseek-ai/dsh-session';
import { estimateContent, estimateMessage, estimateStructuralBlock } from "./estimate.js";
function collectImages(blocks, images) {
    let structural = 0;
    for (const block of blocks) {
        if (block.type === 'image') {
            images.push(block.attachment);
            structural += estimateStructuralBlock(block);
        }
        else if (block.type === 'tool-result') {
            structural += collectImages(block.content, images);
        }
    }
    return structural;
}
function analyzeNode(seq, message) {
    if (message === null)
        return { seq, heuristicTokens: 0, imageFreeTokens: 0, images: [] };
    const heuristicTokens = estimateMessage(message);
    const images = [];
    return {
        seq,
        heuristicTokens,
        imageFreeTokens: heuristicTokens - collectImages(message.content, images),
        images,
    };
}
/**
 * Validate and price one surface event without mutating the node array.
 * @param nodes - The nodes input.
 * @param event - The event input.
 * @returns The value produced by plan surface tokens.
 */
export function planSurfaceTokens(nodes, event) {
    const node = analyzeNode(event.seq, deriveEventMessage(event));
    const operation = event.surfaceOp;
    if (isAppendSurfaceOperation(operation)) {
        return { tokens: node.heuristicTokens, deltaTokens: node.heuristicTokens, node, target: 'append' };
    }
    const startIdx = nodes.findIndex(candidate => candidate.seq === operation.start);
    const endIdx = nodes.findIndex(candidate => candidate.seq === operation.end);
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
        throw new Error(`token surface: replace at seq ${event.seq} has invalid current range ${operation.start}-${operation.end}`);
    }
    const removed = nodes.slice(startIdx, endIdx + 1)
        .reduce((total, candidate) => total + candidate.heuristicTokens, 0);
    return {
        tokens: node.heuristicTokens,
        deltaTokens: node.heuristicTokens - removed,
        node,
        target: { startIdx, endIdx },
    };
}
/**
 * Commit a previously validated provider-aware surface plan.
 * @param nodes - The nodes input.
 * @param plan - The plan input.
 */
export function commitSurfaceTokens(nodes, plan) {
    if (plan.target === 'append')
        nodes.push(plan.node);
    else
        nodes.splice(plan.target.startIdx, plan.target.endIdx - plan.target.startIdx + 1, plan.node);
}
/**
 * Price image occurrences with a provider's synchronous route calculator.
 * @param nodes - The nodes input.
 * @param pricing - The pricing input.
 * @returns The value produced by price surface.
 */
export function priceSurface(nodes, pricing) {
    const images = pricing === undefined ? [] : nodes.flatMap(node => node.images);
    if (pricing === undefined || images.length === 0) {
        let total = 0;
        const result = nodes.map((node) => {
            total += node.heuristicTokens;
            return { seq: node.seq, tokens: node.heuristicTokens };
        });
        return { nodes: result, surfaceTokens: total };
    }
    const prices = pricing.priceImages(images);
    if (prices.length !== images.length) {
        throw new Error(`token meter: route image pricing answered ${prices.length} prices for ${images.length} occurrences`);
    }
    let cursor = 0;
    let total = 0;
    const result = nodes.map((node) => {
        let tokens = node.heuristicTokens;
        if (node.images.length > 0) {
            tokens = node.imageFreeTokens;
            for (let index = 0; index < node.images.length; index += 1) {
                const price = prices[cursor];
                if (price === undefined) {
                    throw new Error('token meter: route image pricing ended before every occurrence was consumed');
                }
                cursor += 1;
                tokens += price.visualTokens + estimateContent([{ type: 'text', text: price.text }]);
            }
        }
        total += tokens;
        return { seq: node.seq, tokens };
    });
    return { nodes: result, surfaceTokens: total };
}
/** Treat old persisted events without a surface operation as append-only. */
function isAppendSurfaceOperation(operation) {
    return operation === undefined || operation === 'append';
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
export function foldSurfaceTokens(nodes, event) {
    const message = deriveEventMessage(event);
    const tokens = message === null ? 0 : estimateMessage(message);
    const op = event.surfaceOp;
    if (op === 'append') {
        return { tokens, nodes: [...nodes, { seq: event.seq, tokens }], deltaTokens: tokens };
    }
    const startIdx = nodes.findIndex(node => node.seq === op.start);
    const endIdx = nodes.findIndex(node => node.seq === op.end);
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
        throw new Error(`token surface: replace at seq ${event.seq} has invalid current range ${op.start}-${op.end}`);
    }
    const removed = nodes
        .slice(startIdx, endIdx + 1)
        .reduce((total, node) => total + node.tokens, 0);
    const next = [...nodes];
    next.splice(startIdx, endIdx - startIdx + 1, { seq: event.seq, tokens });
    return { tokens, nodes: next, deltaTokens: tokens - removed };
}
//# sourceMappingURL=surface-fold.js.map