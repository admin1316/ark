/**
 * Model-facing knowledge-base tools over the knowledgeWiki service: the
 * agent in 对话 can search, read, and query the 万相织鉴 knowledge graph
 * natively — no MCP bridge, no desktop app. Tools register through the
 * harness tool system; every call resolves the knowledgeWiki service
 * lazily so the plugin loads even when the service is absent.
 * @module @deepseek-ai/dsh-tool-knowledge-wiki
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
/** Stable Cordis plugin name. */
export const name = 'tool-knowledge-wiki';
/** Required services: the tool registry and the prompt section owner. */
export const inject = ['tools', 'systemPrompt'];
/** Cap on returned hits / listed files / read characters. */
const SEARCH_MAX_RESULTS = 8;
const FILES_MAX = 60;
const READ_MAX_CHARS = 8000;
const REVIEW_MAX = 30;
/** Resolve the knowledgeWiki service; undefined when the bridge is absent. */
function wikiService(ctx) {
    return ctx.get('knowledgeWiki');
}
/** Text block helper for render callbacks. */
function textBlock(text) {
    return [{ type: 'text', text }];
}
function wikiRootRelativePath(input) {
    if (input === '' || input.startsWith('/') || input.startsWith('wiki/') || input.includes('\\') || input.includes('\0')) {
        throw new Error('path must be relative to the Wiki root (for example entities/name.md)');
    }
    if (input.split('/').some(part => part === '' || part === '.' || part === '..')) {
        throw new Error('path must not contain traversal segments');
    }
    return input;
}
/**
 * Register the knowledge-base tools.
 * @param ctx - plugin context.
 */
export function apply(ctx) {
    ctx.systemPrompt.section({
        name: 'tool:knowledge-wiki',
        order: 120,
        text: 'Use wiki_search to find knowledge-base pages, wiki_read to read one Wiki-root-relative page, wiki_files to list canonical pages, wiki_graph to inspect the graph, wiki_reviews to inspect governance, wiki_verify_candidate to run the trusted verifier, and wiki_ingest to enqueue source work. Cite pages by their Wiki-root-relative path.',
    });
    ctx.tools.register(defineTool({
        name: 'wiki_search',
        description: 'Search the project knowledge base (万相织鉴). Returns ranked page paths with relevance scores.',
        parameters: {
            query: { type: 'string', required: true, description: 'The search query (keywords or a question).' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    hits: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                path: { type: 'string' },
                                score: { type: 'number' },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => {
                const hits = value.hits;
                if (hits.length === 0)
                    return textBlock('No matches found.');
                return textBlock(hits.map(hit => `- ${hit.path} (score ${hit.score})`).join('\n'));
            },
        },
        async execute(args) {
            const service = wikiService(ctx);
            if (service === undefined)
                throw new Error('knowledgeWiki service unavailable');
            const hits = await service.search({ query: args.query, topK: SEARCH_MAX_RESULTS });
            return { hits };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'wiki_files',
        description: 'List canonical knowledge-base pages. Paths are relative to the Wiki root; raw sources are intentionally not exposed by this tool.',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    files: { type: 'array', required: true, items: { type: 'string' } },
                    total: { type: 'number' },
                },
            },
            render: (_args, value) => {
                const files = value.files;
                return textBlock(`${value.total} files total. First ${files.length}:\n${files.map(file => `- ${file}`).join('\n')}`);
            },
        },
        async execute(_args) {
            const service = wikiService(ctx);
            if (service === undefined)
                throw new Error('knowledgeWiki service unavailable');
            const entries = await service.list();
            return { files: entries.slice(0, FILES_MAX).map(entry => entry.path), total: entries.length };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'wiki_read',
        description: 'Read one canonical knowledge-base page by its Wiki-root-relative path (e.g. entities/角色名.md).',
        parameters: {
            path: { type: 'string', required: true, description: 'Project-relative page path.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    path: { type: 'string' },
                    content: { type: 'string' },
                    truncated: { type: 'boolean' },
                },
            },
            render: (_args, value) => {
                const truncated = value.truncated === true ? '\n(内容已截断)' : '';
                return textBlock(`# ${value.path}\n\n${value.content}${truncated}`);
            },
        },
        async execute(args) {
            const service = wikiService(ctx);
            if (service === undefined)
                throw new Error('knowledgeWiki service unavailable');
            const path = wikiRootRelativePath(args.path);
            const page = await service.pageContent({ path });
            if (page.content === '')
                throw new Error(`page not found or unreadable: ${args.path}`);
            const truncated = page.content.length > READ_MAX_CHARS;
            return { path: page.path, content: page.content.slice(0, READ_MAX_CHARS), truncated };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'wiki_graph',
        description: 'Query the knowledge graph. Returns nodes (with community ids and link counts) and edges matching the filter.',
        parameters: {
            query: { type: 'string', description: 'Filter nodes whose label or id contains this text.' },
            nodeType: { type: 'string', description: 'Filter by node type (entity/concept/source/finding/…).' },
            limit: { type: 'number', description: 'Maximum nodes to return (default 20).' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    nodes: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                id: { type: 'string' },
                                label: { type: 'string' },
                                type: { type: 'string' },
                                path: { type: 'string' },
                                linkCount: { type: 'number' },
                                community: { type: 'number' },
                            },
                        },
                    },
                    edges: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                source: { type: 'string' },
                                target: { type: 'string' },
                                weight: { type: 'number' },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => {
                const nodes = value.nodes;
                const edges = value.edges;
                const nodeLines = nodes.map(node => `- ${node.label} (${node.type}, ${node.linkCount} links${node.path ? `, ${node.path}` : ''})`);
                const edgeLines = edges.slice(0, 30).map(edge => `- ${edge.source} ↔ ${edge.target} (w=${edge.weight})`);
                return textBlock(`Nodes (${nodes.length}):\n${nodeLines.join('\n')}\n\nEdges (showing first 30 of ${edges.length}):\n${edgeLines.join('\n')}`);
            },
        },
        async execute(args) {
            const service = wikiService(ctx);
            if (service === undefined)
                throw new Error('knowledgeWiki service unavailable');
            const graph = await service.graph();
            const q = args.query?.toLowerCase();
            const t = args.nodeType?.toLowerCase();
            const limit = Math.min(args.limit ?? 20, 100);
            const matchedIds = new Set();
            const nodes = graph.nodes
                .filter((node) => {
                if (t !== undefined && node.type !== t)
                    return false;
                if (q !== undefined && q !== '' && !node.label.toLowerCase().includes(q) && !node.id.toLowerCase().includes(q))
                    return false;
                return true;
            })
                .slice(0, limit);
            for (const node of nodes)
                matchedIds.add(node.id);
            const edges = graph.edges.filter(edge => matchedIds.has(edge.source) && matchedIds.has(edge.target));
            return { nodes, edges };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'wiki_reviews',
        description: 'List unresolved knowledge-base review items (missing pages, contradictions, pending human judgment).',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    reviews: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                id: { type: 'string' },
                                title: { type: 'string' },
                                type: { type: 'string' },
                                description: { type: 'string' },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => {
                const reviews = value.reviews;
                if (reviews.length === 0)
                    return textBlock('No unresolved review items.');
                return textBlock(reviews.map(review => `- [${review.type}] ${review.title}${review.description ? ` — ${review.description.slice(0, 140)}` : ''}`).join('\n'));
            },
        },
        async execute(_args) {
            const service = wikiService(ctx);
            if (service === undefined)
                throw new Error('knowledgeWiki service unavailable');
            const reviews = await service.reviews({ status: 'unresolved', limit: REVIEW_MAX });
            return {
                reviews: reviews.map(review => ({
                    id: review.id,
                    title: review.title,
                    type: review.type,
                    ...(review.description === undefined ? {} : { description: review.description }),
                })),
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'wiki_ingest',
        description: 'Queue one raw source path or http(s) URL for the canonical Knowledge Wiki ingest owner. Returns the durable task state; it does not run a second direct ingest path.',
        parameters: {
            input: { type: 'string', required: true, description: 'Project-relative source path or http(s) URL.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    tasks: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                id: { type: 'number' },
                                input: { type: 'string' },
                                status: { type: 'string' },
                            },
                        },
                    },
                    running: { type: 'boolean', required: true },
                },
            },
            render: (_args, value) => {
                const tasks = value.tasks;
                return textBlock(tasks.length === 0
                    ? 'No task was queued.'
                    : tasks.map(task => `- #${task.id} ${task.status}: ${task.input}`).join('\n'));
            },
        },
        async execute(args) {
            const service = wikiService(ctx);
            if (service === undefined)
                throw new Error('knowledgeWiki service unavailable');
            const snapshot = await service.ingestQueueAdd({ inputs: [args.input] });
            return {
                tasks: snapshot.tasks.map(task => ({ id: task.id, input: task.input, status: task.status })),
                running: snapshot.running,
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'wiki_verify_candidate',
        description: 'Run the canonical deterministic verifier for one Candidate review. The caller cannot provide pass/fail metadata or receipt hashes.',
        parameters: {
            reviewId: { type: 'string', required: true, description: 'Candidate review id returned by wiki_reviews.' },
            action: {
                type: 'string',
                required: true,
                enum: ['Promote', 'Merge', 'Replace', 'Deduplicate', 'Archive'],
                description: 'Exact governance action the independent result must bind.',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    receiptId: { type: 'string' },
                    result: { type: 'string' },
                    evidence: { type: 'array', required: true, items: { type: 'string' } },
                    errorCode: { type: 'string' },
                },
            },
            render: (_args, value) => textBlock(value.ok
                ? `Candidate verified by the trusted owner (${value.receiptId}).`
                : `Candidate verification failed${value.errorCode ? `: ${value.errorCode}` : '.'}`),
        },
        async execute(args, exec) {
            const service = wikiService(ctx);
            if (service === undefined)
                throw new Error('knowledgeWiki service unavailable');
            return service.verifyCandidate({ reviewId: args.reviewId, action: args.action }, exec.signal);
        },
    }));
}
//# sourceMappingURL=index.js.map