/**
 * Local concept-graph engine for the 万相织鉴 knowledge base.
 *
 * Reads the wiki page tree (project/wiki/**\/*.md), parses frontmatter and
 * [[wikilink]]s, builds the node/edge graph, and runs Louvain community
 * detection — all in-process, with no dependency on the LLM Wiki app.
 * @module @deepseek-ai/dsh-knowledge-wiki/graph
 */
import { lstatSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseFrontmatterArray, parseFrontmatterBlock, parseFrontmatterField } from "./frontmatter-utils.js";
import { isMissingPathError, MAX_WIKI_PAGE_BYTES, readRegularFileBounded } from "./filesystem.js";
/** Parse frontmatter fields and body through the shared block owner. */
function parsePageContent(raw) {
    const block = parseFrontmatterBlock(raw);
    if (block === null)
        return { type: undefined, title: undefined, related: [], body: raw };
    let type;
    let title;
    let related = [];
    for (const line of block.body.split(/\r?\n/u)) {
        const field = parseFrontmatterField(line);
        if (field === null)
            continue;
        const value = field.value.replace(/^["']|["']$/gu, '');
        if (field.key === 'type' && value !== '')
            type = value;
        else if (field.key === 'title' && value !== '')
            title = value;
        else if (field.key === 'related')
            related = parseFrontmatterArray(field.value);
    }
    return { type, title, related, body: block.rest };
}
/**
 * Extract raw `[[wikilink]]` targets from Markdown body.
 * @param text - Markdown body text.
 * @returns targets in source order.
 */
export function extractWikiLinkTargets(text) {
    const out = [];
    let cursor = 0;
    while (cursor < text.length) {
        const open = text.indexOf('[[', cursor);
        if (open < 0)
            break;
        const close = text.indexOf(']]', open + 2);
        if (close < 0)
            break;
        const payload = text.slice(open + 2, close);
        const separator = payload.indexOf('|');
        const target = (separator < 0 ? payload : payload.slice(0, separator)).trim();
        if (target !== '')
            out.push(target);
        cursor = close + 2;
    }
    return out;
}
const SKIP_DIRS = new Set([
    'node_modules',
    'target',
    'dist',
    'build',
    '.git',
    '.obsidian',
    '.llm-wiki',
    '_archives',
    '_candidates',
    '_governance',
    '_evidence',
    'sources',
    'queries',
]);
/**
 * Visit visible Wiki directories and Markdown pages once, with all consumers
 * sharing the same skip, path-normalization, and best-effort I/O boundary.
 * @param wikiRoot - absolute Wiki root.
 * @param visitor - callbacks for visible tree entries.
 */
export function visitWikiTree(wikiRoot, visitor) {
    let rootStat;
    try {
        rootStat = lstatSync(wikiRoot);
    }
    catch (error) {
        if (isMissingPathError(error))
            return;
        throw error;
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
        throw new Error('Wiki root is not an ordinary directory');
    const visited = new Set();
    const visitedFiles = new Set();
    const walk = (dir, relPrefix) => {
        const directoryStat = lstatSync(dir);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
            throw new Error(`unsafe Wiki directory: ${dir}`);
        const identity = `${directoryStat.dev}:${directoryStat.ino}`;
        if (visited.has(identity))
            throw new Error(`revisited Wiki directory inode: ${dir}`);
        visited.add(identity);
        const entries = readdirSync(dir);
        for (const name of entries) {
            if (SKIP_DIRS.has(name) || name.startsWith('.'))
                continue;
            const fullPath = join(dir, name);
            const path = relPrefix === '' ? name : `${relPrefix}/${name}`;
            const st = lstatSync(fullPath);
            if (st.isSymbolicLink())
                throw new Error(`symbolic links are not allowed in Wiki: ${path}`);
            if (st.isDirectory()) {
                visitor.onDirectory?.({ name, path });
                walk(fullPath, path);
            }
            else if (!st.isFile()) {
                throw new Error(`non-regular Wiki entry is not allowed: ${path}`);
            }
            else if (name.endsWith('.md')) {
                if (st.nlink !== 1)
                    throw new Error(`hard-linked Wiki page is not allowed: ${path}`);
                const fileIdentity = `${st.dev}:${st.ino}`;
                if (visitedFiles.has(fileIdentity))
                    throw new Error(`revisited Wiki file inode: ${path}`);
                visitedFiles.add(fileIdentity);
                if (st.size > MAX_WIKI_PAGE_BYTES)
                    throw new Error(`Wiki page exceeds 5 MiB: ${path}`);
                visitor.onMarkdown?.({ name, path, fullPath, size: st.size });
            }
        }
    };
    walk(wikiRoot, '');
}
/** Recursively collect wiki pages under a root directory. */
function collectPages(wikiRoot) {
    const pages = [];
    visitWikiTree(wikiRoot, {
        onMarkdown: ({ name, path, fullPath }) => {
            const raw = readRegularFileBounded(fullPath, MAX_WIKI_PAGE_BYTES).toString('utf8');
            const parsed = parsePageContent(raw);
            pages.push({
                path,
                title: parsed.title || name.replace(/\.md$/u, ''),
                nodeType: parsed.type || 'other',
                links: extractWikiLinkTargets(parsed.body),
                related: parsed.related,
                text: parsed.body,
            });
        },
    });
    return pages;
}
/** Build first-match lookup tables matching the legacy traversal semantics. */
function buildTargetLookup(states) {
    const byPath = new Map();
    const byTitle = new Map();
    const byStem = new Map();
    for (const state of states) {
        const normalizedPath = state.page.path.replace(/\\/gu, '/');
        const parts = normalizedPath.split('/');
        for (let index = 0; index < parts.length; index += 1) {
            const suffix = parts.slice(index).join('/');
            if (!byPath.has(suffix))
                byPath.set(suffix, state);
            const withoutExtension = suffix.replace(/\.md$/u, '');
            if (!byPath.has(withoutExtension))
                byPath.set(withoutExtension, state);
        }
        if (!byTitle.has(state.page.title))
            byTitle.set(state.page.title, state);
        const stem = basename(normalizedPath).replace(/\.md$/u, '');
        if (stem !== '' && !byStem.has(stem))
            byStem.set(stem, state);
    }
    return { byPath, byTitle, byStem };
}
/** Resolve a wikilink target to a page path (bare name or wiki-relative path). */
function resolveTarget(target, lookup) {
    const normalized = target.replace(/\\/g, '/');
    const stem = basename(normalized).replace(/\.md$/u, '');
    return lookup.byPath.get(normalized)
        ?? lookup.byPath.get(normalized.replace(/\.md$/u, ''))
        ?? lookup.byTitle.get(target)
        ?? lookup.byStem.get(stem);
}
/**
 * Louvain community detection (modularity-optimizing).
 * @param nodes - node ids.
 * @param edges - undirected edge pairs.
 * @returns map of node id → community id.
 */
function louvain(nodes) {
    const total = nodes.reduce((sum, node) => sum + node.degree, 0);
    if (total === 0)
        return;
    const moveNode = (node) => {
        const current = node.community;
        const k = node.degree;
        current.degree = Math.max(0, current.degree - k);
        const gains = new Map();
        for (const [neighbor, weight] of node.neighbors) {
            const community = neighbor.community;
            const prior = gains.get(community);
            gains.set(community, prior === undefined ? weight : prior + weight);
        }
        let best = current;
        let bestGain = 0;
        for (const [community, gain] of gains) {
            if (community === current)
                continue;
            // Modularity delta for moving id to comm (simplified, weight-1 edges):
            // ΔQ = (k_in - Σ_tot*k_i/m) terms; use the standard single-move formula.
            const m = total / 2;
            const delta = (gain - community.degree * k / (2 * m)) / (2 * m);
            if (delta > bestGain) {
                bestGain = delta;
                best = community;
            }
        }
        if (best !== current) {
            node.community = best;
            best.degree += k;
            return true;
        }
        current.degree += k;
        return false;
    };
    for (let pass = 0; pass < 12; pass++) {
        let moved = false;
        for (const node of nodes) {
            if (moveNode(node))
                moved = true;
        }
        if (!moved)
            break;
    }
    // Compact community ids.
    const compact = new Map();
    for (const node of nodes) {
        let id = compact.get(node.community);
        if (id === undefined) {
            id = compact.size;
            compact.set(node.community, id);
        }
        node.communityId = id;
    }
}
/**
 * Build the concept graph from the wiki page tree.
 * @param wikiRoot - absolute path of the project wiki directory.
 * @returns the graph (nodes + wikilink edges, Louvain clusters).
 */
export function buildGraph(wikiRoot) {
    const pages = collectPages(wikiRoot);
    const states = pages.map((page, index) => {
        const community = { degree: 0 };
        return { page, neighbors: new Map(), degree: 0, incoming: 0, community, communityId: index };
    });
    const targetLookup = buildTargetLookup(states);
    const rawEdges = new Map();
    const addEdge = (source, target) => {
        if (source === target)
            return;
        const first = source.page.path < target.page.path ? source : target;
        const second = first === source ? target : source;
        const key = `${first.page.path}\u0000${second.page.path}`;
        const existing = rawEdges.get(key);
        if (existing === undefined)
            rawEdges.set(key, { source: first, target: second, weight: 1 });
        else
            existing.weight += 1;
    };
    for (const source of states) {
        const targets = [...source.page.links, ...source.page.related];
        const seen = new Set();
        for (const target of targets) {
            const resolved = resolveTarget(target, targetLookup);
            if (resolved === undefined || seen.has(resolved.page.path))
                continue;
            seen.add(resolved.page.path);
            addEdge(source, resolved);
            resolved.incoming += 1;
        }
    }
    for (const edge of rawEdges.values()) {
        edge.source.neighbors.set(edge.target, 1);
        edge.target.neighbors.set(edge.source, 1);
        edge.source.degree += 1;
        edge.target.degree += 1;
    }
    for (const state of states)
        state.community.degree = state.degree;
    louvain(states);
    // Every wiki page is a graph node — truncation hides most of the knowledge
    // base (sources drop hardest since few pages link back to them), so keep
    // the full page set and let the client scale density/layout iterations.
    const nodes = states.map(state => ({
        id: state.page.path,
        label: state.page.title,
        type: state.page.nodeType,
        path: state.page.path,
        linkCount: state.incoming,
        community: state.communityId,
    }));
    const edges = [...rawEdges.values()].map(edge => ({
        source: edge.source.page.path,
        target: edge.target.page.path,
        weight: edge.weight,
    }));
    // Community summaries.
    const communityNodes = new Map();
    for (const node of nodes) {
        const members = communityNodes.get(node.community) ?? [];
        members.push(node);
        communityNodes.set(node.community, members);
    }
    const communitiesInfo = [...communityNodes.entries()]
        .map(([id, members]) => ({
        id,
        nodeCount: members.length,
        cohesion: 0,
        topNodes: members
            .sort((a, b) => b.linkCount - a.linkCount)
            .slice(0, 5)
            .map(node => node.label),
    }))
        .sort((a, b) => b.nodeCount - a.nodeCount);
    return { nodes, edges, communities: communitiesInfo };
}
/**
 * List wiki pages (recursive tree, heavyweight dirs skipped).
 * @param wikiRoot - The wiki root input.
 * @returns The value produced by list pages.
 */
export function listPages(wikiRoot) {
    const out = [];
    visitWikiTree(wikiRoot, {
        onDirectory: ({ name, path }) => out.push({ name, path, isDir: true, size: null }),
        onMarkdown: ({ name, path, size }) => out.push({ name, path, isDir: false, size }),
    });
    // Drop empty directories: a leaf directory with no pages is noise in the
    // tree and leads to a dead-end click in the viewer.
    const hasDescendant = (path) => out.some(entry => entry.path.startsWith(`${path}/`));
    return out.filter(entry => entry.isDir ? hasDescendant(entry.path) : true);
}
/**
 * Read one wiki page's raw text.
 * @param wikiRoot - The wiki root input.
 * @param relPath - The rel path input.
 * @returns The value produced by read page.
 */
export function readPage(wikiRoot, relPath) {
    const safe = relPath.replace(/^\/+/u, '');
    const full = join(wikiRoot, safe);
    return readRegularFileBounded(full, MAX_WIKI_PAGE_BYTES).toString('utf8');
}
//# sourceMappingURL=graph.js.map