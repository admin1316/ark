/** Autonomous, deterministic policy for Candidate disposition. */
/**
 * Defines the governance action type used by this package.
 */
export type GovernanceAction = 'Promote' | 'Merge' | 'Deduplicate' | 'Archive' | 'Hold';
/**
 * Describes the governance decision value used by this package.
 */
export interface GovernanceDecision {
    action: GovernanceAction;
    confidence: number;
    score: number;
    reasons: string[];
    claimFingerprint: string;
    targetPath?: string;
}
/** Directories that contain visible Canonical knowledge. */
export declare const CANONICAL_WIKI_DIRECTORIES: readonly string[];
/** One validated Wiki-root-relative path and its absolute filesystem target. */
export interface GovernedWikiPath {
    readonly relativePath: string;
    readonly absolutePath: string;
}
/**
 * Resolve one durable Wiki-relative path without repairing unsafe input.
 * @param root - absolute Wiki root that owns the path.
 * @param input - persisted POSIX-style path relative to the Wiki root.
 * @param allowMissing - whether a missing suffix is valid for a future create.
 * @returns the normalized relative/absolute pair, or undefined when unsafe or absent.
 */
export declare function resolveGovernedWikiPath(root: string, input: string, allowMissing: boolean): GovernedWikiPath | undefined;
/**
 * Provides the governance policy version operation.
 * @returns The value produced by governance policy version.
 */
export declare function governancePolicyVersion(): string;
/**
 * Provides the decide candidate governance operation.
 * @param wikiRoot - The wiki root input.
 * @param candidatePath - The candidate path input.
 * @param content - The content input.
 * @param suggestedTarget - The suggested target input.
 * @returns The value produced by decide candidate governance.
 */
export declare function decideCandidateGovernance(wikiRoot: string, candidatePath: string, content: string, suggestedTarget?: string): GovernanceDecision;
//# sourceMappingURL=governance-policy.d.ts.map