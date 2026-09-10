/** Independent Candidate verification contract and receipt validation. */
import type { CandidateVerification, CandidateVerificationResult, WikiReviewItem } from './types.ts';
export type { CandidateVerificationResult } from './types.ts';
/** Full source identity supplied by the trusted launcher/build owner. */
export interface KnowledgeWikiSourceIdentity {
    readonly commit: string;
    readonly sourceDigest: string;
    readonly dirty: boolean;
    readonly dirtyDigest: string;
    readonly buildDigest: string;
}
/** One independently executed check. */
export interface IndependentVerificationOutcome {
    readonly name: string;
    readonly result: 'pass' | 'fail';
    readonly evidence: string[];
}
/** Immutable request given to the independent verifier. */
export interface IndependentVerificationRequest {
    readonly schemaVersion: 2;
    readonly review: Readonly<Record<string, unknown>>;
    readonly reviewHash: string;
    readonly candidatePath: string;
    readonly candidateHash: string;
    readonly targetPath: string | null;
    readonly governanceAction: 'Promote' | 'Merge' | 'Replace' | 'Deduplicate' | 'Archive';
    readonly governanceDecision: {
        readonly action: string;
        readonly targetPath: string | null;
        readonly policyVersion: string;
    };
    readonly sourceIdentity: KnowledgeWikiSourceIdentity;
    readonly environment: {
        readonly nodeVersion: string;
        readonly platform: string;
        readonly arch: string;
        readonly policyVersion: string;
    };
}
/** Result and opaque proof produced by an actual independent verifier owner. */
export interface IndependentVerificationResult {
    readonly authorityId: string;
    readonly requestHash: string;
    readonly result: 'pass' | 'fail';
    readonly methods: CandidateVerification['methods'];
    readonly outcomes: IndependentVerificationOutcome[];
    readonly issuedAt: string;
    readonly proof: string;
}
/** Authentication attached to a promotion WAL by the same external authority. */
export interface VerificationAuthoritySeal {
    readonly authorityId: string;
    readonly proof: string;
}
/** Synchronous audit/crash-consistency position reported by a promotion transaction. */
export interface PromotionCheckpoint {
    /** Persisted-journal, per-operation, or pre-commit position at which the authority is called. */
    readonly phase: 'journal-persisted' | 'stage-written' | 'entry-renamed' | 'tombstone-unlinked' | 'operation-applied' | 'before-commit-marker';
    /** Zero-based operation index; -1 after journal persistence, operation count before the commit marker. */
    readonly operationIndex: number;
}
/**
 * Injected authority. Secrets and execution live outside project-writable Wiki
 * content; this package only asks it to run/validate and to authenticate WAL bytes.
 */
export interface KnowledgeWikiVerifierAuthority {
    readonly authorityId: string;
    sourceIdentity(): KnowledgeWikiSourceIdentity;
    verifyCandidate(request: IndependentVerificationRequest, signal: AbortSignal): Promise<IndependentVerificationResult>;
    validateCandidateResult(request: IndependentVerificationRequest, result: IndependentVerificationResult): boolean;
    sealPromotion(payload: string): VerificationAuthoritySeal;
    validatePromotion(payload: string, seal: VerificationAuthoritySeal): boolean;
    /** Optional external audit/crash-consistency checkpoint. */
    checkpointPromotion?(payload: string, checkpoint: PromotionCheckpoint): void;
}
/** Receipt copy persisted in the project; authority proof remains externally verifiable. */
export interface TrustedVerificationReceipt {
    readonly schemaVersion: 2;
    readonly id: string;
    readonly request: IndependentVerificationRequest;
    readonly result: IndependentVerificationResult;
    readonly receiptHash: string;
}
/**
 * Canonical JSON used for every hash and authority call.
 * @param value - Acyclic JSON data; undefined object properties are omitted.
 * @returns JSON text with sorted object keys and the original array order.
 * @throws If the value contains a cycle or a primitive JSON cannot serialize, such as bigint.
 */
export declare function canonicalJson(value: unknown): string;
/**
 * Hash receipt, review, or Candidate bytes for identity comparisons.
 * @param value - UTF-8 text or the exact bytes to hash.
 * @returns Lowercase hexadecimal SHA-256 digest.
 */
export declare function sha256(value: string | Buffer): string;
/**
 * Immutable Review proposal fields; mutable resolution/verification mirrors are excluded.
 * @param item - Review whose proposal fields are bound into a verification request.
 * @returns Frozen proposal with copied, frozen arrays, explicit nulls, and resolved fixed to false.
 */
export declare function immutableReviewRow(item: WikiReviewItem): Readonly<Record<string, unknown>>;
/**
 * Construct the exact request; the external authority, never Candidate text, decides pass/fail.
 * @param authority - Trusted owner supplying the source/build identity; no verification is run here.
 * @param wikiRoot - Wiki root used to resolve the Candidate and optional canonical target.
 * @param item - Unresolved Candidate review supplying proposal fields and the expected Candidate content hash.
 * @param action - Requested action, checked against target presence and bound into the request.
 * @returns Frozen request, or undefined for an ineligible review, invalid Candidate/target, or incompatible action.
 * @throws On invalid trusted source identity or uncaught filesystem/read failures.
 */
export declare function buildVerificationRequest(authority: KnowledgeWikiVerifierAuthority, wikiRoot: string, item: WikiReviewItem, action: IndependentVerificationRequest['governanceAction']): IndependentVerificationRequest | undefined;
/**
 * Ask the injected independent authority to verify and persist its receipt copy.
 * Authenticated pass and fail results are written before returning; the review is not updated here.
 * @param authority - External verifier owner; absence returns verifier-authority-unavailable.
 * @param reviewFile - Review JSON file; receipts are written in its sibling verification-receipts directory.
 * @param wikiRoot - Wiki root used to bind the Candidate and governance target.
 * @param reviewId - Review id to load from the persisted review array.
 * @param action - Governance action to bind into the independent request.
 * @param signal - Passed to the authority and checked immediately before and after its asynchronous call.
 * @returns Persisted verdict/evidence, or an explicit blocker; ok is true only for a pass.
 * @throws On cancellation, authority errors, malformed review state, or uncaught filesystem failures.
 */
export declare function verifyCandidate(authority: KnowledgeWikiVerifierAuthority | undefined, reviewFile: string, wikiRoot: string, reviewId: string, action: IndependentVerificationRequest['governanceAction'], signal: AbortSignal): Promise<CandidateVerificationResult>;
/**
 * Revalidate a project-stored receipt through the injected external authority.
 * @param authority - Owner validating the proof and supplying the current source/build identity.
 * @param reviewFile - Review file whose sibling verification-receipts directory stores the receipt.
 * @param receiptId - Receipt basename id; invalid ids are rejected before file access.
 * @returns Authenticated pass or fail receipt matching the current source/environment, or undefined on rejection.
 * File-read and JSON-parse failures return undefined; this does not re-read Candidate bytes.
 * @throws If later receipt structure access or an authority callback throws.
 */
export declare function readTrustedReceipt(authority: KnowledgeWikiVerifierAuthority | undefined, reviewFile: string, receiptId: string): TrustedVerificationReceipt | undefined;
/**
 * Revalidate a receipt and the still-current Candidate/Review bytes.
 * @param authority - External proof and source/build identity owner.
 * @param reviewFile - Review file locating the sibling verification-receipts directory.
 * @param wikiRoot - Wiki root used to rebuild the request from current Candidate bytes and target state.
 * @param item - Current review proposal to compare with the authenticated request.
 * @param receiptId - Receipt to authenticate and match against the rebuilt request.
 * @param expectedAction - Required action recorded in the receipt request.
 * @returns Matching passing receipt and its verification projection, or undefined when authentication, verdict, or matching fails.
 * @throws On uncaught receipt-validation, authority, source-identity, or Candidate read failures.
 */
export declare function readTrustedVerification(authority: KnowledgeWikiVerifierAuthority | undefined, reviewFile: string, wikiRoot: string, item: WikiReviewItem, receiptId: string, expectedAction: IndependentVerificationRequest['governanceAction']): {
    verification: CandidateVerification;
    receipt: TrustedVerificationReceipt;
} | undefined;
//# sourceMappingURL=verifier.d.ts.map