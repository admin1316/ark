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
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync, writeFileSync, } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { parseFrontmatterArray, parseFrontmatterField } from "./frontmatter-utils.js";
import { deduplicateCandidateAgainstCanonical, mergeCandidateIntoCanonical, replaceCanonicalWithCandidate } from "./canonical-merge.js";
import { decideCandidateGovernance, governancePolicyVersion, resolveGovernedWikiPath } from "./governance-policy.js";
import { assertAbsolutePathInside, atomicWriteFile, durableUnlinkFile, ensureConfinedDirectory, isMissingPathError as isMissingFileError, readOptionalText, readRegularFileBounded, } from "./filesystem.js";
import { canonicalJson, immutableReviewRow, readTrustedReceipt, readTrustedVerification, sha256, } from "./verifier.js";
const REVIEW_OPENER_PREFIX_RE = /^---\s*REVIEW\s*:\s*/i;
const REVIEW_CLOSER_RE = /^---\s*END\s+REVIEW\s*---\s*$/i;
/**
 * Parse `---REVIEW: <type> | <title>---` blocks out of model output. The
 * block body may carry `description:`, `PAGES:` and `SEARCH:` lines; a
 * missing closer discards the block.
 * @param text - the stage-2 generation output.
 * @returns the parsed reviews in output order.
 */
export function parseReviewBlocks(text) {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const reviews = [];
    let current = null;
    for (const line of lines) {
        if (current === null) {
            const opener = parseReviewOpener(line);
            if (opener !== null)
                current = { ...opener, body: [] };
            continue;
        }
        if (REVIEW_CLOSER_RE.test(line)) {
            const body = current.body.join('\n');
            reviews.push({
                type: current.type,
                title: current.title,
                description: extractField(body, 'description'),
                affectedPages: extractListField(body, 'PAGES'),
                searchQueries: extractListField(body, 'SEARCH'),
            });
            current = null;
            continue;
        }
        current.body.push(line);
    }
    return reviews;
}
/** Parse one REVIEW opener while keeping type/title mandatory. */
function parseReviewOpener(line) {
    const prefix = REVIEW_OPENER_PREFIX_RE.exec(line);
    if (prefix === null)
        return null;
    const suffixStart = line.lastIndexOf('---');
    if (suffixStart < prefix[0].length)
        return null;
    const payload = line.slice(prefix[0].length, suffixStart).trim();
    const separator = payload.indexOf('|');
    if (separator < 0)
        return null;
    const type = payload.slice(0, separator).trim() || 'suggestion';
    const title = payload.slice(separator + 1).trim() || 'Review';
    return { type, title };
}
/** First `key: value` line of a field (may span the rest of the body). */
function extractField(body, key) {
    for (const line of body.split('\n')) {
        const field = parseFrontmatterField(line);
        if (field !== null && field.key.toLowerCase() === key.toLowerCase())
            return field.value.trim();
    }
    return '';
}
/** `KEY:` items: a comma-separated inline list or `- item` block lines. */
function extractListField(body, key) {
    let collecting = false;
    const blockItems = [];
    for (const line of body.split('\n')) {
        const field = parseFrontmatterField(line);
        if (field !== null && field.key.toLowerCase() === key.toLowerCase()) {
            if (field.value !== '') {
                return parseFrontmatterArray(field.value.startsWith('[') ? field.value : `[${field.value}]`);
            }
            collecting = true;
            continue;
        }
        if (!collecting)
            continue;
        const item = line.trim();
        if (!item.startsWith('-'))
            break;
        blockItems.push(item);
    }
    return parseFrontmatterArray(blockItems.join('\n'));
}
function resolveCandidateReviewPath(root, input) {
    const governed = resolveGovernedWikiPath(root, input, false);
    return governed?.relativePath.startsWith('_candidates/') === true ? governed : undefined;
}
function resolveCanonicalReviewPath(root, input, allowMissing) {
    const governed = resolveGovernedWikiPath(root, input, allowMissing);
    return governed?.relativePath.startsWith('_candidates/') === true ? undefined : governed;
}
/** Narrow one durable review row before its fields can direct a mutation. */
function isReviewItem(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const id = Reflect.get(value, 'id');
    const title = Reflect.get(value, 'title');
    const type = Reflect.get(value, 'type');
    const resolved = Reflect.get(value, 'resolved');
    return typeof id === 'string' && typeof title === 'string' && typeof type === 'string' && typeof resolved === 'boolean';
}
/** Load the persisted review array through its durable JSON boundary. */
function loadReviewItems(reviewFile) {
    try {
        const parsed = JSON.parse(readRegularFileBounded(reviewFile, 8 * 1024 * 1024).toString('utf8'));
        if (!Array.isArray(parsed) || !parsed.every(isReviewItem))
            throw new Error('invalid knowledge review state');
        return parsed;
    }
    catch (error) {
        if (isMissingPathError(error))
            return undefined;
        throw error;
    }
}
/** Load one review item once, preserving callers' distinct decision policies. */
function loadReviewItem(reviewFile, reviewIdValue) {
    const all = loadReviewItems(reviewFile);
    if (all === undefined)
        return undefined;
    const index = all.findIndex(item => item.id === reviewIdValue);
    const item = index >= 0 ? all[index] : undefined;
    return item === undefined ? undefined : { all, index, item };
}
/** Replace the durable review array atomically after an in-memory batch update. */
function writeReviewItemsAtomically(reviewFile, items) {
    atomicWriteFile(reviewFile, `${JSON.stringify(items, null, 2)}\n`);
}
function isMissingPathError(error) {
    return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT';
}
function pathEntryExists(path) {
    try {
        lstatSync(path);
        return true;
    }
    catch (error) {
        if (isMissingPathError(error))
            return false;
        throw error;
    }
}
function readOptionalRegularFile(path) {
    try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink())
            throw new Error(`unsafe review transaction file: ${path}`);
        return readRegularFileBounded(path, 8 * 1024 * 1024).toString('utf8');
    }
    catch (error) {
        if (isMissingPathError(error))
            return undefined;
        throw error;
    }
}
function promotionOperation(transactionId, index, role, path, before, after) {
    const suffix = `${transactionId}-${index}`;
    return {
        role,
        path,
        ...(before === undefined ? {} : { before }),
        ...(after === undefined ? {} : { after }),
        ...(after === undefined
            ? { tombstonePath: join(dirname(path), `.${basename(path)}.ark-wal-delete-${suffix}`) }
            : { stagingPath: join(dirname(path), `.${basename(path)}.ark-wal-stage-${suffix}`) }),
    };
}
function promotionJournalDirectory(reviewFile) {
    return join(dirname(reviewFile), 'promotion-journal');
}
function promotionJournalPath(reviewFile, id) {
    return join(promotionJournalDirectory(reviewFile), `${id}.json`);
}
function assertPromotionOperationConfined(operation, reviewFile, wikiRoot, archiveRoot) {
    if (operation.role === 'candidate' || operation.role === 'canonical') {
        assertAbsolutePathInside(wikiRoot, operation.path);
    }
    else if (operation.role === 'candidate-archive' || operation.role === 'canonical-archive') {
        assertAbsolutePathInside(archiveRoot, operation.path);
    }
    else {
        assertAbsolutePathInside(dirname(reviewFile), operation.path);
    }
    for (const auxiliary of [operation.stagingPath, operation.tombstonePath]) {
        if (auxiliary === undefined)
            continue;
        if (dirname(auxiliary) !== dirname(operation.path))
            throw new Error('promotion auxiliary path changed parent');
    }
}
function writePromotionStage(path, content) {
    if (pathEntryExists(path)) {
        if (readOptionalText(path, 8 * 1024 * 1024) !== content)
            throw new Error(`promotion stage conflict at ${path}`);
        return;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
        writeFileSync(descriptor, content);
        fsyncSync(descriptor);
    }
    finally {
        closeSync(descriptor);
    }
    const directory = openSync(dirname(path), constants.O_RDONLY);
    try {
        fsyncSync(directory);
    }
    finally {
        closeSync(directory);
    }
}
function applyPromotionOperation(operation, checkpoint) {
    const current = readOptionalText(operation.path, 8 * 1024 * 1024);
    if (operation.after === undefined) {
        const tombstone = operation.tombstonePath;
        if (tombstone === undefined)
            throw new Error('promotion delete lacks a tombstone path');
        if (current === undefined) {
            const moved = readOptionalText(tombstone, 8 * 1024 * 1024);
            if (moved === undefined)
                return;
            if (moved !== operation.before)
                throw new Error(`promotion tombstone conflict at ${tombstone}`);
            unlinkSync(tombstone);
            checkpoint?.('tombstone-unlinked');
            return;
        }
        if (current !== operation.before)
            throw new Error(`promotion recovery conflict at ${operation.path}`);
        if (pathEntryExists(tombstone))
            throw new Error(`promotion tombstone already exists: ${tombstone}`);
        renameSync(operation.path, tombstone);
        checkpoint?.('entry-renamed');
        if (readOptionalText(tombstone, 8 * 1024 * 1024) !== operation.before) {
            throw new Error(`promotion tombstone identity changed: ${tombstone}`);
        }
        unlinkSync(tombstone);
        checkpoint?.('tombstone-unlinked');
        return;
    }
    if (current === operation.after)
        return;
    if (current !== operation.before)
        throw new Error(`promotion recovery conflict at ${operation.path}`);
    const staging = operation.stagingPath;
    if (staging === undefined)
        throw new Error('promotion write lacks a staging path');
    writePromotionStage(staging, operation.after);
    checkpoint?.('stage-written');
    const revalidated = readOptionalText(operation.path, 8 * 1024 * 1024);
    if (revalidated !== operation.before)
        throw new Error(`promotion target changed before rename: ${operation.path}`);
    renameSync(staging, operation.path);
    checkpoint?.('entry-renamed');
}
function rollbackPromotionOperation(operation) {
    if (operation.tombstonePath !== undefined) {
        const tombstone = readOptionalText(operation.tombstonePath, 8 * 1024 * 1024);
        if (tombstone !== undefined) {
            if (tombstone !== operation.before || pathEntryExists(operation.path)) {
                throw new Error(`promotion rollback tombstone conflict at ${operation.tombstonePath}`);
            }
            renameSync(operation.tombstonePath, operation.path);
        }
    }
    const current = readOptionalText(operation.path, 8 * 1024 * 1024);
    if (operation.before === undefined) {
        if (current === undefined) {
            if (operation.stagingPath !== undefined)
                durableUnlinkFile(operation.stagingPath);
            return;
        }
        if (operation.after !== undefined && current !== operation.after) {
            throw new Error(`promotion rollback conflict at ${operation.path}`);
        }
        durableUnlinkFile(operation.path);
        if (operation.stagingPath !== undefined)
            durableUnlinkFile(operation.stagingPath);
        return;
    }
    if (current === operation.before) {
        if (operation.stagingPath !== undefined)
            durableUnlinkFile(operation.stagingPath);
        return;
    }
    if (operation.after !== undefined && current !== operation.after) {
        throw new Error(`promotion rollback conflict at ${operation.path}`);
    }
    atomicWriteFile(operation.path, operation.before);
    if (operation.stagingPath !== undefined)
        durableUnlinkFile(operation.stagingPath);
}
function promotionJournalCore(journal) {
    const { state: _state, seal: _seal, ...core } = journal;
    return core;
}
function validatePromotionJournalAuthority(authority, journal) {
    if (authority === undefined || journal.operationSetHash !== sha256(canonicalJson(journal.operations)))
        return false;
    return authority.validatePromotion(canonicalJson(promotionJournalCore(journal)), journal.seal);
}
function revalidateJournalBeforeMutation(authority, reviewFile, journal) {
    if (!validatePromotionJournalAuthority(authority, journal))
        throw new Error('promotion journal authority validation failed');
    const reviewOperation = journal.operations.find(operation => operation.role === 'review');
    const candidateOperation = journal.operations.find(operation => operation.role === 'candidate');
    if (reviewOperation?.before === undefined || candidateOperation?.before === undefined) {
        throw new Error('promotion journal lacks immutable pre-state');
    }
    const reviews = JSON.parse(reviewOperation.before);
    if (!Array.isArray(reviews))
        throw new Error('promotion journal review pre-state is invalid');
    const item = reviews.find(value => typeof value === 'object' && value !== null && Reflect.get(value, 'id') === journal.reviewId);
    if (item === undefined || item.candidateHash !== journal.candidateHash
        || createHash('sha256').update(candidateOperation.before).digest('hex') !== journal.candidateHash) {
        throw new Error('promotion journal candidate binding failed');
    }
    if (journal.action !== 'Archive') {
        if (journal.receiptId === null || journal.receiptHash === null || journal.reviewHash === null
            || !['Promote', 'Merge', 'Replace', 'Deduplicate'].includes(journal.action)) {
            throw new Error('promotion journal receipt binding is incomplete');
        }
        const receipt = readTrustedReceipt(authority, reviewFile, journal.receiptId);
        if (receipt === undefined
            || receipt.result.result !== 'pass'
            || receipt.receiptHash !== journal.receiptHash
            || receipt.request.reviewHash !== journal.reviewHash
            || receipt.request.reviewHash !== sha256(canonicalJson(immutableReviewRow(item)))
            || receipt.request.governanceAction !== journal.action
            || receipt.request.candidateHash !== journal.candidateHash
            || receipt.request.candidatePath !== item.candidatePath
            || receipt.request.targetPath !== journal.targetPath
            || item.targetPath !== journal.targetPath) {
            throw new Error('promotion journal verified receipt binding failed');
        }
    }
    for (const operation of journal.operations) {
        const current = readOptionalText(operation.path, 8 * 1024 * 1024);
        if (current !== operation.before && current !== operation.after) {
            throw new Error(`promotion journal divergent state at ${operation.path}`);
        }
        if (operation.stagingPath !== undefined) {
            const staged = readOptionalText(operation.stagingPath, 8 * 1024 * 1024);
            if (staged !== undefined && staged !== operation.after) {
                throw new Error(`promotion journal divergent stage at ${operation.stagingPath}`);
            }
        }
        if (operation.tombstonePath !== undefined) {
            const tombstone = readOptionalText(operation.tombstonePath, 8 * 1024 * 1024);
            if (tombstone !== undefined && tombstone !== operation.before) {
                throw new Error(`promotion journal divergent tombstone at ${operation.tombstonePath}`);
            }
        }
    }
}
function commitPromotionJournal(authority, reviewFile, wikiRoot, archiveRoot, journal) {
    revalidateJournalBeforeMutation(authority, reviewFile, journal);
    for (const operation of journal.operations)
        assertPromotionOperationConfined(operation, reviewFile, wikiRoot, archiveRoot);
    ensureConfinedDirectory(dirname(reviewFile), 'promotion-journal');
    const path = promotionJournalPath(reviewFile, journal.id);
    atomicWriteFile(path, `${JSON.stringify(journal, null, 2)}\n`);
    authority?.checkpointPromotion?.(canonicalJson(promotionJournalCore(journal)), {
        phase: 'journal-persisted',
        operationIndex: -1,
    });
    const applied = [];
    let attempted = 0;
    try {
        for (const [operationIndex, operation] of journal.operations.entries()) {
            attempted = operationIndex + 1;
            applyPromotionOperation(operation, (phase) => {
                authority?.checkpointPromotion?.(canonicalJson(promotionJournalCore(journal)), {
                    phase,
                    operationIndex,
                });
            });
            applied.push(operation);
            authority?.checkpointPromotion?.(canonicalJson(promotionJournalCore(journal)), {
                phase: 'operation-applied',
                operationIndex,
            });
        }
        for (const operation of journal.operations) {
            const current = readOptionalText(operation.path, 8 * 1024 * 1024);
            if (current !== operation.after)
                throw new Error(`promotion post-commit mismatch at ${operation.path}`);
        }
        authority?.checkpointPromotion?.(canonicalJson(promotionJournalCore(journal)), {
            phase: 'before-commit-marker',
            operationIndex: journal.operations.length,
        });
        atomicWriteFile(path, `${JSON.stringify({ ...journal, state: 'committed' }, null, 2)}\n`);
    }
    catch (error) {
        const rollbackErrors = [];
        const rollbackOperations = journal.operations.slice(0, Math.max(applied.length, attempted)).reverse();
        for (const operation of rollbackOperations) {
            try {
                rollbackPromotionOperation(operation);
            }
            catch (rollbackError) {
                rollbackErrors.push(rollbackError);
            }
        }
        if (rollbackErrors.length === 0) {
            atomicWriteFile(path, `${JSON.stringify({ ...journal, state: 'rolled-back' }, null, 2)}\n`);
            throw error;
        }
        throw new AggregateError([error, ...rollbackErrors], 'candidate review transaction failed and rollback was incomplete');
    }
}
/**
 * Finish prepared promotions after a crash, or fail closed on divergent bytes.
 * @param authority - Trusted verifier that revalidates the journal before mutation.
 * @param reviewFile - Review file whose sibling directory owns promotion journals.
 * @param wikiRoot - Canonical Wiki root used to confine Candidate and target paths.
 * @param archiveRoot - Archive root used to confine archived Candidate paths.
 * @returns Number of prepared journals completed and marked committed.
 */
export function recoverCandidateReviewTransactions(authority, reviewFile, wikiRoot, archiveRoot) {
    const directory = promotionJournalDirectory(reviewFile);
    let entries;
    try {
        const stat = lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new Error('unsafe promotion journal directory');
        entries = readdirSync(directory).filter(name => name.endsWith('.json')).sort();
    }
    catch (error) {
        if (isMissingFileError(error))
            return 0;
        throw error;
    }
    let recovered = 0;
    for (const name of entries) {
        const path = join(directory, name);
        const raw = JSON.parse(readRegularFileBounded(path, 8 * 1024 * 1024).toString('utf8'));
        if (typeof raw !== 'object' || raw === null || Reflect.get(raw, 'schemaVersion') !== 1)
            continue;
        const journal = raw;
        if (!/^[A-Za-z0-9._:-]+$/u.test(journal.id) || journal.state !== 'prepared' || !Array.isArray(journal.operations))
            continue;
        revalidateJournalBeforeMutation(authority, reviewFile, journal);
        for (const operation of journal.operations)
            assertPromotionOperationConfined(operation, reviewFile, wikiRoot, archiveRoot);
        for (const operation of journal.operations)
            applyPromotionOperation(operation);
        atomicWriteFile(path, `${JSON.stringify({ ...journal, state: 'committed' }, null, 2)}\n`);
        recovered += 1;
    }
    return recovered;
}
/**
 * Classify all requested rows, then atomically resolve the eligible advisory subset once.
 * @param reviewFile - absolute review JSON path.
 * @param reviewIds - review ids requested by the caller.
 * @param action - persisted resolution action.
 * @returns resolved advisory count and candidate ids for the candidate owner.
 */
export function resolveAdvisoryReviewBatch(reviewFile, reviewIds, action) {
    const all = loadReviewItems(reviewFile);
    if (all === undefined)
        return { resolvedCount: 0, candidateIds: [] };
    const requested = new Set(reviewIds);
    const classified = new Set();
    const candidateIds = [];
    let resolvedCount = 0;
    for (const [index, item] of all.entries()) {
        if (!requested.has(item.id) || classified.has(item.id))
            continue;
        classified.add(item.id);
        if (item.reviewKind === 'candidate') {
            candidateIds.push(item.id);
            continue;
        }
        if (item.resolved)
            continue;
        all[index] = { ...item, resolved: true, resolvedAction: action };
        resolvedCount += 1;
    }
    if (resolvedCount > 0)
        writeReviewItemsAtomically(reviewFile, all);
    return { resolvedCount, candidateIds };
}
/**
 * Resolve persisted non-candidate review items while preserving the count-only caller contract.
 * @param reviewFile - absolute review JSON path.
 * @param reviewIds - review identifiers requested by the caller.
 * @param action - resolution action to persist for eligible advisory rows.
 * @returns the number of advisory rows resolved.
 */
export function resolveAdvisoryReviews(reviewFile, reviewIds, action) {
    return resolveAdvisoryReviewBatch(reviewFile, reviewIds, action).resolvedCount;
}
function readReviewItems(reviewFile) {
    try {
        const parsed = JSON.parse(readRegularFileBounded(reviewFile, 8 * 1024 * 1024).toString('utf8'));
        if (!Array.isArray(parsed) || !parsed.every(isReviewItem))
            throw new Error('invalid knowledge review state');
        return parsed;
    }
    catch (error) {
        if (!isMissingPathError(error))
            throw error;
        return [];
    }
}
/**
 * Append reviews to the review file, deduped by deterministic id. The file
 * is an append-only JSON array; a malformed existing file is rebuilt with
 * only the new reviews (the unparseable content is already unreadable).
 * @param reviewFile - absolute path of `.llm-wiki/review.json`.
 * @param sourcePath - absolute path of the source that produced the reviews.
 * @param reviews - parsed reviews to persist.
 * @returns how many reviews were newly appended.
 */
export function appendReviews(reviewFile, sourcePath, reviews) {
    if (reviews.length === 0)
        return 0;
    const existing = readReviewItems(reviewFile);
    const now = Date.now();
    const byId = new Map(existing.map(item => [item.id, item]));
    let appended = 0;
    for (const review of reviews) {
        const id = reviewId(review);
        if (byId.has(id))
            continue;
        byId.set(id, {
            id,
            title: review.title,
            type: review.type,
            ...(review.description === '' ? {} : { description: review.description }),
            sourcePath,
            affectedPages: review.affectedPages,
            options: [
                { action: 'Skip', label: 'Skip' },
            ],
            reviewKind: 'advisory',
            resolved: false,
            createdAt: now,
            searchQueries: review.searchQueries,
        });
        appended += 1;
    }
    writeReviewItemsAtomically(reviewFile, [...byId.values()]);
    return appended;
}
/**
 * Register written candidate pages as real, hash-bound approval items.
 * @param reviewFile - The review file input.
 * @param projectRoot - The project root input.
 * @param sourcePath - The source path input.
 * @param writtenPaths - The written paths input.
 * @returns The value produced by append candidate reviews.
 */
export function appendCandidateReviews(reviewFile, projectRoot, sourcePath, writtenPaths) {
    const existing = readReviewItems(reviewFile);
    const byId = new Map(existing.map(item => [item.id, item]));
    let changed = 0;
    for (const writtenPath of writtenPaths) {
        const candidate = resolveCandidateReviewPath(join(projectRoot, 'wiki'), writtenPath.replace(/^wiki\//u, ''));
        if (candidate === undefined)
            continue;
        const candidatePath = candidate.relativePath;
        const content = readRegularFileBounded(candidate.absolutePath, 5 * 1024 * 1024).toString('utf8');
        const candidateHash = createHash('sha256').update(content).digest('hex');
        const id = `candidate-${createHash('sha256').update(candidatePath).digest('hex').slice(0, 16)}`;
        const title = (/^title:\s*(.+)$/mu.exec(content)?.[1] ?? basename(candidatePath, '.md'))
            .trim()
            .replace(/^["']|["']$/gu, '');
        const suggestedTarget = canonicalTarget(candidatePath);
        const governance = decideCandidateGovernance(join(projectRoot, 'wiki'), candidatePath, content, suggestedTarget);
        const targetPath = governance.targetPath;
        const prior = byId.get(id);
        if (prior?.candidateHash === candidateHash && !prior.resolved)
            continue;
        byId.set(id, {
            id,
            title,
            type: 'candidate-approval',
            description: `候选：${candidatePath}${targetPath ? ` → ${targetPath}` : '（自治隔离）'}；自治决定：${governance.action}；置信度：${governance.confidence.toFixed(2)}；评分：${governance.score}/10；${governance.reasons.join('；')}`,
            sourcePath,
            affectedPages: [candidatePath],
            options: [{ action: 'Archive', label: '归档候选' }],
            resolved: false,
            createdAt: Date.now(),
            reviewKind: 'candidate',
            candidatePath,
            candidateHash,
            verification: {
                status: 'pending',
                candidateHash,
                methods: [],
                evidence: [],
                receipts: [],
                confidence: 0,
                successCount: 0,
                failureCount: 0,
            },
            ...(targetPath ? { targetPath } : {}),
        });
        changed += 1;
    }
    if (changed > 0) {
        writeReviewItemsAtomically(reviewFile, [...byId.values()]);
    }
    return changed;
}
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
export function recordCandidateVerification(authority, reviewFile, wikiRoot, reviewIdValue, receiptId, action) {
    if (typeof receiptId !== 'string' || action === undefined)
        return false;
    const loaded = loadReviewItem(reviewFile, reviewIdValue);
    if (loaded === undefined)
        return false;
    const { all, index, item } = loaded;
    if (item.reviewKind !== 'candidate' || item.resolved || !item.candidatePath || !item.candidateHash)
        return false;
    const candidate = resolveCandidateReviewPath(wikiRoot, item.candidatePath);
    if (candidate === undefined)
        return false;
    const actualHash = createHash('sha256')
        .update(readRegularFileBounded(candidate.absolutePath, 5 * 1024 * 1024))
        .digest('hex');
    if (actualHash !== item.candidateHash)
        return false;
    const trusted = readTrustedVerification(authority, reviewFile, wikiRoot, item, receiptId, action);
    if (trusted === undefined)
        return false;
    const nextVerification = trusted.verification;
    all[index] = {
        ...item,
        verification: nextVerification,
        options: nextVerification.status === 'passed'
            ? candidateActions(wikiRoot, item.targetPath).filter(option => option.action === action || option.action === 'Archive')
            : [{ action: 'Archive', label: '归档候选' }],
    };
    writeReviewItemsAtomically(reviewFile, all);
    appendGovernanceLog(reviewFile, {
        timestamp: new Date().toISOString(),
        policyVersion: governancePolicyVersion(),
        reviewId: reviewIdValue,
        action: 'Verify',
        actor: nextVerification.verifiedBy ?? 'unverified',
        outcome: nextVerification.status,
        candidateHash: actualHash,
        methods: nextVerification.methods,
        evidence: nextVerification.evidence,
        receipts: nextVerification.receipts.map(receipt => ({
            id: receipt.id,
            receiptHash: receipt.receiptHash,
            environmentHash: receipt.environmentHash,
            result: receipt.result,
            gitCommit: receipt.gitCommit,
        })),
        confidence: nextVerification.confidence,
    });
    return true;
}
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
export function applyCandidateReview(authority, reviewFile, projectRoot, wikiRoot, archiveRoot, reviewIdValue, action, actor = 'human') {
    if (authority === undefined)
        return false;
    const loaded = loadReviewItem(reviewFile, reviewIdValue);
    if (loaded === undefined)
        return false;
    const { all, index, item } = loaded;
    if (item.reviewKind !== 'candidate')
        return null;
    if (item.resolved || !item.candidatePath || !item.candidateHash)
        return false;
    const candidate = resolveCandidateReviewPath(wikiRoot, item.candidatePath);
    if (candidate === undefined)
        return false;
    const content = readRegularFileBounded(candidate.absolutePath, 5 * 1024 * 1024).toString('utf8');
    const actualHash = createHash('sha256').update(content).digest('hex');
    if (actualHash !== item.candidateHash)
        return false;
    const canonicalActions = new Set(['Promote', 'Merge', 'Replace', 'Deduplicate']);
    let verifiedReceipt;
    if (canonicalActions.has(action)) {
        const verification = item.verification;
        if (actor === 'governance-agent')
            return false;
        if (!verification || verification.status !== 'passed' || verification.candidateHash !== actualHash)
            return false;
        if (verification.action !== action)
            return false;
        const receiptId = verification.receipts.length === 1 ? verification.receipts[0]?.id : undefined;
        if (receiptId === undefined)
            return false;
        const trusted = readTrustedVerification(authority, reviewFile, wikiRoot, item, receiptId, action);
        if (trusted === undefined
            || trusted.verification.receipts[0]?.receiptHash !== verification.receipts[0]?.receiptHash)
            return false;
        verifiedReceipt = trusted.receipt;
    }
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const resolvedAt = now.getTime();
    let appliedPath = '';
    let previousCanonicalHash = '';
    let targetPath = '';
    let targetAbsolutePath = '';
    let targetBefore;
    let targetAfter;
    let archivedCanonical = '';
    let archivedCanonicalContent = '';
    if (action === 'Merge' || action === 'Replace' || action === 'Deduplicate') {
        if (!item.targetPath)
            return false;
        const target = resolveCanonicalReviewPath(wikiRoot, item.targetPath, false);
        if (target === undefined)
            return false;
        const canonicalBefore = readRegularFileBounded(target.absolutePath, 5 * 1024 * 1024).toString('utf8');
        const approvedAt = new Date().toISOString();
        const next = action === 'Merge'
            ? mergeCandidateIntoCanonical(canonicalBefore, content, approvedAt)
            : action === 'Deduplicate'
                ? deduplicateCandidateAgainstCanonical(canonicalBefore, content, approvedAt, actor)
                : replaceCanonicalWithCandidate(canonicalBefore, content, approvedAt);
        const canonicalHash = createHash('sha256').update(canonicalBefore).digest('hex');
        previousCanonicalHash = canonicalHash;
        archivedCanonicalContent = canonicalBefore;
        archivedCanonical = join(archiveRoot, 'wiki-governance', today, basename(projectRoot), canonicalHash.slice(0, 12), 'canonical-before-update', target.relativePath);
        targetBefore = canonicalBefore;
        targetAfter = target.relativePath.startsWith('_evidence/')
            ? stampEvidence(next.content, today, actor)
            : next.content;
        targetAbsolutePath = target.absolutePath;
        targetPath = target.relativePath;
        appliedPath = target.relativePath;
    }
    else if (action === 'Promote') {
        if (!item.targetPath)
            return false;
        const target = resolveCanonicalReviewPath(wikiRoot, item.targetPath, true);
        if (target === undefined || pathEntryExists(target.absolutePath))
            return false;
        targetAfter = target.relativePath.startsWith('_evidence/')
            ? stampEvidence(content, today, actor)
            : stampCanonical(content, today, actor);
        targetAbsolutePath = target.absolutePath;
        targetPath = target.relativePath;
        appliedPath = target.relativePath;
    }
    else if (action !== 'Archive' && action !== 'Skip') {
        return false;
    }
    const archived = join(archiveRoot, 'wiki-governance', today, basename(projectRoot), actualHash.slice(0, 12), candidate.relativePath);
    if (!appliedPath)
        appliedPath = archived;
    const resolvedItems = [...all];
    resolvedItems[index] = {
        ...item,
        resolved: true,
        resolvedAction: action === 'Promote' || action === 'Merge' || action === 'Replace' || action === 'Deduplicate' ? action : 'Archive',
        appliedPath,
        resolvedAt,
    };
    const governanceEntry = {
        timestamp: now.toISOString(),
        policyVersion: governancePolicyVersion(),
        reviewId: reviewIdValue,
        action,
        actor,
        outcome: 'applied',
        candidateHash: actualHash,
        previousCanonicalHash,
        targetPath: item.targetPath ?? '',
        appliedPath,
    };
    const governanceLog = join(dirname(reviewFile), 'governance.jsonl');
    const reviewBefore = readRegularFileBounded(reviewFile, 8 * 1024 * 1024).toString('utf8');
    const governanceLogBefore = readOptionalRegularFile(governanceLog);
    const reviewAfter = JSON.stringify(resolvedItems, null, 2);
    const governanceLogAfter = `${governanceLogBefore ?? ''}${JSON.stringify(governanceEntry)}\n`;
    if (targetAfter !== undefined) {
        const revalidatedTarget = resolveCanonicalReviewPath(wikiRoot, targetPath, targetBefore === undefined);
        if (revalidatedTarget === undefined || revalidatedTarget.absolutePath !== targetAbsolutePath) {
            throw new Error(`canonical target changed during review transaction: ${targetPath}`);
        }
        if (targetBefore === undefined) {
            if (pathEntryExists(targetAbsolutePath)) {
                throw new Error(`canonical target appeared during review transaction: ${targetPath}`);
            }
        }
        else if (readRegularFileBounded(targetAbsolutePath, 5 * 1024 * 1024).toString('utf8') !== targetBefore) {
            throw new Error(`canonical target changed during review transaction: ${targetPath}`);
        }
    }
    const revalidatedCandidate = resolveCandidateReviewPath(wikiRoot, item.candidatePath);
    if (revalidatedCandidate === undefined || revalidatedCandidate.absolutePath !== candidate.absolutePath) {
        throw new Error(`candidate path changed during review transaction: ${item.candidatePath}`);
    }
    const currentCandidate = readRegularFileBounded(candidate.absolutePath, 5 * 1024 * 1024).toString('utf8');
    if (createHash('sha256').update(currentCandidate).digest('hex') !== actualHash) {
        throw new Error(`candidate content changed during review transaction: ${item.candidatePath}`);
    }
    if (readRegularFileBounded(reviewFile, 8 * 1024 * 1024).toString('utf8') !== reviewBefore) {
        throw new Error('review state changed during review transaction');
    }
    if (readOptionalRegularFile(governanceLog) !== governanceLogBefore) {
        throw new Error('governance log changed during review transaction');
    }
    if (pathEntryExists(archived))
        throw new Error(`candidate archive already exists: ${archived}`);
    if (archivedCanonical !== '' && pathEntryExists(archivedCanonical)) {
        throw new Error(`canonical archive already exists: ${archivedCanonical}`);
    }
    const transactionId = `promotion-${createHash('sha256')
        .update(`${reviewIdValue}\0${actualHash}\0${resolvedAt}`)
        .digest('hex')
        .slice(0, 24)}`;
    const operations = [];
    if (archivedCanonical !== '') {
        operations.push(promotionOperation(transactionId, operations.length, 'canonical-archive', archivedCanonical, undefined, archivedCanonicalContent));
    }
    operations.push(promotionOperation(transactionId, operations.length, 'candidate-archive', archived, undefined, currentCandidate));
    if (targetAfter !== undefined) {
        operations.push(promotionOperation(transactionId, operations.length, 'canonical', targetAbsolutePath, targetBefore, targetAfter));
    }
    operations.push(promotionOperation(transactionId, operations.length, 'review', reviewFile, reviewBefore, reviewAfter), promotionOperation(transactionId, operations.length + 1, 'governance', governanceLog, governanceLogBefore, governanceLogAfter), promotionOperation(transactionId, operations.length + 2, 'candidate', candidate.absolutePath, currentCandidate, undefined));
    const core = {
        schemaVersion: 1,
        id: transactionId,
        reviewId: reviewIdValue,
        candidateHash: actualHash,
        createdAt: now.toISOString(),
        action: canonicalActions.has(action) ? action : 'Archive',
        targetPath: item.targetPath ?? null,
        reviewHash: verifiedReceipt?.request.reviewHash ?? null,
        receiptId: verifiedReceipt?.id ?? null,
        receiptHash: verifiedReceipt?.receiptHash ?? null,
        operationSetHash: sha256(canonicalJson(operations)),
        operations,
    };
    const seal = authority.sealPromotion(canonicalJson(core));
    if (seal.authorityId !== authority.authorityId || seal.proof === '')
        return false;
    commitPromotionJournal(authority, reviewFile, wikiRoot, archiveRoot, {
        ...core,
        state: 'prepared',
        seal,
    });
    return true;
}
function canonicalTarget(candidatePath) {
    if (candidatePath.startsWith('_candidates/sessions/'))
        return `concepts/${basename(candidatePath)}`;
    if (candidatePath.startsWith('_candidates/research/'))
        return `_evidence/research/${basename(candidatePath)}`;
    if (candidatePath.startsWith('_candidates/ingest/')) {
        const rel = candidatePath.slice('_candidates/ingest/'.length);
        if (/^(concepts|entities|findings|research|methodology)\//u.test(rel))
            return rel;
    }
    return undefined;
}
function candidateActions(wikiRoot, targetPath) {
    if (!targetPath)
        return [{ action: 'Archive', label: '归档候选' }];
    const target = resolveCanonicalReviewPath(wikiRoot, targetPath, true);
    if (target === undefined)
        return [{ action: 'Archive', label: '归档候选' }];
    if (existsSync(target.absolutePath)) {
        return [
            { action: 'Deduplicate', label: '保留正式页并去重' },
            { action: 'Merge', label: '合并更完整版本' },
            { action: 'Replace', label: '用候选替换' },
            { action: 'Archive', label: '归档候选' },
        ];
    }
    return [{ action: 'Promote', label: '批准入库' }, { action: 'Archive', label: '归档候选' }];
}
function stampCanonical(content, today, approvedBy) {
    let output = content;
    if (/^status:\s*/mu.test(output))
        output = output.replace(/^status:\s*.*$/mu, 'status: canonical');
    else
        output = output.replace(/^---\n/u, '---\nstatus: canonical\n');
    output = output.replace(/^approved_at:\s*.*\n?/mu, '');
    output = output.replace(/^approved_by:\s*.*\n?/mu, '');
    return output.replace(/^---\n/u, `---\napproved_at: ${today}\napproved_by: ${approvedBy}\n`);
}
function stampEvidence(content, today, approvedBy) {
    return stampCanonical(content, today, approvedBy).replace(/^status:\s*canonical$/mu, 'status: evidence');
}
function appendGovernanceLog(reviewFile, entry) {
    const logFile = join(dirname(reviewFile), 'governance.jsonl');
    const prior = readOptionalRegularFile(logFile) ?? '';
    atomicWriteFile(logFile, `${prior}${JSON.stringify(entry)}\n`);
}
/** Deterministic review id: `review-` + FNV-1a hex over type/title/description. */
function reviewId(review) {
    const source = `${review.type}\u0000${review.title}\u0000${review.description}`;
    let hash = 0x811c9dc5;
    for (let i = 0; i < source.length; i += 1) {
        hash ^= source.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return `review-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
//# sourceMappingURL=reviews.js.map