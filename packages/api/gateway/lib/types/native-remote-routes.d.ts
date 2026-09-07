/**
 * Native Swift consumer coverage for generated Typert Remote descriptors.
 *
 * Gateway ownership is dynamic: every live strict descriptor can be claimed.
 * This list records the routes currently consumed by Ark so build checks can
 * reject a missing descriptor without constraining future Host plugins.
 */
export declare const NATIVE_TYPERT_REMOTE_ENDPOINTS: readonly ["agentPreset/copy", "agentPreset/list", "agentPreset/openDocument", "agentPreset/read", "agentPreset/remove", "agentPreset/select", "commands/execute", "commands/list", "credentials/describe", "credentials/set", "credentials/unset", "fileReferences/list", "goal/clear", "goal/edit", "goal/pause", "goal/resume", "knowledgeWiki/createPage", "knowledgeWiki/createProject", "knowledgeWiki/deepResearch", "knowledgeWiki/graph", "knowledgeWiki/ingestQueueAdd", "knowledgeWiki/ingestQueueCancel", "knowledgeWiki/ingestQueueStatus", "knowledgeWiki/list", "knowledgeWiki/listProjects", "knowledgeWiki/pageContent", "knowledgeWiki/removeProject", "knowledgeWiki/resolveReview", "knowledgeWiki/resolveReviews", "knowledgeWiki/reviews", "knowledgeWiki/search", "knowledgeWiki/setProject", "knowledgeWiki/writePage", "llm/discoverModels", "llm/models", "llm/mutateProvider", "llm/providers", "messageFeedback/delete", "messageFeedback/list", "messageFeedback/put", "pluginInventory/list", "session/attachment", "session/cancel", "session/create", "session/fork", "session/history", "session/list", "session/models", "session/prompt", "session/rename", "session/search", "session/selectModel", "session/updateQueue", "sessionReferenceResolver/candidates", "settings/describe", "settings/openDocument", "settings/mutate", "skill/list", "subagent/history", "subagent/interrupt", "subagent/list", "subagent/prompt", "workbench/webRead", "workspace/archiveSession", "workspace/create", "workspace/delete", "workspace/deleteArchivedSession", "workspace/insertBefore", "workspace/insertSessionBefore", "workspace/list", "workspace/rename", "workspace/unarchiveSession"];
/**
 * Deliberate API-only legacy calls still consumed by Native Ark. Kept as an
 * explicit empty fail-closed list so a future dot route cannot silently bypass
 * strict Remote.
 */
export declare const NATIVE_LEGACY_API_ENDPOINTS: readonly [];
/** Native-consumed Typert Remote endpoint. */
export type NativeTypertRemoteEndpoint = typeof NATIVE_TYPERT_REMOTE_ENDPOINTS[number];
/** Exact Typert service owner expected for each current Native endpoint. */
export declare const NATIVE_TYPERT_REMOTE_OWNERS: Readonly<Record<NativeTypertRemoteEndpoint, string>>;
//# sourceMappingURL=native-remote-routes.d.ts.map