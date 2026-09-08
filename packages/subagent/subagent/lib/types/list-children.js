/**
 * Read-only enumeration of durable subagent children and descendant trees
 * straight from the live session store and optional session persistence — no
 * query service. Candidates come from one live-preferred corpus; each child's
 * mode/label is folded from exactly one descriptor in the child's own suffix.
 * Listing and cold resume deliberately call the same strict fold; derived
 * projection caches cannot decide identity or hide duplicate descriptors.
 * Absent persistence, enumeration is live-only: a cold child is
 * unreachable for resume anyway, so its absence is capability absence, not an
 * error. The module owns no catalog state and does not consult Activation,
 * Agent-registry, continuation-manager, or provider state.
 *
 * @module @deepseek-ai/dsh-subagent
 */
import { foldSubagentDescriptor } from "./descriptor.js";
import { SubagentError } from "./error.js";
/**
 * Concurrent cold inspections per listing; a constant because it bounds one
 * read-only scan of local media, not deployment behavior. Should a networked
 * persistence backend appear, promote it to a validated `Config` field.
 */
const COLD_READ_CONCURRENCY = 4;
/**
 * Enumerate one parent's origin-classified direct children from the
 * live-preferred merge of `ctx.sessions` and optional session persistence,
 * serving each identity from the same strict own-suffix descriptor fold used
 * by cold resume. Cold rows require one bounded-concurrency persistence read.
 * @see SubagentRuntime.listChildren for the public cancellation and failure contract.
 * @param ctx - context carrying the session store, projection validation, and optional persistence.
 * @param parentSessionId - parent session whose direct children are listed.
 * @param signal - caller-owned cancellation observed around every persistence read.
 * @returns children and per-child diagnostics ordered by `createdAt`, then id.
 * @throws {@link SubagentError} when the session/projection services are not
 *   mounted, or the caller cancels the listing.
 */
export async function listChildren(ctx, parentSessionId, signal) {
    const listing = await prepareListing(ctx, signal);
    const candidates = [...listing.corpus.values()]
        .filter(record => record.header.parentSession === parentSessionId
        && record.header.origin === 'subagent')
        .sort(compareCorpusRecords);
    const rows = await resolveCandidateRows(candidates, listing, signal);
    return rows.filter((row) => row !== undefined);
}
/**
 * Enumerate every session-backed subagent below one root in stable pre-order.
 * Ordinary sessions and one-shot children remain traversal nodes, so a
 * continuable child below either is still discovered. Classification uses the
 * same descriptor authority as {@link listChildren}; no Agent is loaded or
 * resumed.
 * @see SubagentRuntime.listDescendants for the public cancellation and failure contract.
 * @param ctx - context carrying the session store, projection validation, and optional persistence.
 * @param rootSessionId - session whose complete descendant tree is listed.
 * @param signal - caller-owned cancellation observed around every persistence read.
 * @returns interpreted subagents with durable direct-parent and root-relative depth.
 * @throws {@link SubagentError} under the same conditions as {@link listChildren}.
 */
export async function listDescendants(ctx, rootSessionId, signal) {
    const listing = await prepareListing(ctx, signal);
    const positioned = descendantCandidates(listing.corpus, rootSessionId);
    const rows = await resolveCandidateRows(positioned.map(candidate => candidate.record), listing, signal);
    const entries = [];
    positioned.forEach((position, index) => {
        const row = rows[index];
        if (row !== undefined) {
            entries.push({ ...row, parentId: position.parentId, depth: position.depth });
        }
    });
    return entries;
}
/** Resolve listing services once and build one live-preferred session corpus. */
async function prepareListing(ctx, signal) {
    const projections = ctx.get('sessionProjections');
    if (projections === undefined) {
        throw new SubagentError('listing subagents requires the sessionProjections registry (load @deepseek-ai/dsh-session-projection)', 'SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE');
    }
    // Strict global read, never the `ctx.sessions` property proxy: the proxy is
    // caller-scope bound, so a consumer plugin without its own `sessions`
    // injection (the model-facing tool or a Host Remote handler) would throw on access.
    const sessions = ctx.get('sessions');
    if (sessions === undefined) {
        throw new SubagentError('listing subagents requires the session store (load @deepseek-ai/dsh-session)', 'SUBAGENT_CONTROL_SESSION_STORE_UNAVAILABLE');
    }
    assertListingNotCancelled(signal);
    const persistence = ctx.get('sessionPersistence');
    let persistedHeaders = [];
    if (persistence !== undefined) {
        try {
            persistedHeaders = await persistence.list(signal);
        }
        catch (error) {
            // The backend may reject with its own abort failure after observing the
            // forwarded signal; cancellation stays a stable subagent failure.
            assertListingNotCancelled(signal);
            throw error;
        }
        assertListingNotCancelled(signal);
    }
    // Live-preferred merge without header reconciliation: a live record wins
    // its id wholesale, exactly as a live-preferred corpus would serve it.
    const corpus = new Map();
    for (const header of persistedHeaders)
        corpus.set(header.id, { header, live: undefined });
    for (const session of sessions.list()) {
        corpus.set(session.header.id, { header: session.header, live: session });
    }
    const subagentParents = new Set();
    for (const record of corpus.values()) {
        if (record.header.origin === 'subagent' && record.header.parentSession !== undefined) {
            subagentParents.add(record.header.parentSession);
        }
    }
    return { projections, persistence, corpus, subagentParents };
}
/** Resolve strict own-suffix rows for aligned candidates with bounded cold reads. */
async function resolveCandidateRows(candidates, listing, signal) {
    const { projections, persistence, subagentParents } = listing;
    const rows = Array.from({ length: candidates.length });
    const coldReads = [];
    candidates.forEach((candidate, index) => {
        const childId = candidate.header.id;
        if (candidate.live === undefined) {
            coldReads.push({ index, header: candidate.header });
            return;
        }
        // A live child without an identity yet is the unpublished creation window.
        let identity;
        try {
            // Keep foreign projection/schema corruption contained as before, but do
            // not use its derived identity as the descriptor authority.
            projections.snapshot(candidate.live);
            identity = foldOwnDescriptor(candidate.live.header, candidate.live.events);
        }
        catch {
            // Malformed, unsupported, or duplicate own descriptors are deterministic
            // damage in this child and cannot poison sibling rows.
            rows[index] = { kind: 'diagnostic', id: childId, reason: 'corrupt' };
            return;
        }
        if (identity === undefined)
            return;
        rows[index] = childRow(childId, identity, 'running', subagentParents.has(childId));
    });
    // Cold candidates exist only when persistence listed them, so the narrow
    // re-check is about types, not reachability.
    if (persistence !== undefined && coldReads.length > 0) {
        const queue = [...coldReads];
        await Promise.all(Array.from({ length: Math.min(COLD_READ_CONCURRENCY, queue.length) }, async () => {
            for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
                rows[job.index] = await resolveColdIdentity(persistence, projections, job.header, subagentParents.has(job.header.id), signal);
            }
        }));
    }
    assertListingNotCancelled(signal);
    return rows;
}
/** Build origin-classified candidates from the complete tree without recursion. */
function descendantCandidates(corpus, rootSessionId) {
    const children = new Map();
    for (const record of corpus.values()) {
        const parentId = record.header.parentSession;
        if (parentId === undefined)
            continue;
        const siblings = children.get(parentId);
        if (siblings === undefined)
            children.set(parentId, [record]);
        else
            siblings.push(record);
    }
    for (const siblings of children.values())
        siblings.sort(compareCorpusRecords);
    const positioned = [];
    const stack = (children.get(rootSessionId) ?? [])
        .map(record => ({ record, parentId: rootSessionId, depth: 1 }))
        .reverse();
    const visited = new Set([rootSessionId]);
    while (stack.length > 0) {
        // The length guard proves one frame exists.
        // oxlint-disable-next-line typescript/no-non-null-assertion
        const position = stack.pop();
        const id = position.record.header.id;
        if (visited.has(id))
            continue;
        visited.add(id);
        if (position.record.header.origin === 'subagent')
            positioned.push(position);
        const descendants = children.get(id) ?? [];
        for (const record of [...descendants].reverse()) {
            stack.push({ record, parentId: id, depth: position.depth + 1 });
        }
    }
    return positioned;
}
/** Compare siblings by durable creation time, then id. */
function compareCorpusRecords(a, b) {
    return a.header.createdAt - b.header.createdAt || a.header.id.localeCompare(b.header.id);
}
/**
 * Resolve one cold candidate through one persistence inspection and the same
 * strict own-suffix fold used by cold resume. A failed inspection is one transient `unavailable` row
 * retried on the next listing; an inspection naming another lifecycle, and a
 * settled log the fold cannot identify — or that makes any registered unit
 * throw — are final, so they report `corrupt`.
 */
async function resolveColdIdentity(persistence, projections, header, hasChildren, signal) {
    const childId = header.id;
    assertListingNotCancelled(signal);
    let inspected;
    try {
        inspected = await persistence.inspect(childId, signal);
    }
    catch {
        // Per-child isolation: the child vanished or its backend read failed —
        // one diagnostic row, and the listing itself still succeeds.
        assertListingNotCancelled(signal);
        return { kind: 'diagnostic', id: childId, reason: 'unavailable' };
    }
    assertListingNotCancelled(signal);
    // A session id names a slot, not a lifecycle: a child deleted and
    // re-published under another owner between the enumeration and this read
    // must not leak into the old parent's listing.
    if (!sameLifecycle(inspected.meta, header)) {
        return { kind: 'diagnostic', id: childId, reason: 'corrupt' };
    }
    let identity;
    try {
        projections.restore({}, inspected.events, 0);
        identity = foldOwnDescriptor(inspected.meta, inspected.events);
    }
    catch {
        // Deterministic own-descriptor damage is contained to this child.
        return { kind: 'diagnostic', id: childId, reason: 'corrupt' };
    }
    if (identity === undefined) {
        return { kind: 'diagnostic', id: childId, reason: 'corrupt' };
    }
    return childRow(childId, identity, 'inactive', hasChildren);
}
/** Fold only events authored by this child, excluding any inherited fork prefix. */
function foldOwnDescriptor(header, events) {
    return foldSubagentDescriptor(events.slice(header.seedLength ?? 0));
}
/** Materialize one served identity as its child row. */
function childRow(id, identity, activity, hasChildren) {
    return identity.mode === 'one-shot'
        ? {
            kind: 'child',
            id,
            mode: 'one-shot',
            ...identity.label !== undefined ? { label: identity.label } : {},
            activity,
            hasChildren,
        }
        : {
            kind: 'child',
            id,
            mode: 'continuable',
            label: identity.label,
            activity,
            hasChildren,
        };
}
/** Immutable header fields that distinguish one session lifecycle from another under the same id. */
const LIFECYCLE_WITNESS_KEYS = [
    'version', 'id', 'createdAt', 'cwd', 'parentSession', 'seedLength', 'delegationDepth',
];
/** Whether an inspected log still belongs to the enumerated lifecycle. */
function sameLifecycle(meta, expected) {
    return LIFECYCLE_WITNESS_KEYS.every(key => meta[key] === expected[key]);
}
/** Stop a listing at its next cancellation checkpoint. */
function assertListingNotCancelled(signal) {
    if (signal?.aborted) {
        throw new SubagentError('subagent listing was cancelled', 'CANCELLED');
    }
}
//# sourceMappingURL=list-children.js.map