/**
 * Review-item extraction from stage-2 model output.
 *
 * The generation prompt may emit `---REVIEW: <type> | <title>---` blocks
 * alongside FILE blocks; each becomes a `WikiReviewItem` appended to
 * `.llm-wiki/review.json` (an append-only array). Ids are deterministic
 * (`review-` + FNV-1a hex), so re-ingests replace, never duplicate, and
 * the existing app-era review file is preserved.
 * @module @deepseek-ai/dsh-knowledge-wiki/reviews
 */
import type { CandidateVerification } from './types.ts';
import { type KnowledgeWikiVerifierAuthority } from './verifier.ts';
/** A parsed (not yet persisted) review item. */
export interface ParsedReview {
    readonly type: string;
    readonly title: string;
    readonly description: string;
    /** Wiki-relative pages the review touches. */
    readonly affectedPages: string[];
    /** Suggested search queries. */
    readonly searchQueries: string[];
}
/**
 * Parse `---REVIEW: <type> | <title>---` blocks out of model output. The
 * block body may carry `description:`, `PAGES:` and `SEARCH:` lines; a
 * missing closer discards the block.
 * @param text - the stage-2 generation output.
 * @returns the parsed reviews in output order.
 */
export declare function parseReviewBlocks(text: string): ParsedReview[];
/** Classified result of one advisory batch, with candidate rows left to their owner. */
export interface AdvisoryResolution {
    readonly resolvedCount: number;
    readonly candidateIds: readonly string[];
}
/**
 * Finish prepared promotions after a crash, or fail closed on divergent bytes.
 * @param authority - Trusted verifier that revalidates the journal before mutation.
 * @param reviewFile - Review file whose sibling directory owns promotion journals.
 * @param wikiRoot - Canonical Wiki root used to confine Candidate and target paths.
 * @param archiveRoot - Archive root used to confine archived Candidate paths.
 * @returns Number of prepared journals completed and marked committed.
 */
export declare function recoverCandidateReviewTransactions(authority: KnowledgeWikiVerifierAuthority | undefined, reviewFile: string, wikiRoot: string, archiveRoot: string): number;
/**
 * Classify all requested rows, then atomically resolve the eligible advisory subset once.
 * @param reviewFile - absolute review JSON path.
 * @param reviewIds - review ids requested by the caller.
 * @param action - persisted resolution action.
 * @returns resolved advisory count and candidate ids for the candidate owner.
 */
export declare function resolveAdvisoryReviewBatch(reviewFile: string, reviewIds: string[], action: string): AdvisoryResolution;
/**
 * Resolve persisted non-candidate review items while preserving the count-only caller contract.
 * @param reviewFile - absolute review JSON path.
 * @param reviewIds - review identifiers requested by the caller.
 * @param action - resolution action to persist for eligible advisory rows.
 * @returns the number of advisory rows resolved.
 */
export declare function resolveAdvisoryReviews(reviewFile: string, reviewIds: string[], action: string): number;
/**
 * Append reviews to the review file, deduped by deterministic id. The file
 * is an append-only JSON array; a malformed existing file is rebuilt with
 * only the new reviews (the unparseable content is already unreadable).
 * @param reviewFile - absolute path of `.llm-wiki/review.json`.
 * @param sourcePath - absolute path of the source that produced the reviews.
 * @param reviews - parsed reviews to persist.
 * @returns how many reviews were newly appended.
 */
export declare function appendReviews(reviewFile: string, sourcePath: string, reviews: ParsedReview[]): number;
/**
 * Register written candidate pages as real, hash-bound approval items.
 * @param reviewFile - The review file input.
 * @param projectRoot - The project root input.
 * @param sourcePath - The source path input.
 * @param writtenPaths - The written paths input.
 * @returns The value produced by append candidate reviews.
 */
export declare function appendCandidateReviews(reviewFile: string, projectRoot: string, sourcePath: string, writtenPaths: string[]): number;
/**
 * Record independent, hash-bound verification without changing Candidate or Canonical files.
 * @param authority - Trusted verifier used to authenticate and bind the receipt.
 * @param reviewFile - The review file input.
 * @param wikiRoot - The wiki root input.
 * @param reviewIdValue - The review id value input.
 * @param receiptId - Receipt id created by the trusted verifier owner.
 * @param action - Governance action that the receipt must authenticate.
 * @returns The value produced by record candidate verification.
 */
export declare function recordCandidateVerification(authority: KnowledgeWikiVerifierAuthority | undefined, reviewFile: string, wikiRoot: string, reviewIdValue: string, receiptId: unknown, action: CandidateVerification['action']): boolean;
/**
 * Apply a hash-bound candidate decision. Null means this is an advisory item.
 * @param authority - Trusted verifier that authenticates the bound receipt and promotion journal.
 * @param reviewFile - The review file input.
 * @param projectRoot - The project root input.
 * @param wikiRoot - The wiki root input.
 * @param archiveRoot - The archive root input.
 * @param reviewIdValue - The review id value input.
 * @param action - The action input.
 * @param actor - The actor input.
 * @returns The value produced by apply candidate review.
 */
export declare function applyCandidateReview(authority: KnowledgeWikiVerifierAuthority | undefined, reviewFile: string, projectRoot: string, wikiRoot: string, archiveRoot: string, reviewIdValue: string, action: string, actor?: string): boolean | null;
//# sourceMappingURL=reviews.d.ts.map