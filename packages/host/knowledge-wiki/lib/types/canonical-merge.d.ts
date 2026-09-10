/**
 * Deterministic Candidate -> Canonical merge policy.
 *
 * The LLM may propose a merge, but this module only auto-merges exact
 * duplicates and strict body supersets. Divergent bodies require a separately
 * reviewed merged candidate.
 */
/**
 * Describes the canonical merge result value used by this package.
 */
export interface CanonicalMergeResult {
    content: string;
    mode: 'duplicate' | 'canonical-superset' | 'candidate-superset' | 'replace';
}
/**
 * Merge only exact duplicates or strict body supersets.
 * @param canonicalContent - The canonical content input.
 * @param candidateContent - The candidate content input.
 * @param approvedAt - The approved at input.
 * @returns The value produced by merge candidate into canonical.
 */
export declare function mergeCandidateIntoCanonical(canonicalContent: string, candidateContent: string, approvedAt: string): CanonicalMergeResult;
/**
 * Explicit human-approved replacement. The caller must archive the previous canonical first.
 * @param canonicalContent - The canonical content input.
 * @param candidateContent - The candidate content input.
 * @param approvedAt - The approved at input.
 * @returns The value produced by replace canonical with candidate.
 */
export declare function replaceCanonicalWithCandidate(canonicalContent: string, candidateContent: string, approvedAt: string): CanonicalMergeResult;
/**
 * Keep the canonical body and merge only provenance from a semantic duplicate.
 * @param canonicalContent - The canonical content input.
 * @param candidateContent - The candidate content input.
 * @param approvedAt - The approved at input.
 * @param approvedBy - The approved by input.
 * @returns The value produced by deduplicate candidate against canonical.
 */
export declare function deduplicateCandidateAgainstCanonical(canonicalContent: string, candidateContent: string, approvedAt: string, approvedBy?: string): CanonicalMergeResult;
//# sourceMappingURL=canonical-merge.d.ts.map