/** Independent Candidate verification contract and receipt validation. */
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { atomicWriteFile, readRegularFileBounded } from "./filesystem.js";
import { decideCandidateGovernance, governancePolicyVersion, resolveGovernedWikiPath } from "./governance-policy.js";
const RECEIPT_SCHEMA = 2;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const COMMIT_RE = /^[0-9a-f]{40}$/u;
const ID_RE = /^[A-Za-z0-9._:-]{1,160}$/u;
const VERIFICATION_METHODS = new Set([
    'unit_test',
    'integration_test',
    'production_observation',
    'manual_review',
]);
/**
 * Canonical JSON used for every hash and authority call.
 * @param value - Acyclic JSON data; undefined object properties are omitted.
 * @returns JSON text with sorted object keys and the original array order.
 * @throws If the value contains a cycle or a primitive JSON cannot serialize, such as bigint.
 */
export function canonicalJson(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(',')}]`;
    const object = value;
    return `{${Object.keys(object)
        .sort()
        .filter(key => object[key] !== undefined)
        .map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
        .join(',')}}`;
}
/**
 * Hash receipt, review, or Candidate bytes for identity comparisons.
 * @param value - UTF-8 text or the exact bytes to hash.
 * @returns Lowercase hexadecimal SHA-256 digest.
 */
export function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}
/**
 * Immutable Review proposal fields; mutable resolution/verification mirrors are excluded.
 * @param item - Review whose proposal fields are bound into a verification request.
 * @returns Frozen proposal with copied, frozen arrays, explicit nulls, and resolved fixed to false.
 */
export function immutableReviewRow(item) {
    return Object.freeze({
        id: item.id,
        title: item.title,
        type: item.type,
        description: item.description ?? null,
        sourcePath: item.sourcePath ?? null,
        affectedPages: Object.freeze([...(item.affectedPages ?? [])]),
        resolved: false,
        createdAt: item.createdAt ?? null,
        searchQueries: Object.freeze([...(item.searchQueries ?? [])]),
        reviewKind: item.reviewKind ?? null,
        candidatePath: item.candidatePath ?? null,
        candidateHash: item.candidateHash ?? null,
        targetPath: item.targetPath ?? null,
    });
}
function validSourceIdentity(value) {
    return COMMIT_RE.test(value.commit)
        && SHA256_RE.test(value.sourceDigest)
        && SHA256_RE.test(value.dirtyDigest)
        && SHA256_RE.test(value.buildDigest)
        && typeof value.dirty === 'boolean';
}
function environment() {
    return {
        nodeVersion: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        policyVersion: governancePolicyVersion(),
    };
}
function receiptDirectory(reviewFile) {
    return join(dirname(reviewFile), 'verification-receipts');
}
function isReviewItem(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    return typeof Reflect.get(value, 'id') === 'string'
        && typeof Reflect.get(value, 'resolved') === 'boolean'
        && typeof Reflect.get(value, 'title') === 'string';
}
function loadReview(reviewFile, reviewId) {
    let parsed;
    try {
        parsed = JSON.parse(readRegularFileBounded(reviewFile, 5 * 1024 * 1024).toString('utf8'));
    }
    catch (error) {
        if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT')
            return undefined;
        throw error;
    }
    if (!Array.isArray(parsed) || !parsed.every(isReviewItem))
        throw new Error('invalid review state');
    return parsed.find(item => item.id === reviewId);
}
function actionIsCompatible(action, targetPath, targetExists) {
    if (action === 'Archive')
        return true;
    if (targetPath === undefined)
        return false;
    return action === 'Promote' ? !targetExists : targetExists;
}
/**
 * Construct the exact request; the external authority, never Candidate text, decides pass/fail.
 * @param authority - Trusted owner supplying the source/build identity; no verification is run here.
 * @param wikiRoot - Wiki root used to resolve the Candidate and optional canonical target.
 * @param item - Unresolved Candidate review supplying proposal fields and the expected Candidate content hash.
 * @param action - Requested action, checked against target presence and bound into the request.
 * @returns Frozen request, or undefined for an ineligible review, invalid Candidate/target, or incompatible action.
 * @throws On invalid trusted source identity or uncaught filesystem/read failures.
 */
export function buildVerificationRequest(authority, wikiRoot, item, action) {
    if (item.reviewKind !== 'candidate' || item.resolved || !item.candidatePath || !item.candidateHash)
        return undefined;
    const candidate = resolveGovernedWikiPath(wikiRoot, item.candidatePath, false);
    if (candidate === undefined || !candidate.relativePath.startsWith('_candidates/'))
        return undefined;
    const stat = lstatSync(candidate.absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        return undefined;
    const content = readRegularFileBounded(candidate.absolutePath, 5 * 1024 * 1024).toString('utf8');
    if (sha256(content) !== item.candidateHash)
        return undefined;
    const target = item.targetPath === undefined
        ? undefined
        : resolveGovernedWikiPath(wikiRoot, item.targetPath, true);
    if (item.targetPath !== undefined && target === undefined)
        return undefined;
    let targetExists = false;
    if (target !== undefined) {
        try {
            const targetStat = lstatSync(target.absolutePath);
            if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.nlink !== 1)
                return undefined;
            targetExists = true;
        }
        catch (error) {
            if (!(typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT'))
                throw error;
        }
    }
    if (!actionIsCompatible(action, item.targetPath, targetExists))
        return undefined;
    const sourceIdentity = authority.sourceIdentity();
    if (!validSourceIdentity(sourceIdentity))
        throw new Error('invalid trusted source identity');
    const review = immutableReviewRow(item);
    const governance = decideCandidateGovernance(wikiRoot, item.candidatePath, content, item.targetPath);
    return Object.freeze({
        schemaVersion: RECEIPT_SCHEMA,
        review,
        reviewHash: sha256(canonicalJson(review)),
        candidatePath: item.candidatePath,
        candidateHash: item.candidateHash,
        targetPath: item.targetPath ?? null,
        governanceAction: action,
        governanceDecision: Object.freeze({
            action: governance.action,
            targetPath: governance.targetPath ?? null,
            policyVersion: governancePolicyVersion(),
        }),
        sourceIdentity: Object.freeze({ ...sourceIdentity }),
        environment: Object.freeze(environment()),
    });
}
function resultIsCoherent(authority, request, result) {
    if (result.authorityId !== authority.authorityId || !ID_RE.test(result.authorityId))
        return false;
    if (result.requestHash !== sha256(canonicalJson(request)) || !SHA256_RE.test(result.requestHash))
        return false;
    const methods = result.methods;
    if (!Array.isArray(methods) || methods.length === 0
        || !methods.every(method => typeof method === 'string'
            && VERIFICATION_METHODS.has(method)))
        return false;
    if (!Array.isArray(result.outcomes) || result.outcomes.length === 0)
        return false;
    if (!result.outcomes.every(isIndependentOutcome))
        return false;
    const derived = result.outcomes.every(outcome => outcome.result === 'pass') ? 'pass' : 'fail';
    if (derived !== result.result || !Number.isFinite(Date.parse(result.issuedAt)) || result.proof === '')
        return false;
    return authority.validateCandidateResult(request, result);
}
function isIndependentOutcome(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const name = Reflect.get(value, 'name');
    const result = Reflect.get(value, 'result');
    const evidence = Reflect.get(value, 'evidence');
    return typeof name === 'string'
        && name !== ''
        && (result === 'pass' || result === 'fail')
        && Array.isArray(evidence)
        && evidence.length > 0
        && evidence.every(item => typeof item === 'string' && item !== '');
}
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
export async function verifyCandidate(authority, reviewFile, wikiRoot, reviewId, action, signal) {
    if (authority === undefined) {
        return { ok: false, evidence: [], errorCode: 'verifier-authority-unavailable' };
    }
    const item = loadReview(reviewFile, reviewId);
    if (item === undefined)
        return { ok: false, evidence: [], errorCode: 'review-not-found' };
    let request;
    try {
        request = buildVerificationRequest(authority, wikiRoot, item, action);
    }
    catch (error) {
        if (error instanceof Error && error.message === 'invalid trusted source identity') {
            return { ok: false, evidence: [error.message], errorCode: 'source-identity-invalid' };
        }
        throw error;
    }
    if (request === undefined)
        return { ok: false, evidence: [], errorCode: 'candidate-invalid' };
    signal.throwIfAborted();
    const result = await authority.verifyCandidate(request, signal);
    signal.throwIfAborted();
    if (!resultIsCoherent(authority, request, result)) {
        return { ok: false, evidence: [], errorCode: 'verification-failed' };
    }
    const unsigned = { schemaVersion: RECEIPT_SCHEMA, request, result };
    const receiptHash = sha256(canonicalJson(unsigned));
    const id = `verification-${receiptHash.slice(0, 32)}`;
    const receipt = { ...unsigned, id, receiptHash };
    atomicWriteFile(join(receiptDirectory(reviewFile), `${id}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
    return {
        ok: result.result === 'pass',
        receiptId: id,
        result: result.result,
        evidence: result.outcomes.flatMap(outcome => outcome.evidence),
        ...(result.result === 'pass' ? {} : { errorCode: 'verification-failed' }),
    };
}
/**
 * Revalidate a project-stored receipt through the injected external authority.
 * @param authority - Owner validating the proof and supplying the current source/build identity.
 * @param reviewFile - Review file whose sibling verification-receipts directory stores the receipt.
 * @param receiptId - Receipt basename id; invalid ids are rejected before file access.
 * @returns Authenticated pass or fail receipt matching the current source/environment, or undefined on rejection.
 * File-read and JSON-parse failures return undefined; this does not re-read Candidate bytes.
 * @throws If later receipt structure access or an authority callback throws.
 */
export function readTrustedReceipt(authority, reviewFile, receiptId) {
    if (authority === undefined || !ID_RE.test(receiptId))
        return undefined;
    const path = join(receiptDirectory(reviewFile), `${receiptId}.json`);
    let raw;
    try {
        raw = JSON.parse(readRegularFileBounded(path, 2 * 1024 * 1024).toString('utf8'));
    }
    catch {
        return undefined;
    }
    if (typeof raw !== 'object' || raw === null || Reflect.get(raw, 'schemaVersion') !== RECEIPT_SCHEMA)
        return undefined;
    const receipt = raw;
    if (receipt.id !== receiptId)
        return undefined;
    const { receiptHash, id: _id, ...unsigned } = receipt;
    if (receiptHash !== sha256(canonicalJson(unsigned))
        || !resultIsCoherent(authority, receipt.request, receipt.result)
        || canonicalJson(receipt.request.sourceIdentity) !== canonicalJson(authority.sourceIdentity())
        || canonicalJson(receipt.request.environment) !== canonicalJson(environment()))
        return undefined;
    return receipt;
}
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
export function readTrustedVerification(authority, reviewFile, wikiRoot, item, receiptId, expectedAction) {
    const receipt = readTrustedReceipt(authority, reviewFile, receiptId);
    if (receipt === undefined || receipt.result.result !== 'pass'
        || receipt.request.governanceAction !== expectedAction || authority === undefined)
        return undefined;
    const path = join(receiptDirectory(reviewFile), `${receiptId}.json`);
    const request = buildVerificationRequest(authority, wikiRoot, item, expectedAction);
    if (request === undefined || canonicalJson(request) !== canonicalJson(receipt.request))
        return undefined;
    const outcomes = receipt.result.outcomes;
    const reference = {
        id: receipt.id,
        path: `verification-receipts/${basename(path)}`,
        receiptHash: receipt.receiptHash,
        environmentHash: sha256(canonicalJson(request.environment)),
        result: 'pass',
        gitCommit: request.sourceIdentity.commit,
    };
    return {
        receipt,
        verification: {
            status: 'passed',
            candidateHash: request.candidateHash,
            action: expectedAction,
            reviewHash: request.reviewHash,
            sourceIdentity: request.sourceIdentity,
            authorityId: receipt.result.authorityId,
            methods: receipt.result.methods,
            evidence: outcomes.flatMap(outcome => outcome.evidence),
            receipts: [reference],
            confidence: 1,
            successCount: outcomes.filter(outcome => outcome.result === 'pass').length,
            failureCount: outcomes.filter(outcome => outcome.result === 'fail').length,
            verifiedBy: 'deterministic-executor',
            lastVerifiedAt: receipt.result.issuedAt,
        },
    };
}
//# sourceMappingURL=verifier.js.map