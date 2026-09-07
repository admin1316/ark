import { Service } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, normalize, posix, relative, resolve, sep, win32 } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import "@deepseek-ai/dsh-llm";
import "zod";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:http";
import { request as request$1 } from "node:https";
//#region lib/types/frontmatter-utils.js
/**
* Frontmatter array parsing/writing and `sources`-field canonicalization.
*
* Wiki pages carry frontmatter arrays in two shapes: JSON-style quoted
* inline lists (`sources: ["a", "b"]`) and unquoted bare lists
* (`related: [a, b]`). The `sources` field is written back in the quoted
* inline form, matching the existing pages, after normalization and
* mandatory inclusion of the ingesting source's identity.
* @module @deepseek-ai/dsh-knowledge-wiki/frontmatter-utils
*/
const RAW_SOURCES_PREFIX$1 = "raw/sources/";
/**
* Parse one leading frontmatter block without optional regex captures.
* @param content - complete page content.
* @returns exact block slices, or null when no complete leading block exists.
*/
function parseFrontmatterBlock(content) {
	const openerEnd = content.indexOf("\n");
	if (openerEnd < 0) return null;
	const openerLine = content.slice(0, openerEnd).replace(/\r$/u, "");
	if (!/^---[ \t]*$/u.test(openerLine)) return null;
	const lineBreak = content.charAt(openerEnd - 1) === "\r" ? "\r\n" : "\n";
	const bodyStart = openerEnd + 1;
	let lineStart = bodyStart;
	while (lineStart < content.length) {
		const lineFeed = content.indexOf("\n", lineStart);
		const lineEnd = lineFeed < 0 ? content.length : lineFeed;
		const rawLine = content.slice(lineStart, lineEnd);
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (/^---[ \t]*$/u.test(line)) {
			const bodyEnd = Math.max(bodyStart, lineStart - lineBreak.length);
			const closingEnd = lineFeed < 0 ? lineEnd : lineFeed + 1;
			return {
				prefix: content.slice(0, bodyStart),
				body: content.slice(bodyStart, bodyEnd),
				suffix: content.slice(bodyEnd, closingEnd),
				rest: content.slice(closingEnd),
				lineBreak
			};
		}
		if (lineFeed < 0) break;
		lineStart = lineFeed + 1;
	}
	return null;
}
/**
* Parse one frontmatter field line without optional regex captures.
* @param line - one frontmatter line.
* @returns validated key/value and spacing slices, or null for non-fields.
*/
function parseFrontmatterField(line) {
	const colon = line.indexOf(":");
	if (colon <= 0) return null;
	const before = line.slice(0, colon);
	const key = before.trim();
	if (!/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(key)) return null;
	const keyStart = before.indexOf(key);
	const rawValue = line.slice(colon + 1);
	const valueStart = rawValue.length - rawValue.trimStart().length;
	return {
		indentation: before.slice(0, keyStart),
		key,
		beforeColon: before.slice(keyStart + key.length),
		afterColon: rawValue.slice(0, valueStart),
		value: rawValue.slice(valueStart)
	};
}
/**
* Render a parsed field with one canonical space after its colon.
* @param field - parsed key and preserved indentation/colon prefix.
* @param value - replacement field value.
* @returns the canonicalized frontmatter line.
*/
function renderCanonicalFrontmatterField(field, value) {
	return `${field.indentation}${field.key}${field.beforeColon}: ${value}`;
}
/**
* Render a parsed field while preserving its original colon spacing.
* @param field - parsed key and original indentation/colon spacing.
* @param value - replacement field value.
* @returns the spacing-preserving frontmatter line.
*/
function renderPreservedFrontmatterField(field, value) {
	return `${field.indentation}${field.key}${field.beforeColon}:${field.afterColon}${value}`;
}
/**
* Parse the value of a frontmatter array field into its string items.
* Handles quoted strings containing commas and bare unquoted items;
* tolerates a YAML block-list shape (`- item` lines) as well.
* @param value - the raw field value text (between `[` and `]`, or block items).
* @returns the extracted items, unquoted and trimmed.
*/
function parseFrontmatterArray(value) {
	const trimmed = value.trim();
	if (trimmed === "" || trimmed === "[]") return [];
	if (trimmed.startsWith("[")) {
		const closeIndex = trimmed.lastIndexOf("]");
		return splitQuoted(closeIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, closeIndex));
	}
	return trimmed.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("-")).map((line) => line.slice(1).trim().replace(/^["']|["']$/gu, "")).filter(Boolean);
}
/**
* Split a comma-separated array body on commas that are not inside
* double-quoted strings, then unquote and trim each item.
* @param body - the text between the outer brackets.
* @returns the items.
*/
function splitQuoted(body) {
	const items = [];
	let current = "";
	let inQuote = false;
	for (const ch of body) {
		if (ch === "\"") {
			inQuote = !inQuote;
			current += ch;
			continue;
		}
		if (ch === "," && !inQuote) {
			items.push(current.trim());
			current = "";
			continue;
		}
		current += ch;
	}
	if (current.trim() !== "") items.push(current.trim());
	return items.map(unquote).filter((item) => item !== "");
}
/** Strip one layer of double or single quotes around an item. */
function unquote(item) {
	const s = item.trim();
	if (s.length >= 2) {
		const first = s[0];
		const last = s[s.length - 1];
		if (first === "\"" && last === "\"") return s.slice(1, -1);
		if (first === "'" && last === "'") return s.slice(1, -1);
	}
	return s;
}
/**
* Format items as a quoted inline JSON array (`["a", "b"]`).
* @param items - the items to write.
* @returns the formatted array text.
*/
function formatFrontmatterArray(items) {
	return `[${items.map((item) => JSON.stringify(item)).join(", ")}]`;
}
/**
* Canonicalize a `sources` field value: parse, drop invalid references
* (empty, wikilink-shaped, or path-traversing), normalize each item to
* the identity form (stripping a `raw/sources/` prefix), force-include
* the current source identity, dedupe while preserving order, and
* re-serialize in the quoted inline form.
* @param rawValue - the raw field value from generated content.
* @param currentIdentity - the ingesting source's identity to force in.
* @returns the canonical serialized array text.
*/
function canonicalizeSourcesField(rawValue, currentIdentity) {
	const items = [...new Set(parseFrontmatterArray(rawValue).map(normalizeSourceReference).filter(isValidSourceReference))];
	const identity = normalizeSourceReference(currentIdentity);
	if (isValidSourceReference(identity) && !items.includes(identity)) items.push(identity);
	return formatFrontmatterArray(items);
}
/**
* Rewrite the `sources` field of a page's frontmatter block to its
* canonical form (see {@link canonicalizeSourcesField}). A page without a
* frontmatter block, or without a `sources` line, is returned unchanged.
* @param content - page content.
* @param currentIdentity - the ingesting source identity.
* @returns the content with a canonicalized sources field.
*/
function stampSourcesField(content, currentIdentity) {
	const block = parseFrontmatterBlock(content);
	if (block === null) return content;
	const stamped = block.body.split(/\r?\n/u).map((line) => {
		const field = parseFrontmatterField(line);
		if (field?.key !== "sources") return line;
		return renderCanonicalFrontmatterField(field, canonicalizeSourcesField(field.value, currentIdentity));
	}).join(block.lineBreak);
	if (stamped === block.body) return content;
	return block.prefix + stamped + block.suffix + block.rest;
}
/** Strip a `raw/sources/` prefix (case-insensitive) and stray quoting. */
function normalizeSourceReference(reference) {
	let ref = reference.trim();
	if (ref.toLowerCase().startsWith(RAW_SOURCES_PREFIX$1.toLowerCase())) ref = ref.slice(12);
	return ref;
}
/** A source reference is usable when it names a real path: non-empty, no
* wikilink shape, no traversal, no spaces-then-nothing oddity. */
function isValidSourceReference(reference) {
	if (reference === "") return false;
	if (reference.includes("[[") || reference.includes("]]")) return false;
	if (reference.includes("..")) return false;
	return !/^\s*$/.test(reference);
}
//#endregion
//#region lib/types/filesystem.js
/**
* Confined, crash-safe filesystem primitives shared by Knowledge Wiki.
* @module @deepseek-ai/dsh-knowledge-wiki/filesystem
*/
/** Default maximum for one Wiki Markdown page. */
const MAX_WIKI_PAGE_BYTES = 5 * 1024 * 1024;
/**
* Distinguish an absent optional file from corruption or unsafe I/O.
* @param error - Caught value to inspect for Node's missing-path error code.
* @returns True only for a non-null object whose code property is ENOENT.
*/
function isMissingPathError$2(error) {
	return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";
}
/**
* Return a normalized root-relative path without repairing unsafe input.
* @param input - Nonempty slash-separated relative path with no empty, dot, or parent segments.
* @returns Accepted path with its segments preserved.
* @throws On a leading slash, NUL, backslash, or invalid path segment.
*/
function normalizeConfinedRelativePath(input) {
	if (input === "" || input.includes("\0") || input.includes("\\") || input.startsWith("/")) throw new Error("invalid confined path");
	const parts = input.split("/");
	if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error("path traversal is not allowed");
	return parts.join("/");
}
/**
* Resolve a path and reject any existing symbolic-link ancestor.
* @param root - Existing ordinary directory used as the confinement root.
* @param input - Slash-separated path below root, validated without repairing traversal.
* @param allowMissingLeaf - Whether the unresolved suffix may be absent, including missing parent directories.
* @returns Absolute target after checking existing components and the nearest ancestor's realpath; creates nothing.
* @throws On unsafe paths, symlinks, non-directory ancestors, disallowed absence, or other filesystem failures.
*/
function resolveConfinedPath(root, input, allowMissingLeaf) {
	const rel = normalizeConfinedRelativePath(input);
	const base = resolve(root);
	const target = resolve(base, ...rel.split("/"));
	if (!target.startsWith(`${base}${sep}`)) throw new Error("path escapes configured root");
	const rootStat = lstatSync(base);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("configured root is not an ordinary directory");
	const rootReal = realpathSync(base);
	let cursor = base;
	for (const [index, part] of rel.split("/").entries()) {
		cursor = join(cursor, part);
		try {
			const stat = lstatSync(cursor);
			if (stat.isSymbolicLink()) throw new Error(`symbolic link is not allowed: ${cursor}`);
			if (index < rel.split("/").length - 1 && !stat.isDirectory()) throw new Error(`non-directory path ancestor: ${cursor}`);
		} catch (error) {
			if (!isMissingPathError$2(error) || !allowMissingLeaf) throw error;
			break;
		}
	}
	const ancestorReal = realpathSync(nearestExistingAncestor(target));
	if (ancestorReal !== rootReal && !ancestorReal.startsWith(`${rootReal}${sep}`)) throw new Error("path realpath escapes configured root");
	return target;
}
function nearestExistingAncestor(path) {
	let cursor = path;
	while (!existsSync(cursor)) {
		const parent = dirname(cursor);
		if (parent === cursor) throw new Error("no existing path ancestor");
		cursor = parent;
	}
	return cursor;
}
/**
* Create a confined directory hierarchy without following symbolic links.
* @param root - Existing ordinary directory under which each path component is checked.
* @param input - Slash-separated relative directory path; missing components are created with mode 0700.
* @returns Absolute directory path after existing and newly created components pass the checks.
* @throws On invalid paths, symlink/non-directory components, or filesystem failures; earlier creations remain.
*/
function ensureConfinedDirectory(root, input) {
	const rel = normalizeConfinedRelativePath(input);
	const base = resolve(root);
	const rootStat = lstatSync(base);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("configured root is not an ordinary directory");
	let cursor = base;
	for (const part of rel.split("/")) {
		cursor = join(cursor, part);
		try {
			const stat = lstatSync(cursor);
			if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe directory path: ${cursor}`);
		} catch (error) {
			if (!isMissingPathError$2(error)) throw error;
			mkdirSync(cursor, { mode: 448 });
			const created = lstatSync(cursor);
			if (!created.isDirectory() || created.isSymbolicLink()) throw new Error(`unsafe created directory: ${cursor}`);
		}
	}
	return cursor;
}
function ensureAbsoluteDirectory(path) {
	const absolute = resolve(path);
	mkdirSync(absolute, {
		recursive: true,
		mode: 448
	});
	const stat = lstatSync(absolute);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe directory path: ${absolute}`);
	return absolute;
}
function assertOrdinaryDestination(path) {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`unsafe file destination: ${path}`);
	} catch (error) {
		if (!isMissingPathError$2(error)) throw error;
	}
}
function sameFileIdentity(left, right) {
	return left.dev === right.dev && left.ino === right.ino;
}
/**
* Read one ordinary file with O_NOFOLLOW and a hard byte ceiling.
* @param path - File path; the leaf must be an ordinary file with exactly one hard link.
* @param maxBytes - Maximum byte size checked both before reading and as chunks arrive.
* @returns Complete bytes after checking file identity, size, modification time, and link count for changes.
* @throws On unsafe or changed files, excess size, or filesystem failures; the opened descriptor is closed.
*/
function readRegularFileBounded(path, maxBytes) {
	const before = lstatSync(path);
	if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error(`not a unique ordinary file: ${path}`);
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(descriptor);
		if (!stat.isFile() || stat.nlink !== 1 || !sameFileIdentity(before, stat)) throw new Error(`file identity changed while opening: ${path}`);
		if (stat.size > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes: ${path}`);
		const chunks = [];
		let total = 0;
		while (true) {
			const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
			const count = readSync(descriptor, chunk, 0, chunk.length, null);
			if (count === 0) break;
			total += count;
			if (total > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes: ${path}`);
			chunks.push(chunk.subarray(0, count));
		}
		const afterRead = fstatSync(descriptor);
		const afterPath = lstatSync(path);
		if (!sameFileIdentity(stat, afterRead) || !sameFileIdentity(stat, afterPath) || afterRead.size !== stat.size || afterRead.mtimeMs !== stat.mtimeMs || afterPath.nlink !== 1) throw new Error(`file changed while reading: ${path}`);
		return Buffer.concat(chunks, total);
	} finally {
		closeSync(descriptor);
	}
}
/**
* Atomically replace one file and durably publish both bytes and directory entry.
* File fsync precedes rename; published identity is checked before the parent directory is fsynced.
* @param path - Destination, absent or an ordinary single-link file; missing parent directories are created.
* @param content - UTF-8 text or exact bytes to stage in a sibling temporary file.
* @param mode - Staged file creation mode, subject to umask; defaults to 0600 and replaces the old file's mode.
* @throws On unsafe destinations, identity mismatch, or I/O failure; errors after rename may leave new bytes visible.
*/
function atomicWriteFile(path, content, mode = 384) {
	const parent = ensureAbsoluteDirectory(dirname(path));
	assertOrdinaryDestination(path);
	const temporary = join(parent, `.${basename(path)}.ark-save-${process.pid}-${randomUUID()}`);
	let descriptor;
	let stagedIdentity;
	try {
		descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
		writeFileSync(descriptor, content);
		fsyncSync(descriptor);
		stagedIdentity = fstatSync(descriptor);
		closeSync(descriptor);
		descriptor = void 0;
		assertOrdinaryDestination(path);
		renameSync(temporary, path);
		const published = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const publishedIdentity = fstatSync(published);
			if (!publishedIdentity.isFile() || publishedIdentity.nlink !== 1 || !sameFileIdentity(stagedIdentity, publishedIdentity)) throw new Error(`published file identity mismatch: ${path}`);
		} finally {
			closeSync(published);
		}
		const directory = openSync(parent, constants.O_RDONLY);
		try {
			fsyncSync(directory);
		} finally {
			closeSync(directory);
		}
	} finally {
		if (descriptor !== void 0) closeSync(descriptor);
		if (existsSync(temporary)) unlinkSync(temporary);
	}
}
/**
* Durably remove one ordinary file without following a symbolic link.
* The file is renamed to a sibling tombstone and its identity checked before unlink and directory fsync.
* @param path - Single-link ordinary file to remove; absence at the initial stat or open is a no-op.
* @throws On an unsafe file, changed identity, or I/O failure; a later failure may leave a tombstone or removed file.
*/
function durableUnlinkFile(path) {
	let stat;
	try {
		stat = lstatSync(path);
	} catch (error) {
		if (isMissingPathError$2(error)) return;
		throw error;
	}
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`refusing to unlink non-unique or non-ordinary file: ${path}`);
	const tombstone = join(dirname(path), `.${basename(path)}.ark-unlink-${randomUUID()}`);
	let descriptor;
	try {
		descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if (isMissingPathError$2(error)) return;
		throw error;
	}
	const expected = fstatSync(descriptor);
	closeSync(descriptor);
	if (!expected.isFile() || expected.nlink !== 1) throw new Error(`refusing to unlink non-unique or non-ordinary file: ${path}`);
	renameSync(path, tombstone);
	const moved = openSync(tombstone, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		if (!sameFileIdentity(expected, fstatSync(moved))) {
			if (!existsSync(path)) renameSync(tombstone, path);
			throw new Error(`file changed before unlink: ${path}`);
		}
	} finally {
		closeSync(moved);
	}
	unlinkSync(tombstone);
	const directory = openSync(dirname(path), constants.O_RDONLY);
	try {
		fsyncSync(directory);
	} finally {
		closeSync(directory);
	}
}
/**
* Read optional UTF-8 text; only ENOENT maps to undefined.
* @param path - Optional ordinary single-link file to read.
* @param maxBytes - Maximum encoded bytes, defaulting to MAX_WIKI_PAGE_BYTES.
* @returns UTF-8 text, or undefined when the bounded read reports a missing path.
* @throws On other filesystem errors, unsafe/changed files, or excess size.
*/
function readOptionalText(path, maxBytes = MAX_WIKI_PAGE_BYTES) {
	try {
		return readRegularFileBounded(path, maxBytes).toString("utf8");
	} catch (error) {
		if (isMissingPathError$2(error)) return void 0;
		throw error;
	}
}
/**
* Parse optional JSON; only absence is converted to the caller's fallback.
* @param path - Optional ordinary single-link JSON file, bounded by MAX_WIKI_PAGE_BYTES.
* @param fallback - Value returned unchanged when the read reports ENOENT.
* @returns Parsed JSON asserted as T without schema validation, or the supplied fallback on absence.
* @throws On malformed JSON, unsafe/changed or oversized files, and other filesystem errors.
*/
function readOptionalJson(path, fallback) {
	try {
		return JSON.parse(readRegularFileBounded(path, MAX_WIKI_PAGE_BYTES).toString("utf8"));
	} catch (error) {
		if (isMissingPathError$2(error)) return fallback;
		throw error;
	}
}
/**
* Assert an absolute child remains inside a root after normalization.
* @param root - Root resolved to an absolute path for a lexical comparison.
* @param child - Child resolved to an absolute path; equality with root is allowed and symlinks are not resolved.
* @throws If the normalized relative path starts with a parent-directory segment.
*/
function assertAbsolutePathInside(root, child) {
	const rel = relative(resolve(root), resolve(child));
	if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("path escapes configured root");
}
//#endregion
//#region lib/types/graph.js
/**
* Local concept-graph engine for the 万相织鉴 knowledge base.
*
* Reads the wiki page tree (project/wiki/**\/*.md), parses frontmatter and
* [[wikilink]]s, builds the node/edge graph, and runs Louvain community
* detection — all in-process, with no dependency on the LLM Wiki app.
* @module @deepseek-ai/dsh-knowledge-wiki/graph
*/
/** Parse frontmatter fields and body through the shared block owner. */
function parsePageContent(raw) {
	const block = parseFrontmatterBlock(raw);
	if (block === null) return {
		type: void 0,
		title: void 0,
		related: [],
		body: raw
	};
	let type;
	let title;
	let related = [];
	for (const line of block.body.split(/\r?\n/u)) {
		const field = parseFrontmatterField(line);
		if (field === null) continue;
		const value = field.value.replace(/^["']|["']$/gu, "");
		if (field.key === "type" && value !== "") type = value;
		else if (field.key === "title" && value !== "") title = value;
		else if (field.key === "related") related = parseFrontmatterArray(field.value);
	}
	return {
		type,
		title,
		related,
		body: block.rest
	};
}
/**
* Extract raw `[[wikilink]]` targets from Markdown body.
* @param text - Markdown body text.
* @returns targets in source order.
*/
function extractWikiLinkTargets(text) {
	const out = [];
	let cursor = 0;
	while (cursor < text.length) {
		const open = text.indexOf("[[", cursor);
		if (open < 0) break;
		const close = text.indexOf("]]", open + 2);
		if (close < 0) break;
		const payload = text.slice(open + 2, close);
		const separator = payload.indexOf("|");
		const target = (separator < 0 ? payload : payload.slice(0, separator)).trim();
		if (target !== "") out.push(target);
		cursor = close + 2;
	}
	return out;
}
const SKIP_DIRS = new Set([
	"node_modules",
	"target",
	"dist",
	"build",
	".git",
	".obsidian",
	".llm-wiki",
	"_archives",
	"_candidates",
	"_governance",
	"_evidence",
	"sources",
	"queries"
]);
/**
* Visit visible Wiki directories and Markdown pages once, with all consumers
* sharing the same skip, path-normalization, and best-effort I/O boundary.
* @param wikiRoot - absolute Wiki root.
* @param visitor - callbacks for visible tree entries.
*/
function visitWikiTree(wikiRoot, visitor) {
	let rootStat;
	try {
		rootStat = lstatSync(wikiRoot);
	} catch (error) {
		if (isMissingPathError$2(error)) return;
		throw error;
	}
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Wiki root is not an ordinary directory");
	const visited = /* @__PURE__ */ new Set();
	const visitedFiles = /* @__PURE__ */ new Set();
	const walk = (dir, relPrefix) => {
		const directoryStat = lstatSync(dir);
		if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error(`unsafe Wiki directory: ${dir}`);
		const identity = `${directoryStat.dev}:${directoryStat.ino}`;
		if (visited.has(identity)) throw new Error(`revisited Wiki directory inode: ${dir}`);
		visited.add(identity);
		const entries = readdirSync(dir);
		for (const name of entries) {
			if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
			const fullPath = join(dir, name);
			const path = relPrefix === "" ? name : `${relPrefix}/${name}`;
			const st = lstatSync(fullPath);
			if (st.isSymbolicLink()) throw new Error(`symbolic links are not allowed in Wiki: ${path}`);
			if (st.isDirectory()) {
				visitor.onDirectory?.({
					name,
					path
				});
				walk(fullPath, path);
			} else if (!st.isFile()) throw new Error(`non-regular Wiki entry is not allowed: ${path}`);
			else if (name.endsWith(".md")) {
				if (st.nlink !== 1) throw new Error(`hard-linked Wiki page is not allowed: ${path}`);
				const fileIdentity = `${st.dev}:${st.ino}`;
				if (visitedFiles.has(fileIdentity)) throw new Error(`revisited Wiki file inode: ${path}`);
				visitedFiles.add(fileIdentity);
				if (st.size > 5242880) throw new Error(`Wiki page exceeds 5 MiB: ${path}`);
				visitor.onMarkdown?.({
					name,
					path,
					fullPath,
					size: st.size
				});
			}
		}
	};
	walk(wikiRoot, "");
}
/** Recursively collect wiki pages under a root directory. */
function collectPages$1(wikiRoot) {
	const pages = [];
	visitWikiTree(wikiRoot, { onMarkdown: ({ name, path, fullPath }) => {
		const parsed = parsePageContent(readRegularFileBounded(fullPath, MAX_WIKI_PAGE_BYTES).toString("utf8"));
		pages.push({
			path,
			title: parsed.title || name.replace(/\.md$/u, ""),
			nodeType: parsed.type || "other",
			links: extractWikiLinkTargets(parsed.body),
			related: parsed.related,
			text: parsed.body
		});
	} });
	return pages;
}
/** Build first-match lookup tables matching the legacy traversal semantics. */
function buildTargetLookup(states) {
	const byPath = /* @__PURE__ */ new Map();
	const byTitle = /* @__PURE__ */ new Map();
	const byStem = /* @__PURE__ */ new Map();
	for (const state of states) {
		const normalizedPath = state.page.path.replace(/\\/gu, "/");
		const parts = normalizedPath.split("/");
		for (let index = 0; index < parts.length; index += 1) {
			const suffix = parts.slice(index).join("/");
			if (!byPath.has(suffix)) byPath.set(suffix, state);
			const withoutExtension = suffix.replace(/\.md$/u, "");
			if (!byPath.has(withoutExtension)) byPath.set(withoutExtension, state);
		}
		if (!byTitle.has(state.page.title)) byTitle.set(state.page.title, state);
		const stem = basename(normalizedPath).replace(/\.md$/u, "");
		if (stem !== "" && !byStem.has(stem)) byStem.set(stem, state);
	}
	return {
		byPath,
		byTitle,
		byStem
	};
}
/** Resolve a wikilink target to a page path (bare name or wiki-relative path). */
function resolveTarget(target, lookup) {
	const normalized = target.replace(/\\/g, "/");
	const stem = basename(normalized).replace(/\.md$/u, "");
	return lookup.byPath.get(normalized) ?? lookup.byPath.get(normalized.replace(/\.md$/u, "")) ?? lookup.byTitle.get(target) ?? lookup.byStem.get(stem);
}
/**
* Louvain community detection (modularity-optimizing).
* @param nodes - node ids.
* @param edges - undirected edge pairs.
* @returns map of node id → community id.
*/
function louvain(nodes) {
	const total = nodes.reduce((sum, node) => sum + node.degree, 0);
	if (total === 0) return;
	const moveNode = (node) => {
		const current = node.community;
		const k = node.degree;
		current.degree = Math.max(0, current.degree - k);
		const gains = /* @__PURE__ */ new Map();
		for (const [neighbor, weight] of node.neighbors) {
			const community = neighbor.community;
			const prior = gains.get(community);
			gains.set(community, prior === void 0 ? weight : prior + weight);
		}
		let best = current;
		let bestGain = 0;
		for (const [community, gain] of gains) {
			if (community === current) continue;
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
		for (const node of nodes) if (moveNode(node)) moved = true;
		if (!moved) break;
	}
	const compact = /* @__PURE__ */ new Map();
	for (const node of nodes) {
		let id = compact.get(node.community);
		if (id === void 0) {
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
function buildGraph(wikiRoot) {
	const states = collectPages$1(wikiRoot).map((page, index) => {
		return {
			page,
			neighbors: /* @__PURE__ */ new Map(),
			degree: 0,
			incoming: 0,
			community: { degree: 0 },
			communityId: index
		};
	});
	const targetLookup = buildTargetLookup(states);
	const rawEdges = /* @__PURE__ */ new Map();
	const addEdge = (source, target) => {
		if (source === target) return;
		const first = source.page.path < target.page.path ? source : target;
		const second = first === source ? target : source;
		const key = `${first.page.path}\u0000${second.page.path}`;
		const existing = rawEdges.get(key);
		if (existing === void 0) rawEdges.set(key, {
			source: first,
			target: second,
			weight: 1
		});
		else existing.weight += 1;
	};
	for (const source of states) {
		const targets = [...source.page.links, ...source.page.related];
		const seen = /* @__PURE__ */ new Set();
		for (const target of targets) {
			const resolved = resolveTarget(target, targetLookup);
			if (resolved === void 0 || seen.has(resolved.page.path)) continue;
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
	for (const state of states) state.community.degree = state.degree;
	louvain(states);
	const nodes = states.map((state) => ({
		id: state.page.path,
		label: state.page.title,
		type: state.page.nodeType,
		path: state.page.path,
		linkCount: state.incoming,
		community: state.communityId
	}));
	const edges = [...rawEdges.values()].map((edge) => ({
		source: edge.source.page.path,
		target: edge.target.page.path,
		weight: edge.weight
	}));
	const communityNodes = /* @__PURE__ */ new Map();
	for (const node of nodes) {
		const members = communityNodes.get(node.community) ?? [];
		members.push(node);
		communityNodes.set(node.community, members);
	}
	return {
		nodes,
		edges,
		communities: [...communityNodes.entries()].map(([id, members]) => ({
			id,
			nodeCount: members.length,
			cohesion: 0,
			topNodes: members.sort((a, b) => b.linkCount - a.linkCount).slice(0, 5).map((node) => node.label)
		})).sort((a, b) => b.nodeCount - a.nodeCount)
	};
}
/**
* List wiki pages (recursive tree, heavyweight dirs skipped).
* @param wikiRoot - The wiki root input.
* @returns The value produced by list pages.
*/
function listPages(wikiRoot) {
	const out = [];
	visitWikiTree(wikiRoot, {
		onDirectory: ({ name, path }) => out.push({
			name,
			path,
			isDir: true,
			size: null
		}),
		onMarkdown: ({ name, path, size }) => out.push({
			name,
			path,
			isDir: false,
			size
		})
	});
	const hasDescendant = (path) => out.some((entry) => entry.path.startsWith(`${path}/`));
	return out.filter((entry) => entry.isDir ? hasDescendant(entry.path) : true);
}
/**
* Read one wiki page's raw text.
* @param wikiRoot - The wiki root input.
* @param relPath - The rel path input.
* @returns The value produced by read page.
*/
function readPage(wikiRoot, relPath) {
	return readRegularFileBounded(join(wikiRoot, relPath.replace(/^\/+/u, "")), MAX_WIKI_PAGE_BYTES).toString("utf8");
}
//#endregion
//#region lib/types/search.js
/**
* Local hybrid search for the 万相织鉴 knowledge base: BM25 keyword scoring
* over wiki pages, plus optional semantic vectors from the DashScope
* embedding API. Runs fully in-process — no LLM Wiki app dependency.
* @module @deepseek-ai/dsh-knowledge-wiki/search
*/
const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/;
function parseAliases(raw) {
	const value = /^aliases:\s*\[([^\]]*)\]\s*$/mu.exec(raw)?.[1];
	if (value === void 0) return [];
	return value.split(",").map((item) => item.trim().replace(/^["']|["']$/gu, "")).filter(Boolean);
}
/** Collect all wiki pages with body text (frontmatter stripped). */
function collectPages(wikiRoot) {
	const pages = [];
	visitWikiTree(wikiRoot, { onMarkdown: ({ name, path, fullPath }) => {
		const raw = readRegularFileBounded(fullPath, MAX_WIKI_PAGE_BYTES).toString("utf8");
		let title = name.replace(/\.md$/u, "");
		for (const line of raw.split("\n")) {
			const field = parseFrontmatterField(line);
			if (field?.key === "title" && field.value.trim() !== "") {
				title = field.value.trim().replace(/^["']|["']$/gu, "");
				break;
			}
		}
		pages.push({
			path,
			title,
			aliases: parseAliases(raw),
			text: raw.replace(FRONTMATTER_RE, "")
		});
	} });
	return pages;
}
/** Tokenize text into lowercase word/bigram tokens (Chinese-aware). */
function tokenize(text) {
	const out = [];
	const lower = text.toLowerCase();
	for (const match of lower.matchAll(/[a-z0-9][a-z0-9._-]{1,}/g)) out.push(match[0]);
	for (const seg of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
		const s = seg[0];
		if (s.length === 1) out.push(s);
		else {
			for (const character of s) out.push(character);
			for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
		}
	}
	return out;
}
const STOP = new Set([
	"the",
	"and",
	"or",
	"for",
	"with",
	"not",
	"all",
	"one",
	"can",
	"will",
	"when",
	"what",
	"your",
	"our",
	"you",
	"this",
	"that",
	"are",
	"was",
	"have",
	"has",
	"had",
	"from",
	"into",
	"about",
	"which",
	"would",
	"could",
	"should",
	"there",
	"their",
	"they",
	"them",
	"then",
	"than",
	"just",
	"but",
	"use",
	"used",
	"using",
	"make",
	"made",
	"get",
	"got",
	"like",
	"want",
	"need",
	"please",
	"help",
	"how",
	"why",
	"where",
	"who",
	"also",
	"very",
	"more",
	"most",
	"some",
	"any",
	"each",
	"only",
	"other",
	"such",
	"well",
	"back",
	"down",
	"over",
	"under",
	"again",
	"still",
	"even",
	"ever",
	"never",
	"now",
	"here",
	"let",
	"new",
	"old",
	"own",
	"same",
	"too",
	"way",
	"thing",
	"things",
	"something",
	"anything",
	"everything",
	"nothing",
	"someone",
	"anyone",
	"everyone",
	"sure",
	"right",
	"good",
	"bad",
	"great",
	"really",
	"actually",
	"maybe",
	"yes",
	"no",
	"ok",
	"okay",
	"hi",
	"hello",
	"知识",
	"文档",
	"文件",
	"这个",
	"什么",
	"怎么",
	"一个",
	"可以",
	"需要",
	"进行",
	"使用",
	"现在",
	"我们",
	"项目",
	"工作",
	"所有",
	"内容",
	"这样",
	"那个",
	"不是",
	"没有",
	"如果",
	"因为",
	"所以",
	"但是",
	"然后",
	"继续",
	"开始",
	"完成",
	"请问",
	"相关",
	"目前",
	"一下",
	"还有",
	"应该",
	"已经",
	"问题",
	"东西",
	"方面",
	"以及",
	"或者",
	"就是",
	"还是",
	"时候",
	"之后",
	"之前",
	"里面",
	"上面",
	"下面",
	"一些",
	"很多",
	"全部",
	"部分",
	"主要",
	"重要",
	"不同",
	"一样",
	"比较",
	"非常",
	"特别",
	"直接",
	"其实",
	"不过",
	"而且",
	"并且",
	"虽然",
	"但是",
	"由于",
	"因此",
	"同时",
	"另外",
	"此外",
	"其他",
	"其它",
	"通过",
	"根据",
	"按照",
	"对于",
	"关于",
	"包括",
	"包含",
	"属于",
	"来自",
	"作为",
	"成为",
	"变成",
	"产生",
	"出现",
	"存在",
	"提供",
	"支持",
	"帮助",
	"处理",
	"解决",
	"完成",
	"进行",
	"实现",
	"设计",
	"开发",
	"使用",
	"利用",
	"采用",
	"选择",
	"考虑",
	"需要",
	"要求",
	"希望",
	"想要",
	"可以",
	"能够",
	"可能",
	"应该",
	"必须",
	"一定",
	"因为",
	"所以",
	"结果",
	"效果",
	"影响",
	"情况",
	"状态",
	"方式",
	"方法",
	"过程",
	"阶段",
	"部分",
	"方面",
	"内容",
	"信息",
	"数据",
	"系统",
	"功能",
	"问题",
	"原因",
	"结论",
	"建议",
	"意见",
	"看法",
	"感觉",
	"知道",
	"看到",
	"听到",
	"想到",
	"觉得",
	"认为",
	"说明",
	"表示",
	"显示",
	"告诉",
	"询问",
	"回答",
	"回复"
]);
const K1 = 1.5;
const B = .75;
/** Score pages while carrying each page with its derived tokens. */
function scorePages(pages, query) {
	const documents = pages.map((page) => ({
		page,
		tokens: tokenize([
			page.title,
			...page.aliases,
			page.text
		].join("\n"))
	}));
	const docFreq = /* @__PURE__ */ new Map();
	for (const { tokens } of documents) for (const token of new Set(tokens)) docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
	const avgLen = documents.reduce((sum, document) => sum + document.tokens.length, 0) / Math.max(1, documents.length);
	const queryTokens = tokenize(query).filter((token) => !STOP.has(token));
	if (queryTokens.length === 0) return [];
	return documents.map(({ page, tokens }) => {
		if (tokens.length === 0) return {
			page,
			score: 0
		};
		const freq = /* @__PURE__ */ new Map();
		for (const token of tokens) freq.set(token, (freq.get(token) ?? 0) + 1);
		let score = 0;
		for (const q of queryTokens) {
			const df = docFreq.get(q) ?? 0;
			if (df === 0) continue;
			const idf = Math.log(1 + (pages.length - df + .5) / (df + .5));
			const tf = freq.get(q) ?? 0;
			const norm = tf * 2.5 / (tf + K1 * (1 - B + B * (tokens.length / avgLen)));
			score += idf * norm;
		}
		const titleTokens = tokenize([page.title, ...page.aliases].join("\n"));
		for (const q of queryTokens) if (titleTokens.includes(q)) score *= 1.5;
		return {
			page,
			score
		};
	}).filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score);
}
/**
* DashScope-compatible embedding for semantic search.
* @param texts - input texts.
* @param apiKey - DashScope API key (empty disables vector search).
* @returns vectors aligned with texts, or null when unavailable.
*/
async function embed(texts, apiKey) {
	if (!apiKey || texts.length === 0) return null;
	const res = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`
		},
		body: JSON.stringify({
			model: "text-embedding-v3",
			input: texts.slice(0, 16)
		})
	});
	if (!res.ok) throw new Error(`knowledge embedding request failed (${res.status})`);
	const body = await res.json();
	if (!Array.isArray(body.data)) throw new Error("knowledge embedding response is malformed");
	return body.data.map((item) => item.embedding ?? []);
}
/**
* Cosine similarity between two vectors.
* @param a - The a input.
* @param b - The b input.
* @returns The value produced by cosine.
*/
function cosine(a, b) {
	if (a.length !== b.length || a.length === 0) return 0;
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += (a[i] ?? 0) * (b[i] ?? 0);
		na += (a[i] ?? 0) * (a[i] ?? 0);
		nb += (b[i] ?? 0) * (b[i] ?? 0);
	}
	if (na === 0 || nb === 0) return 0;
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
/**
* Hybrid search: BM25 scores blended with vector similarity when available.
* @param wikiRoot - The wiki root input.
* @param query - The query input.
* @param apiKey - The api key input.
* @param topK - The top k input.
* @returns The value produced by hybrid search.
*/
async function hybridSearch(wikiRoot, query, apiKey, topK) {
	const scoredPages = scorePages(collectPages(wikiRoot), query);
	const keyword = scoredPages.map(({ page, score }) => ({
		path: page.path,
		score
	}));
	const topScoredPages = scoredPages.slice(0, 40);
	const topKeyword = keyword.slice(0, 40);
	const vector = await embed([query, ...topScoredPages.slice(0, 15).map(({ page }) => `${page.title}\n${page.text.slice(0, 600)}`)], apiKey);
	if (!vector || vector.length < 2) return keyword.slice(0, topK);
	let queryVec = [];
	const documentVectors = [];
	let firstVector = true;
	for (const current of vector) if (firstVector) {
		queryVec = current;
		firstVector = false;
	} else documentVectors.push(current);
	const scores = /* @__PURE__ */ new Map();
	const maxVec = { score: 0 };
	topKeyword.slice(0, 15).forEach((hit, i) => {
		const sim = cosine(queryVec, documentVectors[i] ?? []);
		maxVec.score = Math.max(maxVec.score, sim);
		scores.set(hit.path, sim);
	});
	const maxKw = keyword.reduce((maximum, hit) => Math.max(maximum, hit.score), 0);
	return keyword.slice(0, topK).map((hit) => {
		const vecScore = scores.get(hit.path) ?? 0;
		const normalizedVec = maxVec.score > 0 ? vecScore / maxVec.score : 0;
		const blended = hit.score / maxKw * .7 + normalizedVec * .3;
		return {
			path: hit.path,
			score: blended
		};
	}).sort((a, b) => b.score - a.score);
}
//#endregion
//#region lib/types/snapshot-store.js
/** Signals that a derived wiki snapshot belongs to an older project generation. */
var StaleWikiSnapshotError = class extends Error {
	constructor(root, key) {
		super(`stale Wiki snapshot result: ${root}#${key}`);
		this.name = "StaleWikiSnapshotError";
	}
};
/** Per-project memoization with external-edit invalidation. Git/files remain the source of truth. */
var WikiSnapshotStore = class {
	debounceMs;
	maxEntriesPerRoot;
	caches = /* @__PURE__ */ new Map();
	generations = /* @__PURE__ */ new Map();
	watchedRoots = /* @__PURE__ */ new Map();
	constructor(debounceMs = 200, maxEntriesPerRoot = 64) {
		this.debounceMs = debounceMs;
		this.maxEntriesPerRoot = maxEntriesPerRoot;
	}
	/**
	* Resolve or share one derived snapshot value for a project root.
	* @param root - The root input.
	* @param key - The key input.
	* @param load - The load input.
	* @returns The value produced by get.
	*/
	get(root, key, load) {
		this.ensureWatcher(root);
		const generation = this.currentGeneration(root);
		const cache = this.cacheFor(root);
		const existing = cache.get(key);
		if (existing !== void 0) {
			cache.delete(key);
			cache.set(key, existing);
			return existing;
		}
		const request = Promise.resolve().then(load).then((value) => {
			if (generation !== this.currentGeneration(root)) throw new StaleWikiSnapshotError(root, key);
			return value;
		});
		cache.set(key, request);
		this.trim(cache);
		request.catch(() => {
			if (cache.get(key) === request) cache.delete(key);
		});
		return request;
	}
	/**
	* Invalidate all projections for one project after a write or watcher event.
	* @param root - The root input.
	*/
	invalidate(root) {
		this.generations.set(root, this.currentGeneration(root) + 1);
		this.caches.delete(root);
	}
	/**
	* Current per-root snapshot generation, exposed for deterministic contracts/tests.
	* @param root - The root input.
	* @returns The value produced by current generation.
	*/
	currentGeneration(root) {
		return this.generations.get(root) ?? 0;
	}
	/** Close every watcher when the service is disposed. */
	dispose() {
		for (const watched of this.watchedRoots.values()) {
			if (watched.timer !== null) clearTimeout(watched.timer);
			watched.watcher.close();
		}
		this.watchedRoots.clear();
		this.caches.clear();
		this.generations.clear();
	}
	cacheFor(root) {
		const existing = this.caches.get(root);
		if (existing !== void 0) return existing;
		const created = /* @__PURE__ */ new Map();
		this.caches.set(root, created);
		return created;
	}
	trim(cache) {
		while (cache.size > this.maxEntriesPerRoot) {
			const oldest = cache.keys().next().value;
			if (oldest === void 0) return;
			cache.delete(oldest);
		}
	}
	ensureWatcher(root) {
		if (this.watchedRoots.has(root)) return;
		try {
			const watched = {
				watcher: watch(root, { recursive: true }, () => {
					if (watched.timer !== null) clearTimeout(watched.timer);
					watched.timer = setTimeout(() => {
						watched.timer = null;
						this.invalidate(root);
					}, this.debounceMs);
				}),
				timer: null
			};
			watched.watcher.on("error", () => {
				if (watched.timer !== null) clearTimeout(watched.timer);
				watched.watcher.close();
				this.watchedRoots.delete(root);
			});
			this.watchedRoots.set(root, watched);
		} catch {}
	}
};
//#endregion
//#region lib/types/project-context.js
/**
* Freeze the project identity used by one asynchronous operation.
* @param projectRoot - The project root input.
* @param mainRoot - The main root input.
* @param mainWikiRoot - The main wiki root input.
* @param generation - The generation input.
* @returns The value produced by create project execution context.
*/
function createProjectExecutionContext(projectRoot, mainRoot, mainWikiRoot, generation) {
	return Object.freeze({
		projectRoot,
		wikiRoot: projectRoot === mainRoot ? mainWikiRoot : `${projectRoot}/wiki`,
		generation,
		startedAt: Date.now()
	});
}
/**
* Describes the project execution context value used by this package.
*/
//#endregion
//#region lib/types/source-slug.js
/**
* Source-identity and summary-page slug derivation.
*
* The identity of a source file is its path relative to `raw/sources/`
* (e.g. `ark-sessions/2026-08-15-foo.md`). The summary-page slug is a
* deterministic, hash-anchored slug of that identity; both are data-format
* contracts shared with the wiki's existing 79 sources/ pages, so new pages
* must derive names by the same rules. Implemented independently for this
* package; only the output format is aligned.
* @module @deepseek-ai/dsh-knowledge-wiki/source-slug
*/
const RAW_SOURCES_PREFIX = "raw/sources/";
const RAW_SOURCES_MARKER = "/raw/sources/";
const MAX_SOURCE_SUMMARY_SLUG_LENGTH = 120;
const FALLBACK_SOURCE_PART = "source";
/**
* Derive a source identity from a project-absolute or project-relative
* source path: the path after the first `raw/sources/` segment, or the
* bare file name when no such segment exists.
* @param projectPath - absolute project root.
* @param sourcePath - absolute or project-relative path of the source file.
* @returns the identity (project-relative raw/sources path or file name).
*/
function sourceIdentityForPath(projectPath, sourcePath) {
	const root = normalize(projectPath).replace(/\/+$/u, "");
	const path = normalize(sourcePath);
	const rooted = `${root}/${RAW_SOURCES_PREFIX}`;
	if (path.toLowerCase().startsWith(rooted.toLowerCase())) return path.slice(rooted.length);
	if (path.toLowerCase().startsWith(RAW_SOURCES_PREFIX.toLowerCase())) return path.slice(12);
	const markerIndex = path.toLowerCase().indexOf(RAW_SOURCES_MARKER.toLowerCase());
	if (markerIndex >= 0) return path.slice(markerIndex + 13);
	return basename(path);
}
/**
* The wiki-relative summary-page slug for a source identity. Multi-segment
* identities produce `{length}-{readable}--…--{hash}` segments joined by
* `--` and capped at 120 characters; single-segment identities return the
* bare readable part without a hash.
* @param sourceIdentity - source identity (see {@link sourceIdentityForPath}).
* @returns the summary page slug without the `.md` extension.
*/
function sourceSummarySlugFromIdentity(sourceIdentity) {
	const parts = sourceIdentity.replace(/\.[^/.]+$/u, "").split("/").map((part) => part.trim()).filter(Boolean);
	if (parts.length <= 1) return parts[0] || FALLBACK_SOURCE_PART;
	const hash = fnv32Base36(sourceIdentity);
	const segments = parts.map((part) => {
		const { readable, structuralLength } = readableSlugPart(part);
		return `${structuralLength}-${readable}`;
	}).join("--");
	const fullSlug = `${segments}--${hash}`;
	if (fullSlug.length <= MAX_SOURCE_SUMMARY_SLUG_LENGTH) return fullSlug;
	const readableLimit = MAX_SOURCE_SUMMARY_SLUG_LENGTH - hash.length - 2;
	return `${segments.slice(0, readableLimit).replace(/-+$/u, "")}--${hash}`;
}
/**
* The summary-page file name (slug + `.md`) for a source identity.
* @param sourceIdentity - source identity (see {@link sourceIdentityForPath}).
* @returns the file name.
*/
function sourceSummaryFileNameFromIdentity(sourceIdentity) {
	return `${sourceSummarySlugFromIdentity(sourceIdentity)}.md`;
}
/** One slug segment: the NFKC-clean readable form plus its structural length. */
function readableSlugPart(part) {
	const structural = part.normalize("NFKC").trim().replace(/\s+/gu, "-").replace(/[^\p{L}\p{N}-]/gu, "").replace(/^-|-$/gu, "").toLowerCase();
	return {
		readable: structural.replace(/-+/gu, "-") || FALLBACK_SOURCE_PART,
		structuralLength: Math.max(1, Array.from(structural || FALLBACK_SOURCE_PART).length)
	};
}
/** FNV-1a 32-bit hash as a base-36 string (stable across runs and platforms). */
function fnv32Base36(value) {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}
//#endregion
//#region lib/types/sanitize.js
/**
* Write-time cleanup of LLM-generated wiki page content.
*
* Recurring model output shapes — an outer code fence wrapping the whole
* document, a stray `frontmatter:` key prefix, a missing opening frontmatter
* fence, and wikilink lists (`[[a]], [[b]]`) inside frontmatter array
* fields — are rewritten to the standard `---\n…\n---\n` form. Every
* pattern is anchored at the document start or inside the frontmatter
* block so legitimate body content is never touched. Dates in generated
* frontmatter and log entries are stamped to the ingest day.
* @module @deepseek-ai/dsh-knowledge-wiki/sanitize
*/
const FRONTMATTER_FIELD_RE = /^(type|title|created|updated|tags|related|sources)\s*:/i;
/**
* Normalize one generated file body into the standard frontmatter form.
* @param content - the model-generated page content.
* @returns the cleaned content.
*/
function sanitizeIngestedFileContent(content) {
	let cleaned = content;
	cleaned = stripOuterCodeFence(cleaned);
	cleaned = stripFrontmatterKeyPrefix(cleaned);
	cleaned = addMissingOpeningFrontmatterFence(cleaned);
	cleaned = repairWikilinkListsInFrontmatter(cleaned);
	return cleaned;
}
/**
* Remove a code fence wrapping the whole document, or wrapping exactly a
* complete frontmatter block when the body continues unfenced after it.
* Acts only when the first non-empty line is an opening fence.
*/
function stripOuterCodeFence(content) {
	const open = content.match(/^(?:﻿)?(?:[ \t]*\r?\n)*[ \t]*```(?:yaml|md|markdown)?[ \t]*\r?\n/i);
	if (open === null) return content;
	const afterOpen = content.slice(open[0].length);
	const close = afterOpen.match(/[ \t]*```[ \t]*\r?\n?\s*$/);
	if (close !== null) return afterOpen.slice(0, close.index);
	const frontmatterOnly = afterOpen.match(/^(---[ \t]*\r?\n[\s\S]*?^---[ \t]*\r?\n)[ \t]*```[ \t]*(?:\r?\n|$)/m);
	if (frontmatterOnly === null) return content;
	const matched = frontmatterOnly[0];
	const fenceStart = matched.lastIndexOf("```");
	return matched.slice(0, fenceStart).replace(/[ \t]*$/u, "") + afterOpen.slice(matched.length);
}
/**
* Remove a leading `frontmatter:` line that prefixes the real `---` block.
* Only acts when the next non-empty line is the opening fence.
*/
function stripFrontmatterKeyPrefix(content) {
	const match = content.match(/^[ \t]*frontmatter\s*:\s*\r?\n(?=[ \t]*---\s*\r?\n)/);
	if (match === null) return content;
	return content.slice(match[0].length);
}
/**
* Prepend the opening frontmatter fence when the model started inside the
* YAML block: the first non-empty line is a known frontmatter field and a
* closing `---` follows within a short span.
*/
function addMissingOpeningFrontmatterFence(content) {
	if (/^[ \t]*---\s*(\r?\n|$)/.test(content)) return content;
	const lines = content.split(/\r?\n/);
	const firstContent = lines.find((line) => line.trim().length > 0);
	if (firstContent === void 0) return content;
	const firstContentIdx = lines.indexOf(firstContent);
	const first = firstContent.trim();
	if (!FRONTMATTER_FIELD_RE.test(first)) return content;
	const searchEnd = Math.min(lines.length, firstContentIdx + 30);
	for (const line of lines.slice(firstContentIdx + 1, searchEnd)) {
		const trimmed = line.trim();
		if (trimmed === "---") return `---\n${lines.slice(firstContentIdx).join("\n")}`;
		if (/^#{1,6}\s+/.test(trimmed)) break;
	}
	return content;
}
/**
* Rewrite `key: [[a]], [[b]]` lines inside the frontmatter block into a
* valid quoted array (`key: ["[[a]]", "[[b]]"]`); body wikilinks are
* left untouched.
*/
function repairWikilinkListsInFrontmatter(content) {
	const block = parseFrontmatterBlock(content);
	if (block === null) return content;
	const repaired = block.body.split(/\r?\n/).map((line) => {
		const field = parseFrontmatterField(line);
		if (field === null || !/^\[\[[^\]]+\]\](?:\s*,\s*\[\[[^\]]+\]\])+$/u.test(field.value)) return line;
		return renderCanonicalFrontmatterField(field, `[${field.value.split(",").map((item) => item.trim()).filter(Boolean).map((item) => `"${item}"`).join(", ")}]`);
	}).join(block.lineBreak);
	return block.prefix + repaired + block.suffix + block.rest;
}
/**
* Force `created`/`updated` in the frontmatter block to the given day.
* Leaves a page without frontmatter untouched.
* @param content - page content.
* @param today - ISO date string (YYYY-MM-DD).
* @returns the stamped content.
*/
function stampGeneratedFrontmatterDates(content, today) {
	const block = parseFrontmatterBlock(content);
	if (block === null) return content;
	const stamped = block.body.split(/\r?\n/).map((line) => {
		const field = parseFrontmatterField(line);
		if (field === null || field.key !== "created" && field.key !== "updated") return line;
		return renderPreservedFrontmatterField(field, today);
	}).join(block.lineBreak);
	return block.prefix + stamped + block.suffix + block.rest;
}
/**
* Force the date inside a generated `## [YYYY-MM-DD] ingest | …` log entry
* to the given day; a log entry without a date gets one prepended.
* @param entry - the log entry text.
* @param today - ISO date string (YYYY-MM-DD).
* @returns the stamped entry.
*/
function stampGeneratedLogDate(entry, today) {
	const datedPrefix = entry.match(/^##\s+\[[0-9-]+\]/u);
	if (datedPrefix !== null) return `## [${today}]${entry.slice(datedPrefix[0].length)}`;
	const heading = entry.match(/^##\s+(.*)/u);
	if (heading !== null) return `## [${today}] ${heading[1]}`;
	return `## [${today}] ingest\n\n${entry}`;
}
//#endregion
//#region lib/types/fallback-summary.js
/**
* Deterministic source-summary fallback page.
*
* When the model omits the mandatory `wiki/sources/<slug>.md` page for a
* source, the engine still writes a minimal `type: source` page with the
* contract fields, so every ingested source has a summary page regardless
* of model behavior.
* @module @deepseek-ai/dsh-knowledge-wiki/fallback-summary
*/
/**
* The wiki-relative path of the fallback summary page for an identity.
* @param identity - source identity (path relative to raw/sources/).
* @returns the wiki-relative page path.
*/
function fallbackSummaryRelPath(identity) {
	return `wiki/sources/${sourceSummaryFileNameFromIdentity(identity)}`;
}
/**
* Build the fallback source-summary page content for a source identity.
* @param identity - source identity (path relative to raw/sources/).
* @param today - ISO date string (YYYY-MM-DD) for created/updated.
* @returns the full Markdown page content.
*/
function buildFallbackSourceSummaryPage(identity, today) {
	const title = titleFromIdentity(identity);
	return [
		[
			"---",
			"type: source",
			`title: ${title}`,
			"tags: []",
			"related: []",
			`created: ${today}`,
			`updated: ${today}`,
			`sources: ["${identity}"]`,
			"---",
			""
		].join("\n"),
		`# ${title}`,
		"",
		"> 本页由摄取引擎自动生成（模型未输出 source 汇总页）。",
		"",
		`源文件：\`${identity}\``,
		""
	].join("\n");
}
/** Display title: the slug's readable part or the identity's base name. */
function titleFromIdentity(identity) {
	return basename(identity).replace(/\.[^.]+$/u, "") || sourceSummarySlugFromIdentity(identity);
}
//#endregion
//#region lib/types/merge-page.js
/**
* Re-ingest merge semantics for existing wiki pages.
*
* When a source is ingested again, its pages may already exist. A page
* whose `sources` field is owned only by the same source is replaced in
* full; a page shared with other sources keeps its body and only the
* `sources` field is unioned (conservative v1 — model-level body merging
* is a known limitation). A page without frontmatter is left untouched.
* @module @deepseek-ai/dsh-knowledge-wiki/merge-page
*/
/**
* Whether a page's `sources` field references only the given source
* identity (so the page can be safely replaced on re-ingest).
* @param existingContent - the existing page content.
* @param identity - the ingesting source identity.
* @returns true when every source reference equals the identity.
*/
function isOwnedOnlyBySource(existingContent, identity) {
	const sources = parseSourcesField(existingContent);
	if (sources.length === 0) return false;
	return sources.every((ref) => normalizeForComparison(ref) === normalizeForComparison(identity));
}
/**
* Merge re-ingested content into an existing page. Owned-only pages are
* replaced; shared pages keep their body with the sources union and a
* refreshed `updated` date; frontmatter-less pages are returned unchanged.
* @param existingContent - the existing page content.
* @param newContent - the freshly generated content.
* @param identity - the ingesting source identity.
* @param today - ISO date string (YYYY-MM-DD) for the updated stamp.
* @returns the merged content (or the existing content untouched).
*/
function mergePageContent(existingContent, newContent, identity, today) {
	if (isOwnedOnlyBySource(existingContent, identity)) return newContent;
	const block = parseFrontmatterBlock(existingContent);
	if (block === null) return existingContent;
	const existingSources = parseSourcesField(existingContent);
	if (existingSources.length === 0) return existingContent;
	const union = [...existingSources];
	const existingIdentity = union.find((ref) => normalizeForComparison(ref) === normalizeForComparison(identity));
	let serialized;
	if (existingIdentity === void 0) {
		union.push(identity);
		serialized = canonicalizeSourcesField(JSON.stringify(union), identity);
	} else serialized = canonicalizeSourcesField(JSON.stringify(union), existingIdentity);
	const stamped = block.body.split(/\r?\n/u).map((line) => {
		const field = parseFrontmatterField(line);
		if (field?.key === "sources") return renderCanonicalFrontmatterField(field, serialized);
		if (field?.key === "updated") return renderPreservedFrontmatterField(field, today);
		return line;
	}).join(block.lineBreak);
	return block.prefix + stamped + block.suffix + block.rest;
}
/** The parsed `sources` items of a page's frontmatter (empty when absent). */
function parseSourcesField(content) {
	const block = parseFrontmatterBlock(content);
	if (block === null) return [];
	for (const line of block.body.split(/\r?\n/u)) {
		const field = parseFrontmatterField(line);
		if (field?.key !== "sources") continue;
		const value = field.value.trim();
		if (value === "") continue;
		return parseFrontmatterArray(value.startsWith("[") || value.startsWith("-") ? value : `[${value}]`);
	}
	return [];
}
/** Comparison form of a source reference: identity-normalized, case-folded. */
function normalizeForComparison(reference) {
	let ref = reference.trim();
	if (ref.toLowerCase().startsWith("raw/sources/")) ref = ref.slice(12);
	return ref.toLowerCase();
}
//#endregion
//#region lib/types/canonical-merge.js
/**
* Deterministic Candidate -> Canonical merge policy.
*
* The LLM may propose a merge, but this module only auto-merges exact
* duplicates and strict body supersets. Divergent bodies require a separately
* reviewed merged candidate.
*/
const CANDIDATE_ONLY_FIELDS = new Set([
	"candidate_id",
	"candidate_kind",
	"candidate_hash",
	"origin",
	"resolution_status",
	"review_status"
]);
/**
* Merge only exact duplicates or strict body supersets.
* @param canonicalContent - The canonical content input.
* @param candidateContent - The candidate content input.
* @param approvedAt - The approved at input.
* @returns The value produced by merge candidate into canonical.
*/
function mergeCandidateIntoCanonical(canonicalContent, candidateContent, approvedAt) {
	const canonical = parsePage(canonicalContent);
	const candidate = parsePage(candidateContent);
	const canonicalKey = normalizeKnowledgeBody(canonical.body);
	const candidateKey = normalizeKnowledgeBody(candidate.body);
	if (canonicalKey === "" || candidateKey === "") throw new Error("candidate merge refused: empty knowledge body");
	let preferred = canonical;
	let mode = "duplicate";
	if (canonicalKey === candidateKey) mode = "duplicate";
	else if (canonicalKey.includes(candidateKey)) mode = "canonical-superset";
	else if (candidateKey.includes(canonicalKey)) {
		preferred = candidate;
		mode = "candidate-superset";
	} else throw new Error("candidate merge refused: bodies diverge; create a reviewed merged candidate");
	return {
		content: renderCanonical(preferred, canonical, candidate, approvedAt),
		mode
	};
}
/**
* Explicit human-approved replacement. The caller must archive the previous canonical first.
* @param canonicalContent - The canonical content input.
* @param candidateContent - The candidate content input.
* @param approvedAt - The approved at input.
* @returns The value produced by replace canonical with candidate.
*/
function replaceCanonicalWithCandidate(canonicalContent, candidateContent, approvedAt) {
	const canonical = parsePage(canonicalContent);
	const candidate = parsePage(candidateContent);
	if (normalizeKnowledgeBody(candidate.body) === "") throw new Error("candidate replacement refused: empty knowledge body");
	return {
		content: renderCanonical(candidate, canonical, candidate, approvedAt, "governance-agent"),
		mode: "replace"
	};
}
/**
* Keep the canonical body and merge only provenance from a semantic duplicate.
* @param canonicalContent - The canonical content input.
* @param candidateContent - The candidate content input.
* @param approvedAt - The approved at input.
* @param approvedBy - The approved by input.
* @returns The value produced by deduplicate candidate against canonical.
*/
function deduplicateCandidateAgainstCanonical(canonicalContent, candidateContent, approvedAt, approvedBy = "governance-agent") {
	const canonical = parsePage(canonicalContent);
	return {
		content: renderCanonical(canonical, canonical, parsePage(candidateContent), approvedAt, approvedBy),
		mode: "duplicate"
	};
}
function parsePage(content) {
	const block = parseFrontmatterBlock(content);
	if (block === null) throw new Error("candidate merge refused: missing frontmatter");
	const fields = /* @__PURE__ */ new Map();
	for (const line of block.body.split(/\r?\n/u)) {
		const field = parseFrontmatterField(line);
		if (field === null) continue;
		fields.set(field.key, field.value);
	}
	return {
		fields,
		body: block.rest.trim()
	};
}
function renderCanonical(preferred, previousCanonical, candidate, approvedAt, approvedBy = "governance-agent") {
	const fields = new Map(preferred.fields);
	for (const key of CANDIDATE_ONLY_FIELDS) fields.delete(key);
	const previousCreated = previousCanonical.fields.get("created");
	const allSources = [...readSources(previousCanonical), ...readSources(candidate)];
	fields.set("status", "canonical");
	fields.set("approved_at", approvedAt);
	fields.set("approved_by", approvedBy);
	fields.set("updated", approvedAt.slice(0, 10));
	fields.set("sources", formatFrontmatterArray([...new Set(allSources)]));
	if (previousCreated !== void 0) fields.set("created", previousCreated);
	return `---\n${[...fields].map(([key, value]) => `${key}: ${value}`).join("\n")}\n---\n\n${preferred.body.trim()}\n`;
}
function readSources(page) {
	const raw = page.fields.get("sources");
	return raw === void 0 ? [] : parseFrontmatterArray(raw);
}
function normalizeKnowledgeBody(body) {
	return body.normalize("NFKC").replace(/^#\s+.*$/gmu, "").replace(/^>\s*本页由.*$/gmu, "").replace(/[`*_#>\-\s，。！？、；：,.!?;:'"“”‘’（）()\[\]{}]/gu, "").toLowerCase();
}
//#endregion
//#region lib/types/governance-policy.js
/** Autonomous, deterministic policy for Candidate disposition. */
/** Directories that contain visible Canonical knowledge. */
const CANONICAL_WIKI_DIRECTORIES = Object.freeze([
	"concepts",
	"entities",
	"findings",
	"research",
	"methodology"
]);
const POLICY_VERSION = "wiki-governance-v3";
/**
* Resolve one durable Wiki-relative path without repairing unsafe input.
* @param root - absolute Wiki root that owns the path.
* @param input - persisted POSIX-style path relative to the Wiki root.
* @param allowMissing - whether a missing suffix is valid for a future create.
* @returns the normalized relative/absolute pair, or undefined when unsafe or absent.
*/
function resolveGovernedWikiPath(root, input, allowMissing) {
	if (input === "" || input.includes("\0") || input.includes("\\") || posix.isAbsolute(input) || win32.isAbsolute(input)) return;
	const parts = input.split("/");
	if (parts.some((part) => part === "" || part === "." || part === "..")) return void 0;
	const relativePath = parts.join("/");
	const base = resolve(root);
	const absolutePath = join(base, ...parts);
	let cursor = base;
	for (const part of parts) {
		cursor = join(cursor, part);
		try {
			if (lstatSync(cursor).isSymbolicLink()) return void 0;
		} catch (error) {
			if (!isMissingPathError$1(error)) throw error;
			if (allowMissing) break;
			return;
		}
	}
	return {
		relativePath,
		absolutePath
	};
}
function isMissingPathError$1(error) {
	return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";
}
/**
* Provides the governance policy version operation.
* @returns The value produced by governance policy version.
*/
function governancePolicyVersion() {
	return POLICY_VERSION;
}
/**
* Provides the decide candidate governance operation.
* @param wikiRoot - The wiki root input.
* @param candidatePath - The candidate path input.
* @param content - The content input.
* @param suggestedTarget - The suggested target input.
* @returns The value produced by decide candidate governance.
*/
function decideCandidateGovernance(wikiRoot, candidatePath, content, suggestedTarget) {
	const body = extractBody(content);
	const title = extractTitle$1(content, candidatePath);
	const normalized = normalize$1(body);
	const fingerprint = createHash("sha256").update(normalized).digest("hex");
	const quality = scoreQuality(candidatePath, title, body, content);
	const governedTarget = suggestedTarget === void 0 ? void 0 : resolveGovernedWikiPath(wikiRoot, suggestedTarget, true);
	const safeTarget = governedTarget?.relativePath;
	if (quality.hardReject) return decision("Archive", .99, quality.score, quality.reasons, fingerprint, safeTarget);
	if (governedTarget !== void 0 && existsSync(governedTarget.absolutePath)) {
		const canonical = readRegularFileBounded(governedTarget.absolutePath, 5 * 1024 * 1024).toString("utf8");
		const similarity = bodySimilarity(extractBody(canonical), body);
		if (similarity >= .82) return decision("Deduplicate", similarity, quality.score, ["same target and high content overlap"], fingerprint, safeTarget);
		if (!quality.autoEligible) return decision("Hold", .98, quality.score, [...quality.reasons, "candidate is not eligible to change canonical knowledge"], fingerprint, safeTarget);
		try {
			mergeCandidateIntoCanonical(canonical, content, (/* @__PURE__ */ new Date()).toISOString());
			return decision("Merge", .99, quality.score, ["same canonical target; deterministic merge is safe"], fingerprint, safeTarget);
		} catch {
			return decision("Hold", 1 - similarity, quality.score, ["same target but bodies diverge"], fingerprint, safeTarget);
		}
	}
	const match = findCanonicalMatch(wikiRoot, title, body);
	if (match !== void 0 && match.similarity >= .82) return decision("Deduplicate", match.similarity, quality.score, ["high-overlap canonical page already exists"], fingerprint, match.path);
	if (safeTarget !== void 0 && quality.autoEligible && quality.score >= 8) return decision("Promote", Math.min(.98, .72 + quality.score * .026), quality.score, quality.reasons, fingerprint, safeTarget);
	if (quality.score <= 2) return decision("Archive", .92, quality.score, quality.reasons, fingerprint, safeTarget);
	return decision("Hold", .6, quality.score, [...quality.reasons, "insufficient confidence for autonomous disposition"], fingerprint, safeTarget);
}
function decision(action, confidence, score, reasons, claimFingerprint, targetPath) {
	return {
		action,
		confidence,
		score,
		reasons,
		claimFingerprint,
		...targetPath ? { targetPath } : {}
	};
}
function scoreQuality(candidatePath, title, body, content) {
	const reasons = [];
	const compact = normalize$1(body);
	const sourceList = parseSources(/^sources:\s*\[([^\]]*)\]/mu.exec(content)?.[1]?.trim() ?? "");
	const independentSources = sourceList.filter(isIndependentSource);
	const hasSource = sourceList.length > 0;
	const hasIndependentSource = independentSources.length > 0;
	const conversationOnlySource = hasSource && !hasIndependentSource;
	const shortCommand = /^(继续|开始|看看|修好了吗|完成了吗|可以了吗|然后呢|你固定了吗|再试试)[？?!！。.]*$/u.test(title.trim());
	const pastedPlaceholder = /pasted[-_ ]image[-_ ]available|\[pasted image\]/iu.test(`${title}\n${body}`);
	const sessionQuestion = candidatePath.startsWith("_candidates/sessions/") && /^(请|你|我们|是不是|为什么|怎么|如何)|[？?]$/u.test(title.trim());
	const incidentCandidate = candidatePath.startsWith("_candidates/incidents/") || /^candidate_kind:\s*incident\s*$/mu.test(content);
	const reflectionCandidate = candidatePath.startsWith("_candidates/reflections/") || /^candidate_kind:\s*reflection\s*$/mu.test(content);
	const epistemicStatus = /^epistemic_status:\s*(\S+)\s*$/mu.exec(content)?.[1] ?? "";
	const independentSourceCount = Number(/^independent_source_count:\s*(\d+)\s*$/mu.exec(content)?.[1] ?? 0);
	const reflectionComplete = !reflectionCandidate || [
		"失败模式",
		"根因假设",
		"反事实做法",
		"防复发动作",
		"适用条件"
	].every((heading) => new RegExp(`^##\\s+${heading}\\s*$`, "mu").test(body));
	const durableSignal = /(原则|方法|流程|规范|约束|决策|根因|适用条件|验证证据|风险|回滚|不变量|验收|边界|例外)/u.test(body);
	const applicability = /(适用|不适用|前提|条件|限制|边界|例外|触发|when|unless|prerequisite|limitation)/iu.test(body);
	const actionable = /(步骤|流程|门禁|检查|验证|回滚|输入|输出|操作|执行器|验收)/u.test(body);
	const connected = /^related:\s*\[[^\]]+\]/mu.test(content) || /\[\[[^\]]+\]\]/u.test(body);
	const processMatches = body.match(/(使用工具|\bbash\b|\bread\b|\bedit\b|git:\s|tarball|编译打包|运行时.*同步|全部完成|API Error|Cogitated)/giu)?.length ?? 0;
	const transcriptPollution = /(本轮输入|本轮结论|本页由「对话自动沉淀」|Thought for \d+s|Ran \d+ shell command)/iu.test(body);
	const unstableHistory = /(\/Users\/|node_modules\/|git:\s*[0-9a-f]{7,40}|\b[0-9a-f]{7,40}\b|tarball:|运行时.*同步)/iu.test(body);
	const assistantClaim = /(已修复|修复完成|部署完成|全部完成|固化完成)/u.test(body);
	const verification = /(测试通过|复现通过|验收通过|实际请求|运行时证据|验证证据|回滚点)/u.test(body);
	if (shortCommand) reasons.push("title is a conversational command");
	if (pastedPlaceholder) reasons.push("pasted-image placeholder");
	if (incidentCandidate) reasons.push("incident history belongs in Evidence or Archive, not Canonical");
	if (reflectionCandidate && !reflectionComplete) reasons.push("reflection is missing failure, cause, counterfactual, prevention, or applicability");
	if (reflectionCandidate && epistemicStatus !== "verified") reasons.push("reflection remains a hypothesis until independently verified");
	if (reflectionCandidate && independentSourceCount < 2) reasons.push("reflection has fewer than two independent sources");
	if (compact.length < 120) reasons.push("knowledge body is too short");
	if (!hasSource) reasons.push("candidate has no source evidence");
	if (!hasIndependentSource) reasons.push(hasSource ? "session or workspace context is not independent evidence" : "candidate has no independent source evidence");
	if (sessionQuestion && !durableSignal) reasons.push("generic session Q&A without durable project knowledge");
	if (transcriptPollution) reasons.push("conversation transcript markers remain in the body");
	if (processMatches >= 3) reasons.push("tool and progress log pollution");
	if (unstableHistory) reasons.push("local path, build artifact, or revision detail is not stable knowledge");
	if (assistantClaim && !verification) reasons.push("assistant completion claim has no independent verification");
	const hardReject = shortCommand || pastedPlaceholder || incidentCandidate || reflectionCandidate && !reflectionComplete || compact.length < 80 || sessionQuestion && !durableSignal || transcriptPollution && processMatches >= 2 || processMatches >= 5 || assistantClaim && !verification && processMatches >= 2;
	if (hardReject) return {
		score: 0,
		reasons,
		hardReject,
		autoEligible: false
	};
	let score = 0;
	if (compact.length >= 180 && compact.length <= 12e3) score += 1;
	if (hasIndependentSource) score += 2;
	if (durableSignal) score += 2;
	if (/^#{2,3}\s+|^\s*[-*]\s+|^\s*\d+[.]\s+/mu.test(body)) score += 1;
	if (title.length >= 4 && title.length <= 48 && !sessionQuestion) score += 1;
	if (verification) score += 1;
	if (applicability || actionable) score += 1;
	if (connected) score += 1;
	if (processMatches >= 2) score -= 2;
	if (transcriptPollution) score -= 3;
	if (unstableHistory) score -= 2;
	if (assistantClaim && !verification) score -= 2;
	score = Math.max(0, Math.min(10, score));
	const autoEligible = score >= 8 && hasSource && hasIndependentSource && durableSignal && (verification || actionable) && !transcriptPollution && !unstableHistory && processMatches < 2 && epistemicStatus !== "hypothesis" && !conversationOnlySource && (!reflectionCandidate || epistemicStatus === "verified" && independentSourceCount >= 2 && independentSources.length >= 2 && verification);
	if (!autoEligible) reasons.push("candidate remains in review because one or more canonical admission gates failed");
	reasons.push(`deterministic quality score ${score}/10`);
	return {
		score,
		reasons,
		hardReject: false,
		autoEligible
	};
}
function parseSources(value) {
	return value.split(",").map((item) => item.trim().replace(/^["']|["']$/gu, "")).filter(Boolean);
}
function isIndependentSource(source) {
	return !/(?:^|[/.:_-])(?:session|conversation|chat)(?:$|[/.:_-])|ark-sessions\//iu.test(source) && !/^(?:workspace|generated|auto):/iu.test(source);
}
function findCanonicalMatch(wikiRoot, candidateTitle, candidateBody) {
	let best;
	for (const dirName of CANONICAL_WIKI_DIRECTORIES) {
		const root = resolveGovernedWikiPath(wikiRoot, dirName, false);
		if (root === void 0) continue;
		for (const full of markdownFiles(root.absolutePath)) {
			const content = readRegularFileBounded(full, 5 * 1024 * 1024).toString("utf8");
			const titleScore = ngramSimilarity(candidateTitle, extractTitle$1(content, basename(full)));
			const bodyScore = bodySimilarity(candidateBody, extractBody(content));
			const similarity = Math.max(bodyScore, titleScore * .45 + bodyScore * .55);
			if (best === void 0 || similarity > best.similarity) best = {
				path: relative(wikiRoot, full),
				similarity
			};
		}
	}
	return best;
}
function markdownFiles(root) {
	const output = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const full = join(root, entry.name);
		if (entry.isDirectory()) output.push(...markdownFiles(full));
		else if (entry.isFile() && entry.name.endsWith(".md")) output.push(full);
	}
	return output;
}
function extractTitle$1(content, fallback) {
	return (/^title:\s*(.+)$/mu.exec(content)?.[1] ?? /^#\s+(.+)$/mu.exec(content)?.[1] ?? fallback).trim().replace(/^["']|["']$/gu, "");
}
function extractBody(content) {
	return content.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u, "").trim();
}
function bodySimilarity(left, right) {
	const a = normalize$1(left);
	const b = normalize$1(right);
	if (a === "" || b === "") return 0;
	if (a === b) return 1;
	if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length);
	return ngramSimilarity(a, b, 3);
}
function ngramSimilarity(left, right, size = 2) {
	const a = ngrams(normalize$1(left), size);
	const b = ngrams(normalize$1(right), size);
	if (a.size === 0 || b.size === 0) return 0;
	let intersection = 0;
	for (const item of a) if (b.has(item)) intersection += 1;
	return intersection / (a.size + b.size - intersection);
}
function ngrams(value, size) {
	const output = /* @__PURE__ */ new Set();
	for (let i = 0; i <= value.length - size; i += 1) output.add(value.slice(i, i + size));
	return output;
}
function normalize$1(value) {
	return value.normalize("NFKC").replace(/^#\s+.*$/gmu, "").replace(/^>\s*本页由.*$/gmu, "").replace(/[`*_#>\-\s，。！？、；：,.!?;:'"“”‘’（）()\[\]{}]/gu, "").toLowerCase();
}
//#endregion
//#region lib/types/verifier.js
/** Independent Candidate verification contract and receipt validation. */
const RECEIPT_SCHEMA = 2;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const COMMIT_RE = /^[0-9a-f]{40}$/u;
const ID_RE = /^[A-Za-z0-9._:-]{1,160}$/u;
const VERIFICATION_METHODS = new Set([
	"unit_test",
	"integration_test",
	"production_observation",
	"manual_review"
]);
/**
* Canonical JSON used for every hash and authority call.
* @param value - Acyclic JSON data; undefined object properties are omitted.
* @returns JSON text with sorted object keys and the original array order.
* @throws If the value contains a cycle or a primitive JSON cannot serialize, such as bigint.
*/
function canonicalJson(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const object = value;
	return `{${Object.keys(object).sort().filter((key) => object[key] !== void 0).map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}
/**
* Hash receipt, review, or Candidate bytes for identity comparisons.
* @param value - UTF-8 text or the exact bytes to hash.
* @returns Lowercase hexadecimal SHA-256 digest.
*/
function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}
/**
* Immutable Review proposal fields; mutable resolution/verification mirrors are excluded.
* @param item - Review whose proposal fields are bound into a verification request.
* @returns Frozen proposal with copied, frozen arrays, explicit nulls, and resolved fixed to false.
*/
function immutableReviewRow(item) {
	return Object.freeze({
		id: item.id,
		title: item.title,
		type: item.type,
		description: item.description ?? null,
		sourcePath: item.sourcePath ?? null,
		affectedPages: Object.freeze([...item.affectedPages ?? []]),
		resolved: false,
		createdAt: item.createdAt ?? null,
		searchQueries: Object.freeze([...item.searchQueries ?? []]),
		reviewKind: item.reviewKind ?? null,
		candidatePath: item.candidatePath ?? null,
		candidateHash: item.candidateHash ?? null,
		targetPath: item.targetPath ?? null
	});
}
function validSourceIdentity(value) {
	return COMMIT_RE.test(value.commit) && SHA256_RE.test(value.sourceDigest) && SHA256_RE.test(value.dirtyDigest) && SHA256_RE.test(value.buildDigest) && typeof value.dirty === "boolean";
}
function environment() {
	return {
		nodeVersion: process.versions.node,
		platform: process.platform,
		arch: process.arch,
		policyVersion: governancePolicyVersion()
	};
}
function receiptDirectory(reviewFile) {
	return join(dirname(reviewFile), "verification-receipts");
}
function isReviewItem$1(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return typeof Reflect.get(value, "id") === "string" && typeof Reflect.get(value, "resolved") === "boolean" && typeof Reflect.get(value, "title") === "string";
}
function loadReview(reviewFile, reviewId) {
	let parsed;
	try {
		parsed = JSON.parse(readRegularFileBounded(reviewFile, 5 * 1024 * 1024).toString("utf8"));
	} catch (error) {
		if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") return void 0;
		throw error;
	}
	if (!Array.isArray(parsed) || !parsed.every(isReviewItem$1)) throw new Error("invalid review state");
	return parsed.find((item) => item.id === reviewId);
}
function actionIsCompatible(action, targetPath, targetExists) {
	if (action === "Archive") return true;
	if (targetPath === void 0) return false;
	return action === "Promote" ? !targetExists : targetExists;
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
function buildVerificationRequest(authority, wikiRoot, item, action) {
	if (item.reviewKind !== "candidate" || item.resolved || !item.candidatePath || !item.candidateHash) return void 0;
	const candidate = resolveGovernedWikiPath(wikiRoot, item.candidatePath, false);
	if (candidate === void 0 || !candidate.relativePath.startsWith("_candidates/")) return void 0;
	const stat = lstatSync(candidate.absolutePath);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return void 0;
	const content = readRegularFileBounded(candidate.absolutePath, 5 * 1024 * 1024).toString("utf8");
	if (sha256(content) !== item.candidateHash) return void 0;
	const target = item.targetPath === void 0 ? void 0 : resolveGovernedWikiPath(wikiRoot, item.targetPath, true);
	if (item.targetPath !== void 0 && target === void 0) return void 0;
	let targetExists = false;
	if (target !== void 0) try {
		const targetStat = lstatSync(target.absolutePath);
		if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.nlink !== 1) return void 0;
		targetExists = true;
	} catch (error) {
		if (!(typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT")) throw error;
	}
	if (!actionIsCompatible(action, item.targetPath, targetExists)) return void 0;
	const sourceIdentity = authority.sourceIdentity();
	if (!validSourceIdentity(sourceIdentity)) throw new Error("invalid trusted source identity");
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
			policyVersion: governancePolicyVersion()
		}),
		sourceIdentity: Object.freeze({ ...sourceIdentity }),
		environment: Object.freeze(environment())
	});
}
function resultIsCoherent(authority, request, result) {
	if (result.authorityId !== authority.authorityId || !ID_RE.test(result.authorityId)) return false;
	if (result.requestHash !== sha256(canonicalJson(request)) || !SHA256_RE.test(result.requestHash)) return false;
	const methods = result.methods;
	if (!Array.isArray(methods) || methods.length === 0 || !methods.every((method) => typeof method === "string" && VERIFICATION_METHODS.has(method))) return false;
	if (!Array.isArray(result.outcomes) || result.outcomes.length === 0) return false;
	if (!result.outcomes.every(isIndependentOutcome)) return false;
	if ((result.outcomes.every((outcome) => outcome.result === "pass") ? "pass" : "fail") !== result.result || !Number.isFinite(Date.parse(result.issuedAt)) || result.proof === "") return false;
	return authority.validateCandidateResult(request, result);
}
function isIndependentOutcome(value) {
	if (typeof value !== "object" || value === null) return false;
	const name = Reflect.get(value, "name");
	const result = Reflect.get(value, "result");
	const evidence = Reflect.get(value, "evidence");
	return typeof name === "string" && name !== "" && (result === "pass" || result === "fail") && Array.isArray(evidence) && evidence.length > 0 && evidence.every((item) => typeof item === "string" && item !== "");
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
async function verifyCandidate(authority, reviewFile, wikiRoot, reviewId, action, signal) {
	if (authority === void 0) return {
		ok: false,
		evidence: [],
		errorCode: "verifier-authority-unavailable"
	};
	const item = loadReview(reviewFile, reviewId);
	if (item === void 0) return {
		ok: false,
		evidence: [],
		errorCode: "review-not-found"
	};
	let request;
	try {
		request = buildVerificationRequest(authority, wikiRoot, item, action);
	} catch (error) {
		if (error instanceof Error && error.message === "invalid trusted source identity") return {
			ok: false,
			evidence: [error.message],
			errorCode: "source-identity-invalid"
		};
		throw error;
	}
	if (request === void 0) return {
		ok: false,
		evidence: [],
		errorCode: "candidate-invalid"
	};
	signal.throwIfAborted();
	const result = await authority.verifyCandidate(request, signal);
	signal.throwIfAborted();
	if (!resultIsCoherent(authority, request, result)) return {
		ok: false,
		evidence: [],
		errorCode: "verification-failed"
	};
	const unsigned = {
		schemaVersion: RECEIPT_SCHEMA,
		request,
		result
	};
	const receiptHash = sha256(canonicalJson(unsigned));
	const id = `verification-${receiptHash.slice(0, 32)}`;
	const receipt = {
		...unsigned,
		id,
		receiptHash
	};
	atomicWriteFile(join(receiptDirectory(reviewFile), `${id}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
	return {
		ok: result.result === "pass",
		receiptId: id,
		result: result.result,
		evidence: result.outcomes.flatMap((outcome) => outcome.evidence),
		...result.result === "pass" ? {} : { errorCode: "verification-failed" }
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
function readTrustedReceipt(authority, reviewFile, receiptId) {
	if (authority === void 0 || !ID_RE.test(receiptId)) return void 0;
	const path = join(receiptDirectory(reviewFile), `${receiptId}.json`);
	let raw;
	try {
		raw = JSON.parse(readRegularFileBounded(path, 2 * 1024 * 1024).toString("utf8"));
	} catch {
		return;
	}
	if (typeof raw !== "object" || raw === null || Reflect.get(raw, "schemaVersion") !== RECEIPT_SCHEMA) return void 0;
	const receipt = raw;
	if (receipt.id !== receiptId) return void 0;
	const { receiptHash, id: _id, ...unsigned } = receipt;
	if (receiptHash !== sha256(canonicalJson(unsigned)) || !resultIsCoherent(authority, receipt.request, receipt.result) || canonicalJson(receipt.request.sourceIdentity) !== canonicalJson(authority.sourceIdentity()) || canonicalJson(receipt.request.environment) !== canonicalJson(environment())) return void 0;
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
function readTrustedVerification(authority, reviewFile, wikiRoot, item, receiptId, expectedAction) {
	const receipt = readTrustedReceipt(authority, reviewFile, receiptId);
	if (receipt === void 0 || receipt.result.result !== "pass" || receipt.request.governanceAction !== expectedAction || authority === void 0) return void 0;
	const path = join(receiptDirectory(reviewFile), `${receiptId}.json`);
	const request = buildVerificationRequest(authority, wikiRoot, item, expectedAction);
	if (request === void 0 || canonicalJson(request) !== canonicalJson(receipt.request)) return void 0;
	const outcomes = receipt.result.outcomes;
	const reference = {
		id: receipt.id,
		path: `verification-receipts/${basename(path)}`,
		receiptHash: receipt.receiptHash,
		environmentHash: sha256(canonicalJson(request.environment)),
		result: "pass",
		gitCommit: request.sourceIdentity.commit
	};
	return {
		receipt,
		verification: {
			status: "passed",
			candidateHash: request.candidateHash,
			action: expectedAction,
			reviewHash: request.reviewHash,
			sourceIdentity: request.sourceIdentity,
			authorityId: receipt.result.authorityId,
			methods: receipt.result.methods,
			evidence: outcomes.flatMap((outcome) => outcome.evidence),
			receipts: [reference],
			confidence: 1,
			successCount: outcomes.filter((outcome) => outcome.result === "pass").length,
			failureCount: outcomes.filter((outcome) => outcome.result === "fail").length,
			verifiedBy: "deterministic-executor",
			lastVerifiedAt: receipt.result.issuedAt
		}
	};
}
//#endregion
//#region lib/types/reviews.js
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
const REVIEW_OPENER_PREFIX_RE = /^---\s*REVIEW\s*:\s*/i;
const REVIEW_CLOSER_RE = /^---\s*END\s+REVIEW\s*---\s*$/i;
/**
* Parse `---REVIEW: <type> | <title>---` blocks out of model output. The
* block body may carry `description:`, `PAGES:` and `SEARCH:` lines; a
* missing closer discards the block.
* @param text - the stage-2 generation output.
* @returns the parsed reviews in output order.
*/
function parseReviewBlocks(text) {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const reviews = [];
	let current = null;
	for (const line of lines) {
		if (current === null) {
			const opener = parseReviewOpener(line);
			if (opener !== null) current = {
				...opener,
				body: []
			};
			continue;
		}
		if (REVIEW_CLOSER_RE.test(line)) {
			const body = current.body.join("\n");
			reviews.push({
				type: current.type,
				title: current.title,
				description: extractField(body, "description"),
				affectedPages: extractListField(body, "PAGES"),
				searchQueries: extractListField(body, "SEARCH")
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
	if (prefix === null) return null;
	const suffixStart = line.lastIndexOf("---");
	if (suffixStart < prefix[0].length) return null;
	const payload = line.slice(prefix[0].length, suffixStart).trim();
	const separator = payload.indexOf("|");
	if (separator < 0) return null;
	return {
		type: payload.slice(0, separator).trim() || "suggestion",
		title: payload.slice(separator + 1).trim() || "Review"
	};
}
/** First `key: value` line of a field (may span the rest of the body). */
function extractField(body, key) {
	for (const line of body.split("\n")) {
		const field = parseFrontmatterField(line);
		if (field !== null && field.key.toLowerCase() === key.toLowerCase()) return field.value.trim();
	}
	return "";
}
/** `KEY:` items: a comma-separated inline list or `- item` block lines. */
function extractListField(body, key) {
	let collecting = false;
	const blockItems = [];
	for (const line of body.split("\n")) {
		const field = parseFrontmatterField(line);
		if (field !== null && field.key.toLowerCase() === key.toLowerCase()) {
			if (field.value !== "") return parseFrontmatterArray(field.value.startsWith("[") ? field.value : `[${field.value}]`);
			collecting = true;
			continue;
		}
		if (!collecting) continue;
		const item = line.trim();
		if (!item.startsWith("-")) break;
		blockItems.push(item);
	}
	return parseFrontmatterArray(blockItems.join("\n"));
}
function resolveCandidateReviewPath(root, input) {
	const governed = resolveGovernedWikiPath(root, input, false);
	return governed?.relativePath.startsWith("_candidates/") === true ? governed : void 0;
}
function resolveCanonicalReviewPath(root, input, allowMissing) {
	const governed = resolveGovernedWikiPath(root, input, allowMissing);
	return governed?.relativePath.startsWith("_candidates/") === true ? void 0 : governed;
}
/** Narrow one durable review row before its fields can direct a mutation. */
function isReviewItem(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const id = Reflect.get(value, "id");
	const title = Reflect.get(value, "title");
	const type = Reflect.get(value, "type");
	const resolved = Reflect.get(value, "resolved");
	return typeof id === "string" && typeof title === "string" && typeof type === "string" && typeof resolved === "boolean";
}
/** Load the persisted review array through its durable JSON boundary. */
function loadReviewItems(reviewFile) {
	try {
		const parsed = JSON.parse(readRegularFileBounded(reviewFile, 8 * 1024 * 1024).toString("utf8"));
		if (!Array.isArray(parsed) || !parsed.every(isReviewItem)) throw new Error("invalid knowledge review state");
		return parsed;
	} catch (error) {
		if (isMissingPathError(error)) return void 0;
		throw error;
	}
}
/** Load one review item once, preserving callers' distinct decision policies. */
function loadReviewItem(reviewFile, reviewIdValue) {
	const all = loadReviewItems(reviewFile);
	if (all === void 0) return void 0;
	const index = all.findIndex((item) => item.id === reviewIdValue);
	const item = index >= 0 ? all[index] : void 0;
	return item === void 0 ? void 0 : {
		all,
		index,
		item
	};
}
/** Replace the durable review array atomically after an in-memory batch update. */
function writeReviewItemsAtomically(reviewFile, items) {
	atomicWriteFile(reviewFile, `${JSON.stringify(items, null, 2)}\n`);
}
function isMissingPathError(error) {
	return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";
}
function pathEntryExists(path) {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (isMissingPathError(error)) return false;
		throw error;
	}
}
function readOptionalRegularFile(path) {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe review transaction file: ${path}`);
		return readRegularFileBounded(path, 8 * 1024 * 1024).toString("utf8");
	} catch (error) {
		if (isMissingPathError(error)) return void 0;
		throw error;
	}
}
function promotionOperation(transactionId, index, role, path, before, after) {
	const suffix = `${transactionId}-${index}`;
	return {
		role,
		path,
		...before === void 0 ? {} : { before },
		...after === void 0 ? {} : { after },
		...after === void 0 ? { tombstonePath: join(dirname(path), `.${basename(path)}.ark-wal-delete-${suffix}`) } : { stagingPath: join(dirname(path), `.${basename(path)}.ark-wal-stage-${suffix}`) }
	};
}
function promotionJournalDirectory(reviewFile) {
	return join(dirname(reviewFile), "promotion-journal");
}
function promotionJournalPath(reviewFile, id) {
	return join(promotionJournalDirectory(reviewFile), `${id}.json`);
}
function assertPromotionOperationConfined(operation, reviewFile, wikiRoot, archiveRoot) {
	if (operation.role === "candidate" || operation.role === "canonical") assertAbsolutePathInside(wikiRoot, operation.path);
	else if (operation.role === "candidate-archive" || operation.role === "canonical-archive") assertAbsolutePathInside(archiveRoot, operation.path);
	else assertAbsolutePathInside(dirname(reviewFile), operation.path);
	for (const auxiliary of [operation.stagingPath, operation.tombstonePath]) {
		if (auxiliary === void 0) continue;
		if (dirname(auxiliary) !== dirname(operation.path)) throw new Error("promotion auxiliary path changed parent");
	}
}
function writePromotionStage(path, content) {
	if (pathEntryExists(path)) {
		if (readOptionalText(path, 8 * 1024 * 1024) !== content) throw new Error(`promotion stage conflict at ${path}`);
		return;
	}
	mkdirSync(dirname(path), {
		recursive: true,
		mode: 448
	});
	const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 384);
	try {
		writeFileSync(descriptor, content);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	const directory = openSync(dirname(path), constants.O_RDONLY);
	try {
		fsyncSync(directory);
	} finally {
		closeSync(directory);
	}
}
function applyPromotionOperation(operation, checkpoint) {
	const current = readOptionalText(operation.path, 8 * 1024 * 1024);
	if (operation.after === void 0) {
		const tombstone = operation.tombstonePath;
		if (tombstone === void 0) throw new Error("promotion delete lacks a tombstone path");
		if (current === void 0) {
			const moved = readOptionalText(tombstone, 8 * 1024 * 1024);
			if (moved === void 0) return;
			if (moved !== operation.before) throw new Error(`promotion tombstone conflict at ${tombstone}`);
			unlinkSync(tombstone);
			checkpoint?.("tombstone-unlinked");
			return;
		}
		if (current !== operation.before) throw new Error(`promotion recovery conflict at ${operation.path}`);
		if (pathEntryExists(tombstone)) throw new Error(`promotion tombstone already exists: ${tombstone}`);
		renameSync(operation.path, tombstone);
		checkpoint?.("entry-renamed");
		if (readOptionalText(tombstone, 8 * 1024 * 1024) !== operation.before) throw new Error(`promotion tombstone identity changed: ${tombstone}`);
		unlinkSync(tombstone);
		checkpoint?.("tombstone-unlinked");
		return;
	}
	if (current === operation.after) return;
	if (current !== operation.before) throw new Error(`promotion recovery conflict at ${operation.path}`);
	const staging = operation.stagingPath;
	if (staging === void 0) throw new Error("promotion write lacks a staging path");
	writePromotionStage(staging, operation.after);
	checkpoint?.("stage-written");
	if (readOptionalText(operation.path, 8 * 1024 * 1024) !== operation.before) throw new Error(`promotion target changed before rename: ${operation.path}`);
	renameSync(staging, operation.path);
	checkpoint?.("entry-renamed");
}
function rollbackPromotionOperation(operation) {
	if (operation.tombstonePath !== void 0) {
		const tombstone = readOptionalText(operation.tombstonePath, 8 * 1024 * 1024);
		if (tombstone !== void 0) {
			if (tombstone !== operation.before || pathEntryExists(operation.path)) throw new Error(`promotion rollback tombstone conflict at ${operation.tombstonePath}`);
			renameSync(operation.tombstonePath, operation.path);
		}
	}
	const current = readOptionalText(operation.path, 8 * 1024 * 1024);
	if (operation.before === void 0) {
		if (current === void 0) {
			if (operation.stagingPath !== void 0) durableUnlinkFile(operation.stagingPath);
			return;
		}
		if (operation.after !== void 0 && current !== operation.after) throw new Error(`promotion rollback conflict at ${operation.path}`);
		durableUnlinkFile(operation.path);
		if (operation.stagingPath !== void 0) durableUnlinkFile(operation.stagingPath);
		return;
	}
	if (current === operation.before) {
		if (operation.stagingPath !== void 0) durableUnlinkFile(operation.stagingPath);
		return;
	}
	if (operation.after !== void 0 && current !== operation.after) throw new Error(`promotion rollback conflict at ${operation.path}`);
	atomicWriteFile(operation.path, operation.before);
	if (operation.stagingPath !== void 0) durableUnlinkFile(operation.stagingPath);
}
function promotionJournalCore(journal) {
	const { state: _state, seal: _seal, ...core } = journal;
	return core;
}
function validatePromotionJournalAuthority(authority, journal) {
	if (authority === void 0 || journal.operationSetHash !== sha256(canonicalJson(journal.operations))) return false;
	return authority.validatePromotion(canonicalJson(promotionJournalCore(journal)), journal.seal);
}
function revalidateJournalBeforeMutation(authority, reviewFile, journal) {
	if (!validatePromotionJournalAuthority(authority, journal)) throw new Error("promotion journal authority validation failed");
	const reviewOperation = journal.operations.find((operation) => operation.role === "review");
	const candidateOperation = journal.operations.find((operation) => operation.role === "candidate");
	if (reviewOperation?.before === void 0 || candidateOperation?.before === void 0) throw new Error("promotion journal lacks immutable pre-state");
	const reviews = JSON.parse(reviewOperation.before);
	if (!Array.isArray(reviews)) throw new Error("promotion journal review pre-state is invalid");
	const item = reviews.find((value) => typeof value === "object" && value !== null && Reflect.get(value, "id") === journal.reviewId);
	if (item === void 0 || item.candidateHash !== journal.candidateHash || createHash("sha256").update(candidateOperation.before).digest("hex") !== journal.candidateHash) throw new Error("promotion journal candidate binding failed");
	if (journal.action !== "Archive") {
		if (journal.receiptId === null || journal.receiptHash === null || journal.reviewHash === null || ![
			"Promote",
			"Merge",
			"Replace",
			"Deduplicate"
		].includes(journal.action)) throw new Error("promotion journal receipt binding is incomplete");
		const receipt = readTrustedReceipt(authority, reviewFile, journal.receiptId);
		if (receipt === void 0 || receipt.result.result !== "pass" || receipt.receiptHash !== journal.receiptHash || receipt.request.reviewHash !== journal.reviewHash || receipt.request.reviewHash !== sha256(canonicalJson(immutableReviewRow(item))) || receipt.request.governanceAction !== journal.action || receipt.request.candidateHash !== journal.candidateHash || receipt.request.candidatePath !== item.candidatePath || receipt.request.targetPath !== journal.targetPath || item.targetPath !== journal.targetPath) throw new Error("promotion journal verified receipt binding failed");
	}
	for (const operation of journal.operations) {
		const current = readOptionalText(operation.path, 8 * 1024 * 1024);
		if (current !== operation.before && current !== operation.after) throw new Error(`promotion journal divergent state at ${operation.path}`);
		if (operation.stagingPath !== void 0) {
			const staged = readOptionalText(operation.stagingPath, 8 * 1024 * 1024);
			if (staged !== void 0 && staged !== operation.after) throw new Error(`promotion journal divergent stage at ${operation.stagingPath}`);
		}
		if (operation.tombstonePath !== void 0) {
			const tombstone = readOptionalText(operation.tombstonePath, 8 * 1024 * 1024);
			if (tombstone !== void 0 && tombstone !== operation.before) throw new Error(`promotion journal divergent tombstone at ${operation.tombstonePath}`);
		}
	}
}
function commitPromotionJournal(authority, reviewFile, wikiRoot, archiveRoot, journal) {
	revalidateJournalBeforeMutation(authority, reviewFile, journal);
	for (const operation of journal.operations) assertPromotionOperationConfined(operation, reviewFile, wikiRoot, archiveRoot);
	ensureConfinedDirectory(dirname(reviewFile), "promotion-journal");
	const path = promotionJournalPath(reviewFile, journal.id);
	atomicWriteFile(path, `${JSON.stringify(journal, null, 2)}\n`);
	authority?.checkpointPromotion?.(canonicalJson(promotionJournalCore(journal)), {
		phase: "journal-persisted",
		operationIndex: -1
	});
	const applied = [];
	let attempted = 0;
	try {
		for (const [operationIndex, operation] of journal.operations.entries()) {
			attempted = operationIndex + 1;
			applyPromotionOperation(operation, (phase) => {
				authority?.checkpointPromotion?.(canonicalJson(promotionJournalCore(journal)), {
					phase,
					operationIndex
				});
			});
			applied.push(operation);
			authority?.checkpointPromotion?.(canonicalJson(promotionJournalCore(journal)), {
				phase: "operation-applied",
				operationIndex
			});
		}
		for (const operation of journal.operations) if (readOptionalText(operation.path, 8 * 1024 * 1024) !== operation.after) throw new Error(`promotion post-commit mismatch at ${operation.path}`);
		authority?.checkpointPromotion?.(canonicalJson(promotionJournalCore(journal)), {
			phase: "before-commit-marker",
			operationIndex: journal.operations.length
		});
		atomicWriteFile(path, `${JSON.stringify({
			...journal,
			state: "committed"
		}, null, 2)}\n`);
	} catch (error) {
		const rollbackErrors = [];
		const rollbackOperations = journal.operations.slice(0, Math.max(applied.length, attempted)).reverse();
		for (const operation of rollbackOperations) try {
			rollbackPromotionOperation(operation);
		} catch (rollbackError) {
			rollbackErrors.push(rollbackError);
		}
		if (rollbackErrors.length === 0) {
			atomicWriteFile(path, `${JSON.stringify({
				...journal,
				state: "rolled-back"
			}, null, 2)}\n`);
			throw error;
		}
		throw new AggregateError([error, ...rollbackErrors], "candidate review transaction failed and rollback was incomplete");
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
function recoverCandidateReviewTransactions(authority, reviewFile, wikiRoot, archiveRoot) {
	const directory = promotionJournalDirectory(reviewFile);
	let entries;
	try {
		const stat = lstatSync(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe promotion journal directory");
		entries = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
	} catch (error) {
		if (isMissingPathError$2(error)) return 0;
		throw error;
	}
	let recovered = 0;
	for (const name of entries) {
		const path = join(directory, name);
		const raw = JSON.parse(readRegularFileBounded(path, 8 * 1024 * 1024).toString("utf8"));
		if (typeof raw !== "object" || raw === null || Reflect.get(raw, "schemaVersion") !== 1) continue;
		const journal = raw;
		if (!/^[A-Za-z0-9._:-]+$/u.test(journal.id) || journal.state !== "prepared" || !Array.isArray(journal.operations)) continue;
		revalidateJournalBeforeMutation(authority, reviewFile, journal);
		for (const operation of journal.operations) assertPromotionOperationConfined(operation, reviewFile, wikiRoot, archiveRoot);
		for (const operation of journal.operations) applyPromotionOperation(operation);
		atomicWriteFile(path, `${JSON.stringify({
			...journal,
			state: "committed"
		}, null, 2)}\n`);
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
function resolveAdvisoryReviewBatch(reviewFile, reviewIds, action) {
	const all = loadReviewItems(reviewFile);
	if (all === void 0) return {
		resolvedCount: 0,
		candidateIds: []
	};
	const requested = new Set(reviewIds);
	const classified = /* @__PURE__ */ new Set();
	const candidateIds = [];
	let resolvedCount = 0;
	for (const [index, item] of all.entries()) {
		if (!requested.has(item.id) || classified.has(item.id)) continue;
		classified.add(item.id);
		if (item.reviewKind === "candidate") {
			candidateIds.push(item.id);
			continue;
		}
		if (item.resolved) continue;
		all[index] = {
			...item,
			resolved: true,
			resolvedAction: action
		};
		resolvedCount += 1;
	}
	if (resolvedCount > 0) writeReviewItemsAtomically(reviewFile, all);
	return {
		resolvedCount,
		candidateIds
	};
}
function readReviewItems(reviewFile) {
	try {
		const parsed = JSON.parse(readRegularFileBounded(reviewFile, 8 * 1024 * 1024).toString("utf8"));
		if (!Array.isArray(parsed) || !parsed.every(isReviewItem)) throw new Error("invalid knowledge review state");
		return parsed;
	} catch (error) {
		if (!isMissingPathError(error)) throw error;
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
function appendReviews(reviewFile, sourcePath, reviews) {
	if (reviews.length === 0) return 0;
	const existing = readReviewItems(reviewFile);
	const now = Date.now();
	const byId = new Map(existing.map((item) => [item.id, item]));
	let appended = 0;
	for (const review of reviews) {
		const id = reviewId(review);
		if (byId.has(id)) continue;
		byId.set(id, {
			id,
			title: review.title,
			type: review.type,
			...review.description === "" ? {} : { description: review.description },
			sourcePath,
			affectedPages: review.affectedPages,
			options: [{
				action: "Skip",
				label: "Skip"
			}],
			reviewKind: "advisory",
			resolved: false,
			createdAt: now,
			searchQueries: review.searchQueries
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
function appendCandidateReviews(reviewFile, projectRoot, sourcePath, writtenPaths) {
	const existing = readReviewItems(reviewFile);
	const byId = new Map(existing.map((item) => [item.id, item]));
	let changed = 0;
	for (const writtenPath of writtenPaths) {
		const candidate = resolveCandidateReviewPath(join(projectRoot, "wiki"), writtenPath.replace(/^wiki\//u, ""));
		if (candidate === void 0) continue;
		const candidatePath = candidate.relativePath;
		const content = readRegularFileBounded(candidate.absolutePath, 5 * 1024 * 1024).toString("utf8");
		const candidateHash = createHash("sha256").update(content).digest("hex");
		const id = `candidate-${createHash("sha256").update(candidatePath).digest("hex").slice(0, 16)}`;
		const title = (/^title:\s*(.+)$/mu.exec(content)?.[1] ?? basename(candidatePath, ".md")).trim().replace(/^["']|["']$/gu, "");
		const suggestedTarget = canonicalTarget(candidatePath);
		const governance = decideCandidateGovernance(join(projectRoot, "wiki"), candidatePath, content, suggestedTarget);
		const targetPath = governance.targetPath;
		const prior = byId.get(id);
		if (prior?.candidateHash === candidateHash && !prior.resolved) continue;
		byId.set(id, {
			id,
			title,
			type: "candidate-approval",
			description: `候选：${candidatePath}${targetPath ? ` → ${targetPath}` : "（自治隔离）"}；自治决定：${governance.action}；置信度：${governance.confidence.toFixed(2)}；评分：${governance.score}/10；${governance.reasons.join("；")}`,
			sourcePath,
			affectedPages: [candidatePath],
			options: [{
				action: "Archive",
				label: "归档候选"
			}],
			resolved: false,
			createdAt: Date.now(),
			reviewKind: "candidate",
			candidatePath,
			candidateHash,
			verification: {
				status: "pending",
				candidateHash,
				methods: [],
				evidence: [],
				receipts: [],
				confidence: 0,
				successCount: 0,
				failureCount: 0
			},
			...targetPath ? { targetPath } : {}
		});
		changed += 1;
	}
	if (changed > 0) writeReviewItemsAtomically(reviewFile, [...byId.values()]);
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
function recordCandidateVerification(authority, reviewFile, wikiRoot, reviewIdValue, receiptId, action) {
	if (typeof receiptId !== "string" || action === void 0) return false;
	const loaded = loadReviewItem(reviewFile, reviewIdValue);
	if (loaded === void 0) return false;
	const { all, index, item } = loaded;
	if (item.reviewKind !== "candidate" || item.resolved || !item.candidatePath || !item.candidateHash) return false;
	const candidate = resolveCandidateReviewPath(wikiRoot, item.candidatePath);
	if (candidate === void 0) return false;
	const actualHash = createHash("sha256").update(readRegularFileBounded(candidate.absolutePath, 5 * 1024 * 1024)).digest("hex");
	if (actualHash !== item.candidateHash) return false;
	const trusted = readTrustedVerification(authority, reviewFile, wikiRoot, item, receiptId, action);
	if (trusted === void 0) return false;
	const nextVerification = trusted.verification;
	all[index] = {
		...item,
		verification: nextVerification,
		options: nextVerification.status === "passed" ? candidateActions(wikiRoot, item.targetPath).filter((option) => option.action === action || option.action === "Archive") : [{
			action: "Archive",
			label: "归档候选"
		}]
	};
	writeReviewItemsAtomically(reviewFile, all);
	appendGovernanceLog(reviewFile, {
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		policyVersion: governancePolicyVersion(),
		reviewId: reviewIdValue,
		action: "Verify",
		actor: nextVerification.verifiedBy ?? "unverified",
		outcome: nextVerification.status,
		candidateHash: actualHash,
		methods: nextVerification.methods,
		evidence: nextVerification.evidence,
		receipts: nextVerification.receipts.map((receipt) => ({
			id: receipt.id,
			receiptHash: receipt.receiptHash,
			environmentHash: receipt.environmentHash,
			result: receipt.result,
			gitCommit: receipt.gitCommit
		})),
		confidence: nextVerification.confidence
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
function applyCandidateReview(authority, reviewFile, projectRoot, wikiRoot, archiveRoot, reviewIdValue, action, actor = "human") {
	if (authority === void 0) return false;
	const loaded = loadReviewItem(reviewFile, reviewIdValue);
	if (loaded === void 0) return false;
	const { all, index, item } = loaded;
	if (item.reviewKind !== "candidate") return null;
	if (item.resolved || !item.candidatePath || !item.candidateHash) return false;
	const candidate = resolveCandidateReviewPath(wikiRoot, item.candidatePath);
	if (candidate === void 0) return false;
	const content = readRegularFileBounded(candidate.absolutePath, 5 * 1024 * 1024).toString("utf8");
	const actualHash = createHash("sha256").update(content).digest("hex");
	if (actualHash !== item.candidateHash) return false;
	const canonicalActions = new Set([
		"Promote",
		"Merge",
		"Replace",
		"Deduplicate"
	]);
	let verifiedReceipt;
	if (canonicalActions.has(action)) {
		const verification = item.verification;
		if (actor === "governance-agent") return false;
		if (!verification || verification.status !== "passed" || verification.candidateHash !== actualHash) return false;
		if (verification.action !== action) return false;
		const receiptId = verification.receipts.length === 1 ? verification.receipts[0]?.id : void 0;
		if (receiptId === void 0) return false;
		const trusted = readTrustedVerification(authority, reviewFile, wikiRoot, item, receiptId, action);
		if (trusted === void 0 || trusted.verification.receipts[0]?.receiptHash !== verification.receipts[0]?.receiptHash) return false;
		verifiedReceipt = trusted.receipt;
	}
	const now = /* @__PURE__ */ new Date();
	const today = now.toISOString().slice(0, 10);
	const resolvedAt = now.getTime();
	let appliedPath = "";
	let previousCanonicalHash = "";
	let targetPath = "";
	let targetAbsolutePath = "";
	let targetBefore;
	let targetAfter;
	let archivedCanonical = "";
	let archivedCanonicalContent = "";
	if (action === "Merge" || action === "Replace" || action === "Deduplicate") {
		if (!item.targetPath) return false;
		const target = resolveCanonicalReviewPath(wikiRoot, item.targetPath, false);
		if (target === void 0) return false;
		const canonicalBefore = readRegularFileBounded(target.absolutePath, 5 * 1024 * 1024).toString("utf8");
		const approvedAt = (/* @__PURE__ */ new Date()).toISOString();
		const next = action === "Merge" ? mergeCandidateIntoCanonical(canonicalBefore, content, approvedAt) : action === "Deduplicate" ? deduplicateCandidateAgainstCanonical(canonicalBefore, content, approvedAt, actor) : replaceCanonicalWithCandidate(canonicalBefore, content, approvedAt);
		const canonicalHash = createHash("sha256").update(canonicalBefore).digest("hex");
		previousCanonicalHash = canonicalHash;
		archivedCanonicalContent = canonicalBefore;
		archivedCanonical = join(archiveRoot, "wiki-governance", today, basename(projectRoot), canonicalHash.slice(0, 12), "canonical-before-update", target.relativePath);
		targetBefore = canonicalBefore;
		targetAfter = target.relativePath.startsWith("_evidence/") ? stampEvidence(next.content, today, actor) : next.content;
		targetAbsolutePath = target.absolutePath;
		targetPath = target.relativePath;
		appliedPath = target.relativePath;
	} else if (action === "Promote") {
		if (!item.targetPath) return false;
		const target = resolveCanonicalReviewPath(wikiRoot, item.targetPath, true);
		if (target === void 0 || pathEntryExists(target.absolutePath)) return false;
		targetAfter = target.relativePath.startsWith("_evidence/") ? stampEvidence(content, today, actor) : stampCanonical(content, today, actor);
		targetAbsolutePath = target.absolutePath;
		targetPath = target.relativePath;
		appliedPath = target.relativePath;
	} else if (action !== "Archive" && action !== "Skip") return false;
	const archived = join(archiveRoot, "wiki-governance", today, basename(projectRoot), actualHash.slice(0, 12), candidate.relativePath);
	if (!appliedPath) appliedPath = archived;
	const resolvedItems = [...all];
	resolvedItems[index] = {
		...item,
		resolved: true,
		resolvedAction: action === "Promote" || action === "Merge" || action === "Replace" || action === "Deduplicate" ? action : "Archive",
		appliedPath,
		resolvedAt
	};
	const governanceEntry = {
		timestamp: now.toISOString(),
		policyVersion: governancePolicyVersion(),
		reviewId: reviewIdValue,
		action,
		actor,
		outcome: "applied",
		candidateHash: actualHash,
		previousCanonicalHash,
		targetPath: item.targetPath ?? "",
		appliedPath
	};
	const governanceLog = join(dirname(reviewFile), "governance.jsonl");
	const reviewBefore = readRegularFileBounded(reviewFile, 8 * 1024 * 1024).toString("utf8");
	const governanceLogBefore = readOptionalRegularFile(governanceLog);
	const reviewAfter = JSON.stringify(resolvedItems, null, 2);
	const governanceLogAfter = `${governanceLogBefore ?? ""}${JSON.stringify(governanceEntry)}\n`;
	if (targetAfter !== void 0) {
		const revalidatedTarget = resolveCanonicalReviewPath(wikiRoot, targetPath, targetBefore === void 0);
		if (revalidatedTarget === void 0 || revalidatedTarget.absolutePath !== targetAbsolutePath) throw new Error(`canonical target changed during review transaction: ${targetPath}`);
		if (targetBefore === void 0) {
			if (pathEntryExists(targetAbsolutePath)) throw new Error(`canonical target appeared during review transaction: ${targetPath}`);
		} else if (readRegularFileBounded(targetAbsolutePath, 5 * 1024 * 1024).toString("utf8") !== targetBefore) throw new Error(`canonical target changed during review transaction: ${targetPath}`);
	}
	const revalidatedCandidate = resolveCandidateReviewPath(wikiRoot, item.candidatePath);
	if (revalidatedCandidate === void 0 || revalidatedCandidate.absolutePath !== candidate.absolutePath) throw new Error(`candidate path changed during review transaction: ${item.candidatePath}`);
	const currentCandidate = readRegularFileBounded(candidate.absolutePath, 5 * 1024 * 1024).toString("utf8");
	if (createHash("sha256").update(currentCandidate).digest("hex") !== actualHash) throw new Error(`candidate content changed during review transaction: ${item.candidatePath}`);
	if (readRegularFileBounded(reviewFile, 8 * 1024 * 1024).toString("utf8") !== reviewBefore) throw new Error("review state changed during review transaction");
	if (readOptionalRegularFile(governanceLog) !== governanceLogBefore) throw new Error("governance log changed during review transaction");
	if (pathEntryExists(archived)) throw new Error(`candidate archive already exists: ${archived}`);
	if (archivedCanonical !== "" && pathEntryExists(archivedCanonical)) throw new Error(`canonical archive already exists: ${archivedCanonical}`);
	const transactionId = `promotion-${createHash("sha256").update(`${reviewIdValue}\0${actualHash}\0${resolvedAt}`).digest("hex").slice(0, 24)}`;
	const operations = [];
	if (archivedCanonical !== "") operations.push(promotionOperation(transactionId, operations.length, "canonical-archive", archivedCanonical, void 0, archivedCanonicalContent));
	operations.push(promotionOperation(transactionId, operations.length, "candidate-archive", archived, void 0, currentCandidate));
	if (targetAfter !== void 0) operations.push(promotionOperation(transactionId, operations.length, "canonical", targetAbsolutePath, targetBefore, targetAfter));
	operations.push(promotionOperation(transactionId, operations.length, "review", reviewFile, reviewBefore, reviewAfter), promotionOperation(transactionId, operations.length + 1, "governance", governanceLog, governanceLogBefore, governanceLogAfter), promotionOperation(transactionId, operations.length + 2, "candidate", candidate.absolutePath, currentCandidate, void 0));
	const core = {
		schemaVersion: 1,
		id: transactionId,
		reviewId: reviewIdValue,
		candidateHash: actualHash,
		createdAt: now.toISOString(),
		action: canonicalActions.has(action) ? action : "Archive",
		targetPath: item.targetPath ?? null,
		reviewHash: verifiedReceipt?.request.reviewHash ?? null,
		receiptId: verifiedReceipt?.id ?? null,
		receiptHash: verifiedReceipt?.receiptHash ?? null,
		operationSetHash: sha256(canonicalJson(operations)),
		operations
	};
	const seal = authority.sealPromotion(canonicalJson(core));
	if (seal.authorityId !== authority.authorityId || seal.proof === "") return false;
	commitPromotionJournal(authority, reviewFile, wikiRoot, archiveRoot, {
		...core,
		state: "prepared",
		seal
	});
	return true;
}
function canonicalTarget(candidatePath) {
	if (candidatePath.startsWith("_candidates/sessions/")) return `concepts/${basename(candidatePath)}`;
	if (candidatePath.startsWith("_candidates/research/")) return `_evidence/research/${basename(candidatePath)}`;
	if (candidatePath.startsWith("_candidates/ingest/")) {
		const rel = candidatePath.slice(19);
		if (/^(concepts|entities|findings|research|methodology)\//u.test(rel)) return rel;
	}
}
function candidateActions(wikiRoot, targetPath) {
	if (!targetPath) return [{
		action: "Archive",
		label: "归档候选"
	}];
	const target = resolveCanonicalReviewPath(wikiRoot, targetPath, true);
	if (target === void 0) return [{
		action: "Archive",
		label: "归档候选"
	}];
	if (existsSync(target.absolutePath)) return [
		{
			action: "Deduplicate",
			label: "保留正式页并去重"
		},
		{
			action: "Merge",
			label: "合并更完整版本"
		},
		{
			action: "Replace",
			label: "用候选替换"
		},
		{
			action: "Archive",
			label: "归档候选"
		}
	];
	return [{
		action: "Promote",
		label: "批准入库"
	}, {
		action: "Archive",
		label: "归档候选"
	}];
}
function stampCanonical(content, today, approvedBy) {
	let output = content;
	if (/^status:\s*/mu.test(output)) output = output.replace(/^status:\s*.*$/mu, "status: canonical");
	else output = output.replace(/^---\n/u, "---\nstatus: canonical\n");
	output = output.replace(/^approved_at:\s*.*\n?/mu, "");
	output = output.replace(/^approved_by:\s*.*\n?/mu, "");
	return output.replace(/^---\n/u, `---\napproved_at: ${today}\napproved_by: ${approvedBy}\n`);
}
function stampEvidence(content, today, approvedBy) {
	return stampCanonical(content, today, approvedBy).replace(/^status:\s*canonical$/mu, "status: evidence");
}
function appendGovernanceLog(reviewFile, entry) {
	const logFile = join(dirname(reviewFile), "governance.jsonl");
	atomicWriteFile(logFile, `${readOptionalRegularFile(logFile) ?? ""}${JSON.stringify(entry)}\n`);
}
/** Deterministic review id: `review-` + FNV-1a hex over type/title/description. */
function reviewId(review) {
	const source = `${review.type}\u0000${review.title}\u0000${review.description}`;
	let hash = 2166136261;
	for (let i = 0; i < source.length; i += 1) {
		hash ^= source.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return `review-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
//#endregion
//#region lib/types/stage-executor.js
/** Hard-deadline execution contract for non-cooperative Knowledge Wiki stages. */
/**
* Recognize the declared stage-executor capability without executing it.
* @param value - Optional service value to inspect.
* @returns True for an owned-worker-v1/owned-subprocess-v1 marker and callable execute member.
* This structural check does not prove that abort actually terminates the isolate.
*/
function isKnowledgeWikiStageExecutor(value) {
	return typeof value === "object" && value !== null && (Reflect.get(value, "isolation") === "owned-worker-v1" || Reflect.get(value, "isolation") === "owned-subprocess-v1") && typeof Reflect.get(value, "execute") === "function";
}
/**
* Enforce the deadline even when an injected executor never settles.
* Timeout/owner cancellation aborts the child signal and rejects without awaiting isolate termination.
* @param executor - Parent-owned executor responsible for terminating its isolate on abort; absence rejects.
* @param request - Stage input with a finite, positive timeoutMs deadline.
* @param ownerSignal - Parent cancellation forwarded to the stage's dedicated controller.
* @returns Stage result if it settles before cancellation/deadline; otherwise rejects and ignores late settlement.
* @throws Rejects for unavailable execution, invalid deadlines, cancellation, timeout, or executor failure.
*/
function executeKnowledgeWikiStage(executor, request, ownerSignal) {
	if (executor === void 0) return Promise.reject(/* @__PURE__ */ new Error("knowledge Wiki stage executor unavailable; refusing non-cooperative work"));
	if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) return Promise.reject(/* @__PURE__ */ new Error("invalid knowledge Wiki stage deadline"));
	if (ownerSignal.aborted) return Promise.reject(ownerSignal.reason instanceof Error ? ownerSignal.reason : /* @__PURE__ */ new Error("knowledge Wiki stage aborted"));
	const controller = new AbortController();
	return new Promise((resolve, reject) => {
		let settled = false;
		function finish(operation) {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			ownerSignal.removeEventListener("abort", abortFromOwner);
			operation();
		}
		const abortFromOwner = () => {
			controller.abort(ownerSignal.reason);
			finish(() => {
				reject(ownerSignal.reason instanceof Error ? ownerSignal.reason : /* @__PURE__ */ new Error("knowledge Wiki stage aborted"));
			});
		};
		ownerSignal.addEventListener("abort", abortFromOwner, { once: true });
		const timeout = setTimeout(() => {
			const error = /* @__PURE__ */ new Error(`knowledge Wiki ${request.kind} timed out after ${request.timeoutMs}ms`);
			controller.abort(error);
			finish(() => {
				reject(error);
			});
		}, request.timeoutMs);
		executor.execute(request, controller.signal).then((value) => {
			finish(() => {
				resolve(value);
			});
		}, (error) => {
			finish(() => {
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	});
}
//#endregion
//#region lib/types/ingest.js
/**
* Two-stage chain-of-thought ingestion: stage 1 analyzes the source into
* entities/concepts/findings, stage 2 generates wiki pages as
* `--- FILE: <path> ---` blocks. The harness LLM runtime supplies both
* calls; generated pages are sanitized, stamped, canonicalized, merged
* with any existing candidate page, and written under the project's
* wiki/_candidates/ingest/ directory. Deterministic fallbacks (candidate
* log entry, source
* summary, review items) run after the model blocks.
* @module @deepseek-ai/dsh-knowledge-wiki/ingest
*/
const OPENER_LINE = /^---\s*FILE:\s*(.+?)\s*---\s*$/i;
const CLOSER_LINE = /^---\s*END\s+FILE\s*---\s*$/i;
const FENCE_LINE = /^\s{0,3}(```+|~~~+)/;
const CANDIDATE_INGEST_PREFIX = "wiki/_candidates/ingest";
const CANDIDATE_LOG_REL = "wiki/_governance/ingest-candidate-log.md";
/** Language rule matching LLM Wiki's: engineering output English, creative output Chinese. */
function languageRule(sourceContent) {
	const creativeHints = /小说|剧本|分镜|角色|叙事|世界观|故事|对白|章节|灵感/;
	const engineeringHints = /代码|函数|类型|测试|接口|部署|提交|构建|调试|bug|tsx?|rs\b/;
	const creative = creativeHints.test(sourceContent);
	const engineering = engineeringHints.test(sourceContent);
	if (creative && !engineering) return "MANDATORY OUTPUT LANGUAGE: Chinese（简体中文）";
	if (engineering && !creative) return "MANDATORY OUTPUT LANGUAGE: English";
	return "MANDATORY OUTPUT LANGUAGE: Chinese（简体中文，工程术语保留英文）";
}
/**
* Stage 1: structured analysis of one source document.
* @param purpose - the project purpose.md text (may be empty).
* @param index - the wiki index text (may be empty).
* @param sourceContent - the source document text.
* @returns the analysis prompt.
*/
function buildAnalysisPrompt(purpose, index, sourceContent) {
	return [
		"You are an expert research analyst. Read the source document and produce a structured analysis.",
		"Do not output chain-of-thought, hidden reasoning, or a thinking transcript. Reason internally and write only the concise final analysis.",
		"",
		languageRule(sourceContent),
		"",
		"Your analysis should cover:",
		"",
		"## Key Entities",
		"List people, organizations, products, datasets, tools mentioned. For each:",
		"- Name and type",
		"- Role in the source (central vs. peripheral)",
		"- Whether it likely already exists in the wiki (check the index)",
		"",
		"## Key Concepts",
		"List theories, methods, techniques, phenomena. For each:",
		"- Name and brief definition",
		"- Why it matters in this source",
		"- Whether it likely already exists in the wiki",
		"",
		"## Main Arguments & Findings",
		"- What are the core claims or results?",
		"- What evidence supports them?",
		"- How strong is the evidence?",
		"- Which claims are reusable outside this one source or task?",
		"- Which claims are already covered by an existing wiki page and should not become a new page?",
		"",
		"## Workflow / Process Notes",
		"- Steps, tool usage patterns, iteration loops described",
		"- Constraints, pitfalls, or rules the source records",
		"",
		"## Suggested Wiki Pages",
		"Recommend concrete pages (type + path + one-line purpose) this source warrants.",
		"For every suggestion, state: admission=KEEP_CANDIDATE|EVIDENCE_ONLY|SKIP, novelty=new|extends|duplicate, evidence strength, applicability, and the canonical merge target when one exists.",
		"Do not suggest a page for conversational commands, task progress, tool transcripts, completion claims, local paths, commit hashes, build artifacts, or one-off troubleshooting history.",
		"If the source contains no reusable knowledge, explicitly return NO_CANONICAL_KNOWLEDGE.",
		"A reflection is not a fact. Classify it as a hypothesis unless it contains a reproducible failure pattern, evidence-backed cause, counterfactual action, prevention step, applicability boundary, and at least two independent sources.",
		"",
		"## Project Purpose (context)",
		purpose.trim() === "" ? "(none provided)" : purpose,
		"",
		"## Existing Wiki Index (partial)",
		index.trim() === "" ? "(none provided)" : index.slice(0, 8e3),
		"",
		"## Source Document",
		"<<<",
		sourceContent.slice(0, 6e4),
		">>>"
	].join("\n");
}
/**
* Stage 2: wiki page generation from the stage-1 analysis.
* @param options - generation prompt inputs.
* @returns the generation prompt.
*/
function buildGenerationPrompt(options) {
	const { purpose, index, sourceFileName, sourceContent, analysis, today, schema, summaryPath } = options;
	return [
		"You are a wiki maintainer. Based on the analysis provided, generate wiki files.",
		"Do not output chain-of-thought, hidden reasoning, or explanatory preamble. Reason internally and output only the requested FILE blocks.",
		"",
		languageRule(sourceContent),
		"",
		"## IMPORTANT: Today's Date",
		`Today is ${today}. Use this exact date for every created/updated field and log entry.`,
		"",
		"## IMPORTANT: Source File",
		`The original source file is: **${sourceFileName}**`,
		"All wiki pages generated from this source MUST include this filename in their frontmatter `sources` field.",
		"",
		"## What to generate",
		"",
		`1. A source summary candidate at **${summaryPath}** (MUST use this exact path)`,
		"2. Entity candidates at wiki/_candidates/ingest/entities/ only for stable, central identities supported by meaningful claims",
		"3. Concept candidates at wiki/_candidates/ingest/concepts/ only for reusable knowledge that passes every admission gate below",
		`4. A candidate log entry for ${CANDIDATE_LOG_REL} (format: ## [YYYY-MM-DD] ingest | Title)`,
		"",
		"## Canonical Admission Gate",
		"",
		"A concept or entity candidate is allowed only when all are true:",
		"- It adds a reusable claim, method, constraint, or decision beyond this one task.",
		"- Its source evidence is explicit and the body distinguishes evidence from inference.",
		"- It is not a duplicate; extending an existing topic must target that page for merge instead of creating a sibling.",
		"- It states applicability, limits, exceptions, or verification steps.",
		"- It contains no conversation transcript, tool log, progress narration, local path, commit hash, build artifact, or unsupported completion claim.",
		"- Reflections use candidate_kind: reflection and epistemic_status: hypothesis. They never become Canonical from one source or one conversation.",
		"- A verified reflection requires at least two independent sources plus explicit verification evidence; repeated messages from one session are one source.",
		"When any gate fails, generate no entity/concept candidate. Keep only the source summary candidate and log entry as Evidence/Candidate material.",
		"",
		"## Frontmatter Rules (CRITICAL — parser is strict)",
		"",
		"1. The VERY FIRST line of the file MUST be exactly `---` (three hyphens, nothing else).",
		"2. Every page needs frontmatter fields: type, status, origin, title, tags, related, created, updated, sources.",
		"3. Every generated page MUST use `status: candidate` and `origin: ingest`.",
		"4. `sources` MUST include the original source filename; array fields use the form [\"item1\", \"item2\"].",
		"5. Do NOT wrap files in code fences in your output.",
		"6. Use `## [YYYY-MM-DD] ingest | Title` (today's date) for the log entry heading.",
		"",
		"## Output format (STRICT)",
		"",
		"Wrap every file exactly like this:",
		"",
		"--- FILE: wiki/_candidates/ingest/concepts/example.md ---",
		"---",
		"type: concept",
		"status: candidate",
		"origin: ingest",
		"title: Example",
		"tags: []",
		"related: []",
		`created: ${today}`,
		`updated: ${today}`,
		"sources: [\"original-source.md\"]",
		"---",
		"",
		"# Example",
		"",
		"Page body…",
		"--- END FILE ---",
		"",
		"## Project Schema (context)",
		schema.trim() === "" ? "(none provided)" : schema.slice(0, 8e3),
		"",
		"## Project Purpose (context)",
		purpose.trim() === "" ? "(none provided)" : purpose,
		"",
		"## Existing Wiki Index (partial)",
		index.trim() === "" ? "(none provided)" : index.slice(0, 8e3),
		"",
		"## Analysis (stage 1 output)",
		"<<<",
		analysis,
		">>>"
	].join("\n");
}
/**
* Parse `--- FILE: path --- … --- END FILE ---` blocks out of model output.
* @param text - The text input.
* @returns The value produced by parse file blocks.
*/
function parseFileBlocks(text) {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const blocks = [];
	let current = null;
	for (const line of lines) {
		if (current === null) {
			const openedPath = OPENER_LINE.exec(line)?.[1];
			if (openedPath !== void 0) current = {
				path: openedPath.trim(),
				content: [],
				fenceMarker: null,
				fenceLength: 0
			};
			continue;
		}
		const fenceRun = FENCE_LINE.exec(line)?.[1];
		if (fenceRun !== void 0) {
			const marker = fenceRun.charAt(0);
			if (current.fenceMarker === null) {
				current.fenceMarker = marker;
				current.fenceLength = fenceRun.length;
			} else if (marker === current.fenceMarker && fenceRun.length >= current.fenceLength) {
				current.fenceMarker = null;
				current.fenceLength = 0;
			}
			current.content.push(line);
			continue;
		}
		if (current.fenceMarker === null && CLOSER_LINE.test(line)) {
			blocks.push({
				path: current.path,
				content: current.content.join("\n"),
				closed: true
			});
			current = null;
			continue;
		}
		current.content.push(line);
	}
	if (current !== null) blocks.push({
		path: current.path,
		content: current.content.join("\n"),
		closed: false
	});
	return blocks;
}
/** Reject FILE block paths that escape the project's wiki/ directory.
* FILE paths are project-relative (e.g. wiki/concepts/x.md), matching the
* LLM Wiki prompt contract. */
function safeWikiPath(projectPath, rel) {
	const wikiRoot = resolve(projectPath, "wiki");
	const target = resolve(normalize(join(projectPath, rel)));
	if (!target.startsWith(wikiRoot + sep)) throw new Error(`ingest: FILE path escapes wiki directory: ${rel}`);
	return target;
}
/** Route every generated wiki path into the non-graph candidate namespace. */
function candidateIngestRel(rel) {
	if (rel === CANDIDATE_LOG_REL || rel.startsWith(`${CANDIDATE_INGEST_PREFIX}/`)) return rel;
	if (!rel.startsWith("wiki/")) throw new Error(`ingest: FILE path must start with wiki/: ${rel}`);
	if (rel === "wiki/log.md") return CANDIDATE_LOG_REL;
	return `${CANDIDATE_INGEST_PREFIX}/${rel.slice(5)}`;
}
/** Enforce candidate provenance even when the model omits the required fields. */
function stampCandidateFrontmatter(content) {
	if (!content.startsWith("---\n")) return content;
	let stamped = content;
	if (/^status:\s*/mu.test(stamped)) stamped = stamped.replace(/^status:\s*.*$/mu, "status: candidate");
	else stamped = stamped.replace(/^---\n/u, "---\nstatus: candidate\n");
	if (/^origin:\s*/mu.test(stamped)) stamped = stamped.replace(/^origin:\s*.*$/mu, "origin: ingest");
	else stamped = stamped.replace(/^---\n/u, "---\norigin: ingest\n");
	return stamped;
}
/** Read a text file (best effort). */
async function optionalText(path) {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (!isMissingPathError$2(error)) throw error;
		return "";
	}
}
/** Append one log entry to wiki/log.md (existing entries preserved). */
async function appendLogEntry(logPath, entry) {
	atomicWriteFile(logPath, (await optionalText(logPath)).replace(/\n*$/, "\n\n") + entry + "\n");
}
/**
* Run the two-stage ingestion for one source file and write the generated
* pages. Every extraction/model stage runs through the injected owned
* worker/subprocess executor; this package refuses an in-process fallback.
* Extraction has a 60-second deadline and each model stage has 120 seconds.
* Candidate pages/log entries and reviews can be partially written; per-write failures become warnings.
* @param executor - parent-owned worker/subprocess stage executor.
* @param provider - LLM provider id (e.g. deepseek-official).
* @param model - exact model id.
* @param projectPath - absolute project root.
* @param sourceRel - project-relative source path (e.g. raw/sources/x.md).
* @param signal - Cancels executor stages and is checked between reads and before selected writes; no rollback.
* @returns Written project-relative wiki/_candidates paths and warnings, including caught write-time cancellation.
* @throws On uncaught cancellation, stage failures/missing text, or source/context read failures.
*/
async function ingestSource(executor, provider, model, projectPath, sourceRel, signal) {
	signal.throwIfAborted();
	const warnings = [];
	const identity = sourceIdentityForPath(projectPath, join(projectPath, sourceRel));
	const sourceTitle = basename(sourceRel).replace(/\.[^.]+$/u, "");
	const extracted = await executeKnowledgeWikiStage(executor, {
		kind: "file-extract",
		path: join(projectPath, sourceRel),
		timeoutMs: 6e4
	}, signal);
	signal.throwIfAborted();
	const sourceContent = extracted.text ?? "";
	if (sourceContent.trim() === "") return {
		written: [],
		warnings: [...warnings, "source content is empty"]
	};
	const purpose = await optionalText(join(projectPath, "purpose.md"));
	signal.throwIfAborted();
	const schema = await optionalText(join(projectPath, "schema.md"));
	signal.throwIfAborted();
	const index = await optionalText(join(projectPath, "wiki", "index.md"));
	signal.throwIfAborted();
	const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
	const summaryFileName = sourceSummaryFileNameFromIdentity(identity);
	const analysis = await executeKnowledgeWikiStage(executor, {
		kind: "llm-complete",
		provider,
		model,
		prompt: buildAnalysisPrompt(purpose, index, sourceContent),
		operation: "ingest analysis",
		timeoutMs: 12e4
	}, signal);
	if (analysis.text === null) throw new Error("ingest analysis returned no text");
	const generated = await executeKnowledgeWikiStage(executor, {
		kind: "llm-complete",
		provider,
		model,
		prompt: buildGenerationPrompt({
			purpose,
			index,
			sourceFileName: sourceRel,
			sourceContent,
			analysis: analysis.text,
			today,
			schema,
			summaryPath: `${CANDIDATE_INGEST_PREFIX}/sources/${summaryFileName}`
		}),
		operation: "ingest generation",
		timeoutMs: 12e4
	}, signal);
	if (generated.text === null) throw new Error("ingest generation returned no text");
	const written = [];
	for (const block of parseFileBlocks(generated.text)) {
		signal.throwIfAborted();
		if (!block.closed) {
			warnings.push(`FILE block not closed: ${block.path}`);
			continue;
		}
		let rel = block.path;
		if (rel === `wiki/sources/${sourceTitle}.md`) rel = `wiki/sources/${summaryFileName}`;
		try {
			rel = candidateIngestRel(rel);
			const target = safeWikiPath(projectPath, rel);
			if (rel === CANDIDATE_LOG_REL) {
				const entry = block.content.replace(/^---[\s\S]*?---\n\n?/u, "").trim();
				if (entry !== "") {
					await appendLogEntry(target, stampGeneratedLogDate(entry, today));
					written.push(rel);
				}
				continue;
			}
			let content = sanitizeIngestedFileContent(block.content);
			content = stampGeneratedFrontmatterDates(content, today);
			content = stampSourcesField(content, identity);
			content = stampCandidateFrontmatter(content);
			const existing = await optionalText(target);
			if (existing !== "") {
				const merged = mergePageContent(existing, content, identity, today);
				if (merged === existing) {
					warnings.push(`merge left page unchanged (missing/empty sources): ${rel}`);
					continue;
				}
				content = merged;
			}
			signal.throwIfAborted();
			atomicWriteFile(target, content);
			written.push(rel);
		} catch (error) {
			warnings.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (!written.includes(CANDIDATE_LOG_REL)) try {
		signal.throwIfAborted();
		await appendLogEntry(join(projectPath, CANDIDATE_LOG_REL), `## [${today}] ingest | ${sourceTitle}`);
		written.push(CANDIDATE_LOG_REL);
	} catch (error) {
		warnings.push(`log append failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	const summaryRel = candidateIngestRel(fallbackSummaryRelPath(identity));
	if (!written.includes(summaryRel)) try {
		signal.throwIfAborted();
		atomicWriteFile(safeWikiPath(projectPath, summaryRel), stampCandidateFrontmatter(buildFallbackSourceSummaryPage(identity, today)));
		written.push(summaryRel);
	} catch (error) {
		warnings.push(`summary fallback failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		signal.throwIfAborted();
		const reviews = parseReviewBlocks(generated.text);
		if (reviews.length > 0) appendReviews(join(projectPath, ".llm-wiki", "review.json"), join(projectPath, sourceRel), reviews);
	} catch (error) {
		warnings.push(`review append failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		signal.throwIfAborted();
		appendCandidateReviews(join(projectPath, ".llm-wiki", "review.json"), projectPath, sourceRel, written);
	} catch (error) {
		warnings.push(`candidate review failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	return {
		written,
		warnings
	};
}
//#endregion
//#region lib/types/auto-sediment.js
/**
* 对话自动沉淀（Auto-Sediment）
*
* 监听 `agent/turn-stopping`：每轮对话即将收尾时，把该轮的用户输入与
* 助手最终回复提炼为候选页，写入 **当前工作区** 的 wiki/_candidates/。
* 这样每个工作区的知识图谱会随对话自然增长，成为该工作区的独立子图谱；
* 万相织鉴总库通过 workspace-to-master.mjs 定期汇总各工作区精华。
*
* 幂等：同一会话同一 turn 只写一次（页面前言记录 sessionId + turn）。
* 去噪：空回复、纯工具轮、超短回复（<40 字）跳过。
* 分流：LLM 语义判定（classifyWithLlm）优先，把"针对一个具体问题"的反思
* 沉淀到 _candidates/turns/问题解决/（kind: problem-solving），其余进
* _candidates/turns/会话沉淀/；候选页不进入主图谱，等待治理审批。
* LLM 失败/超时（30s）时降级到本地启发式 classifyKind（零成本兜底，仅保底不追求完备）。
*
* @module @deepseek-ai/dsh-knowledge-wiki/auto-sediment
*/
/**
* 沉淀目标：由会话所属工作区（header.cwd）决定写哪个 wiki。
*
* 主工作区（cwd === mainRoot 或其子路径）不实时沉淀——主库会话全部走
* 批量摄取（raw/sources → ingest），避免重复，也防止子图谱目录
* （如 `<mainRoot>/deepseek-harness/wiki`）混进主库文件树。
* 其余工作区写入 `<cwd>/wiki`，形成该工作区的独立子图谱，再由
* workspace-to-master.mjs 汇总进总库。
*
* @param cwd - 会话所属工作区的真实路径（SessionHeader.cwd）。
* @param mainRoot - 主工作区根（批量摄取覆盖，实时沉淀跳过；子路径同）。
* @returns 目标 wiki 根与工作区名；主工作区或无 cwd 时为 null（跳过）。
*/
function sedimentTarget(cwd, mainRoot) {
	if (!cwd) return null;
	if (cwd === mainRoot || cwd.startsWith(mainRoot + "/")) return null;
	return {
		wikiRoot: join(cwd, "wiki"),
		workspaceName: basename(cwd)
	};
}
/**
* 从事件记录中提取可读文本块（只取纯文本块，reasoning/tool-call 块跳过）。
*
* 输入可以是三种形态：字符串、内容块数组（`data.content` 的直接值）、
* 或含 `content`/`text` 属性的对象（`data.message` 等）。
*/
function textOf(value) {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map((block) => {
		if (typeof block === "string") return block;
		if (typeof block !== "object" || block === null || Array.isArray(block)) return "";
		const record = block;
		if (typeof record.text === "string" && (record.type === void 0 || record.type === "text")) return record.text;
		return "";
	}).filter(Boolean).join("\n");
	if (value && typeof value === "object") {
		const record = value;
		if (typeof record.text === "string") return record.text;
		if (Array.isArray(record.content)) return textOf(record.content);
	}
	return "";
}
/** Return a boundary field only when it is already plain text. */
function stringValue(value) {
	return typeof value === "string" ? value : "";
}
/** Collapse exact and cumulative message snapshots while preserving real deltas. */
function dedupeMessageParts(parts) {
	const out = [];
	for (const raw of parts) {
		const part = raw.trim();
		if (out.includes(part)) continue;
		const prefixIndex = out.findIndex((existing) => part.startsWith(existing));
		if (prefixIndex >= 0) {
			out[prefixIndex] = part;
			continue;
		}
		if (out.some((existing) => existing.startsWith(part))) continue;
		out.push(part);
	}
	return out;
}
/**
* 转义对话文本中的 wikilink 语法：对话里出现的 `[[xxx]]` 是会话内容，
* 不是知识库链接语义——原样写入会制造指向不存在的页面的断链。
*/
function escapeWikilinks(text) {
	return text.replace(/\[\[/gu, "[").replace(/\]\]/gu, "]");
}
/**
* 已存在则跳过（幂等辅助，供调用方判断）。
* @param wikiRoot - The wiki root input.
* @param rel - The rel input.
* @returns The value produced by page exists.
*/
function pageExists(wikiRoot, rel) {
	return existsSync(join(wikiRoot, rel));
}
/**
* 提取会话全部对话文本（按轮组织，供 LLM 提炼）。
*
* 与 extractTurnPair 同源 schema：turn/start 划段，user/assistant 文本取
* data.content[] / data.message.content[]。输出形如：
*   第 1 轮
*   用户：…
*   助手：…
*   第 2 轮 …
* @param events - The events input.
* @returns The value produced by extract conversation text.
*/
function extractConversationText(events) {
	const parts = [];
	let currentTurn = 0;
	let turnParts = [];
	const flush = () => {
		if (turnParts.length > 0) parts.push(`第 ${currentTurn} 轮\n${turnParts.join("\n")}`);
		turnParts = [];
	};
	for (const ev of events) {
		if (!ev || typeof ev !== "object") continue;
		const e = ev;
		const type = stringValue(e.type);
		if (type === "turn/start") {
			flush();
			currentTurn++;
			continue;
		}
		if (currentTurn === 0) continue;
		const data = e.data && typeof e.data === "object" ? e.data : {};
		if (type === "user/message") {
			const t = textOf(data.content).trim();
			if (t) turnParts.push(`用户：${t.slice(0, 800)}`);
		} else if (type === "assistant/message") {
			const t = textOf((data.message && typeof data.message === "object" ? data.message : {}).content ?? data.content).trim();
			if (t) turnParts.push(`助手：${t.slice(0, 1500)}`);
		}
	}
	flush();
	return dedupeMessageParts(parts).join("\n\n").slice(0, 24e3);
}
/**
* 生成会话提炼页 Markdown（frontmatter + LLM 提炼正文）。
* @param opts - The opts input.
* @returns The value produced by build session summary page.
*/
function buildSessionSummaryPage(opts) {
	const { title, summary, related, sessionId, today, workspaceName, candidateKind = "knowledge", epistemicStatus = "hypothesis", evidenceCount = 1, independentSourceCount = 1, resolutionStatus, issueId } = opts;
	const safeTitle = title.replace(/\n/gu, " ").trim().slice(0, 40);
	const relatedList = related.length > 0 ? `[${related.map((r) => `"${r.replace(/"/gu, "")}"`).join(", ")}]` : "[]";
	return [
		"---",
		"type: concept",
		"status: candidate",
		"origin: session",
		`candidate_id: ${workspaceName}:${sessionId}:session`,
		`candidate_kind: ${candidateKind}`,
		`epistemic_status: ${epistemicStatus}`,
		`evidence_count: ${Math.max(1, evidenceCount)}`,
		`independent_source_count: ${Math.max(1, independentSourceCount)}`,
		...resolutionStatus ? [`resolution_status: ${resolutionStatus}`] : [],
		...issueId ? [`issue_id: ${issueId}`] : [],
		`title: ${safeTitle}`,
		"tags: [会话提炼, 自动生成]",
		`related: ${relatedList}`,
		`created: ${today}`,
		`updated: ${today}`,
		`sources: ["workspace:${workspaceName}", "session:${sessionId}"]`,
		"---",
		""
	].join("\n") + [
		`# ${safeTitle}`,
		"",
		"> 本页由「会话 AI 提炼」在会话结束时生成：把整段对话浓缩为可复用知识。",
		"",
		escapeWikilinks(summary.trim().slice(0, 6e3)),
		""
	].join("\n") + "\n";
}
//#endregion
//#region lib/types/research.js
/**
* Deep-research pipeline (Ark-native port of LLM Wiki's): one topic →
* LLM-generated multi-queries → web search through the harness web runtime →
* a synthesized research candidate written into wiki/_candidates/research/.
* both query expansion and synthesis; the web seam supplies citeable sources.
* @module @deepseek-ai/dsh-knowledge-wiki/research
*/
/** Parse 3-5 search queries out of the LLM expansion output. */
function parseQueries(text) {
	const lines = text.split("\n").map((line) => line.replace(/^[-*•\d.)\s]+/, "").trim()).filter((line) => line.length >= 3 && line.length <= 120);
	return [...new Set(lines)].slice(0, 5);
}
/**
* Run the deep-research pipeline for one topic.
* Query expansion and synthesis each have a 120-second deadline; each search has 60 seconds.
* Search and page-write failures become warnings; written Candidate pages are not rolled back.
* @param executor - Parent-owned worker/subprocess executor for model and web-search stages; absence rejects.
* @param provider - LLM provider id.
* @param model - exact model id.
* @param projectPath - absolute project root.
* @param topic - the research topic.
* @param signal - Cancels executor stages; the page-write loop does not check it after synthesis completes.
* @returns Project-relative wiki/_candidates/research paths, unique source URL count, and warnings.
* @throws If query expansion or synthesis fails, times out, or observes cancellation.
*/
async function deepResearch(executor, provider, model, projectPath, topic, signal) {
	const warnings = [];
	const queries = parseQueries((await executeKnowledgeWikiStage(executor, {
		kind: "llm-complete",
		provider,
		model,
		prompt: [
			"You are a research assistant. Given one research topic, produce 3-5 focused web-search queries that together cover the topic.",
			"Output ONLY the queries, one per line, no numbering, no preamble, no other text.",
			"Queries should be specific, search-engine-friendly, and complementary (different angles, not rewordings).",
			"",
			"MANDATORY OUTPUT LANGUAGE: match the topic language; English queries are fine for English sources.",
			"",
			`Topic: ${topic}`
		].join("\n"),
		operation: "research query expansion",
		timeoutMs: 12e4
	}, signal)).text ?? "");
	if (queries.length === 0) return {
		written: [],
		sourceCount: 0,
		warnings: ["research: LLM produced no usable queries"]
	};
	const sources = [];
	const seenUrls = /* @__PURE__ */ new Set();
	for (const query of queries) try {
		const result = await executeKnowledgeWikiStage(executor, {
			kind: "web-search",
			query,
			maxResults: 4,
			timeoutMs: 6e4
		}, signal);
		for (const source of result.sources ?? []) {
			if (seenUrls.has(source.url)) continue;
			seenUrls.add(source.url);
			sources.push(source);
		}
	} catch (error) {
		warnings.push(`search "${query}" failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	const sourceDigest = sources.map((source, i) => `${i + 1}. ${source.title ?? source.url}\n   URL: ${source.url}\n   ${source.snippet ?? ""}`).join("\n");
	const synthesis = await executeKnowledgeWikiStage(executor, {
		kind: "llm-complete",
		provider,
		model,
		prompt: [
			"You are a research synthesist. Based on the topic and the collected web sources, generate one wiki research page.",
			"Do not output chain-of-thought or preamble. Output ONLY the FILE block.",
			"The page must include a summary of findings, key points with source citations (as markdown links), and open questions.",
			"",
			"Output format (STRICT):",
			"--- FILE: wiki/_candidates/research/<slug>.md ---",
			"---",
			"type: research",
			"status: candidate",
			"origin: research",
			"title: <topic title>",
			"tags: [deep-research]",
			"related: []",
			"created: <today>",
			"updated: <today>",
			"sources: [<all source URLs>]",
			"---",
			"",
			"# <topic title>",
			"",
			"## 摘要",
			"...",
			"## 关键发现",
			"- ... [source title](url)",
			"## 待决问题",
			"- ...",
			"--- END FILE ---",
			"",
			`Today is: ${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.`,
			"",
			`Topic: ${topic}`,
			"",
			"Collected sources:",
			sourceDigest === "" ? "(none — synthesize from general knowledge and mark clearly)" : sourceDigest
		].join("\n"),
		operation: "research synthesis",
		timeoutMs: 12e4
	}, signal);
	const written = [];
	for (const block of parseFileBlocks(synthesis.text ?? "")) {
		if (!block.closed) {
			warnings.push(`FILE block not closed: ${block.path}`);
			continue;
		}
		const wikiRoot = resolve(projectPath, "wiki");
		const rel = `wiki/_candidates/research/${basename(block.path)}`;
		const target = resolve(join(projectPath, rel));
		if (!target.startsWith(wikiRoot + sep)) {
			warnings.push(`research: FILE path escapes wiki directory: ${block.path}`);
			continue;
		}
		try {
			await mkdir(dirname(target), { recursive: true });
			let content = block.content;
			if (!/^status:\s*/mu.test(content)) content = content.replace(/^---\n/u, "---\nstatus: candidate\n");
			if (!/^origin:\s*/mu.test(content)) content = content.replace(/^---\n/u, "---\norigin: research\n");
			atomicWriteFile(target, content);
			written.push(rel);
		} catch (error) {
			warnings.push(error instanceof Error ? error.message : String(error));
		}
	}
	return {
		written,
		sourceCount: sources.length,
		warnings
	};
}
//#endregion
//#region lib/types/html-clip.js
/**
* HTML → Markdown-ish plain text conversion for the URL ingest path.
* Deliberately crude: strip scripts/styles/nav clutter, keep headings,
* links, and paragraph text. The two-stage LLM pipeline tolerates imperfect
* input; this only needs to preserve the readable body.
*/
/** Extract the page title if present. */
function extractTitle(html, fallbackUrl) {
	const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	if (match?.[1]) return match[1].trim().slice(0, 200);
	try {
		return new URL(fallbackUrl).hostname;
	} catch {
		return fallbackUrl;
	}
}
/** Strip one HTML tag from the body. */
function stripTag(html, tag) {
	return html.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
}
/**
* Convert HTML body text into rough Markdown.
* @param html - The html input.
* @param sourceUrl - The source url input.
* @returns The value produced by html to markdown.
*/
function htmlToMarkdown(html, sourceUrl) {
	const title = extractTitle(html, sourceUrl);
	let body = html;
	for (const tag of [
		"script",
		"style",
		"noscript",
		"svg",
		"nav",
		"footer",
		"header",
		"aside"
	]) body = stripTag(body, tag);
	body = body.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_m, text) => `\n# ${text.trim()}\n`).replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_m, text) => `\n## ${text.trim()}\n`).replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_m, text) => `\n### ${text.trim()}\n`).replace(/<p[^>]*>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(div|section|article|li|tr|blockquote)>/gi, "\n").replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
		const label = text.trim();
		if (label === "") return "";
		return href.startsWith("http") ? `[${label}](${href})` : label;
	}).replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, "\"").replace(/&#39;/gi, "'");
	const cleaned = body.split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
	return [
		"---",
		"type: source",
		`title: ${title}`,
		"tags: [web-clip]",
		"related: []",
		"created: " + (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
		"updated: " + (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
		`sources: ["${sourceUrl}"]`,
		"---",
		"",
		`# ${title}`,
		"",
		`> 来源：${sourceUrl}`,
		"",
		cleaned,
		""
	].join("\n");
}
//#endregion
//#region lib/types/vision.js
/**
* Image-path classification for the isolated multimodal ingest stage.
* @module @deepseek-ai/dsh-knowledge-wiki/vision
*/
const MIME_BY_EXT = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".svg": "image/svg+xml"
};
/**
* Whether a file path looks like a supported image.
* @param path - The path input.
* @returns The value produced by is image path.
*/
function isImagePath(path) {
	return extname(path).toLowerCase() in MIME_BY_EXT;
}
//#endregion
//#region lib/types/index.js
/**
* 万相织鉴 host service: the in-process knowledge engine behind the
* concept-graph tab. Owns the wiki page tree (graph + Louvain communities),
* hybrid search, page editing, the two-stage LLM ingest pipeline with a
* persisted queue, review items, and deep research — all inside the harness.
* @module @deepseek-ai/dsh-knowledge-wiki
*/
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
const MAX_RAW_SOURCE_BYTES = 100 * 1024 * 1024;
/**
* Strict endpoint metadata for the later Gateway/Native lane. This package
* declares the contract only; it does not bypass or self-register Gateway routes.
*/
const KNOWLEDGE_WIKI_ENDPOINT_METADATA = Object.freeze({ verifyCandidate: Object.freeze({
	endpoint: "knowledgeWiki/verifyCandidate",
	owner: "knowledgeWiki",
	transport: "strict-remote",
	requiresVerifierAuthority: true,
	verifierAuthorityService: "knowledgeWikiVerifierAuthority",
	sourceIdentitySchema: "commit40+sourceDigest+dirtyDigest+buildDigest",
	nativeIntegration: "pending"
}) });
/** Preserve immediate synchronous work while exposing the Remote Promise contract. */
function promiseFromSync(operation) {
	try {
		return Promise.resolve(operation());
	} catch (cause) {
		return Promise.reject(cause instanceof Error ? cause : new Error("knowledge-wiki synchronous operation failed", { cause }));
	}
}
/** Narrow the optional session-query seam without adding a hard package edge. */
function isSessionQueryReader(value) {
	return typeof value === "object" && value !== null && typeof value.readSession === "function";
}
let KnowledgeWikiService = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _graph_decorators;
	let _fullGraph_decorators;
	let _list_decorators;
	let _search_decorators;
	let _knowledgeUtility_decorators;
	let _recordKnowledgeOutcome_decorators;
	let _pageContent_decorators;
	let _writePage_decorators;
	let _createPage_decorators;
	let _ingestSource_decorators;
	let _ingestUrl_decorators;
	let _ingestQueueAdd_decorators;
	let _ingestQueueStatus_decorators;
	let _ingestQueueCancel_decorators;
	let _deepResearch_decorators;
	let _reviews_decorators;
	let _verifyCandidate_decorators;
	let _resolveReview_decorators;
	let _resolveReviews_decorators;
	let _listProjects_decorators;
	let _setProject_decorators;
	let _createProject_decorators;
	let _removeProject_decorators;
	let _graphInsights_decorators;
	let _lint_decorators;
	let _exportProject_decorators;
	let _importProject_decorators;
	return class KnowledgeWikiService extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_graph_decorators = [Remote("graph")];
			_fullGraph_decorators = [Remote("fullGraph")];
			_list_decorators = [Remote("list")];
			_search_decorators = [Remote("search")];
			_knowledgeUtility_decorators = [Remote("knowledgeUtility")];
			_recordKnowledgeOutcome_decorators = [Remote("recordKnowledgeOutcome")];
			_pageContent_decorators = [Remote("pageContent")];
			_writePage_decorators = [Remote("writePage")];
			_createPage_decorators = [Remote("createPage")];
			_ingestSource_decorators = [Remote("ingestSource")];
			_ingestUrl_decorators = [Remote("ingestUrl")];
			_ingestQueueAdd_decorators = [Remote("ingestQueueAdd")];
			_ingestQueueStatus_decorators = [Remote("ingestQueueStatus")];
			_ingestQueueCancel_decorators = [Remote("ingestQueueCancel")];
			_deepResearch_decorators = [Remote("deepResearch")];
			_reviews_decorators = [Remote("reviews")];
			_verifyCandidate_decorators = [Remote("verifyCandidate")];
			_resolveReview_decorators = [Remote("resolveReview")];
			_resolveReviews_decorators = [Remote("resolveReviews")];
			_listProjects_decorators = [Remote("listProjects")];
			_setProject_decorators = [Remote("setProject")];
			_createProject_decorators = [Remote("createProject")];
			_removeProject_decorators = [Remote("removeProject")];
			_graphInsights_decorators = [Remote("graphInsights")];
			_lint_decorators = [Remote("lint")];
			_exportProject_decorators = [Remote("exportProject")];
			_importProject_decorators = [Remote("importProject")];
			__esDecorate(this, null, _graph_decorators, {
				kind: "method",
				name: "graph",
				static: false,
				private: false,
				access: {
					has: (obj) => "graph" in obj,
					get: (obj) => obj.graph
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _fullGraph_decorators, {
				kind: "method",
				name: "fullGraph",
				static: false,
				private: false,
				access: {
					has: (obj) => "fullGraph" in obj,
					get: (obj) => obj.fullGraph
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _list_decorators, {
				kind: "method",
				name: "list",
				static: false,
				private: false,
				access: {
					has: (obj) => "list" in obj,
					get: (obj) => obj.list
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _search_decorators, {
				kind: "method",
				name: "search",
				static: false,
				private: false,
				access: {
					has: (obj) => "search" in obj,
					get: (obj) => obj.search
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _knowledgeUtility_decorators, {
				kind: "method",
				name: "knowledgeUtility",
				static: false,
				private: false,
				access: {
					has: (obj) => "knowledgeUtility" in obj,
					get: (obj) => obj.knowledgeUtility
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _recordKnowledgeOutcome_decorators, {
				kind: "method",
				name: "recordKnowledgeOutcome",
				static: false,
				private: false,
				access: {
					has: (obj) => "recordKnowledgeOutcome" in obj,
					get: (obj) => obj.recordKnowledgeOutcome
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _pageContent_decorators, {
				kind: "method",
				name: "pageContent",
				static: false,
				private: false,
				access: {
					has: (obj) => "pageContent" in obj,
					get: (obj) => obj.pageContent
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _writePage_decorators, {
				kind: "method",
				name: "writePage",
				static: false,
				private: false,
				access: {
					has: (obj) => "writePage" in obj,
					get: (obj) => obj.writePage
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _createPage_decorators, {
				kind: "method",
				name: "createPage",
				static: false,
				private: false,
				access: {
					has: (obj) => "createPage" in obj,
					get: (obj) => obj.createPage
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _ingestSource_decorators, {
				kind: "method",
				name: "ingestSource",
				static: false,
				private: false,
				access: {
					has: (obj) => "ingestSource" in obj,
					get: (obj) => obj.ingestSource
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _ingestUrl_decorators, {
				kind: "method",
				name: "ingestUrl",
				static: false,
				private: false,
				access: {
					has: (obj) => "ingestUrl" in obj,
					get: (obj) => obj.ingestUrl
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _ingestQueueAdd_decorators, {
				kind: "method",
				name: "ingestQueueAdd",
				static: false,
				private: false,
				access: {
					has: (obj) => "ingestQueueAdd" in obj,
					get: (obj) => obj.ingestQueueAdd
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _ingestQueueStatus_decorators, {
				kind: "method",
				name: "ingestQueueStatus",
				static: false,
				private: false,
				access: {
					has: (obj) => "ingestQueueStatus" in obj,
					get: (obj) => obj.ingestQueueStatus
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _ingestQueueCancel_decorators, {
				kind: "method",
				name: "ingestQueueCancel",
				static: false,
				private: false,
				access: {
					has: (obj) => "ingestQueueCancel" in obj,
					get: (obj) => obj.ingestQueueCancel
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _deepResearch_decorators, {
				kind: "method",
				name: "deepResearch",
				static: false,
				private: false,
				access: {
					has: (obj) => "deepResearch" in obj,
					get: (obj) => obj.deepResearch
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _reviews_decorators, {
				kind: "method",
				name: "reviews",
				static: false,
				private: false,
				access: {
					has: (obj) => "reviews" in obj,
					get: (obj) => obj.reviews
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _verifyCandidate_decorators, {
				kind: "method",
				name: "verifyCandidate",
				static: false,
				private: false,
				access: {
					has: (obj) => "verifyCandidate" in obj,
					get: (obj) => obj.verifyCandidate
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _resolveReview_decorators, {
				kind: "method",
				name: "resolveReview",
				static: false,
				private: false,
				access: {
					has: (obj) => "resolveReview" in obj,
					get: (obj) => obj.resolveReview
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _resolveReviews_decorators, {
				kind: "method",
				name: "resolveReviews",
				static: false,
				private: false,
				access: {
					has: (obj) => "resolveReviews" in obj,
					get: (obj) => obj.resolveReviews
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _listProjects_decorators, {
				kind: "method",
				name: "listProjects",
				static: false,
				private: false,
				access: {
					has: (obj) => "listProjects" in obj,
					get: (obj) => obj.listProjects
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _setProject_decorators, {
				kind: "method",
				name: "setProject",
				static: false,
				private: false,
				access: {
					has: (obj) => "setProject" in obj,
					get: (obj) => obj.setProject
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _createProject_decorators, {
				kind: "method",
				name: "createProject",
				static: false,
				private: false,
				access: {
					has: (obj) => "createProject" in obj,
					get: (obj) => obj.createProject
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _removeProject_decorators, {
				kind: "method",
				name: "removeProject",
				static: false,
				private: false,
				access: {
					has: (obj) => "removeProject" in obj,
					get: (obj) => obj.removeProject
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _graphInsights_decorators, {
				kind: "method",
				name: "graphInsights",
				static: false,
				private: false,
				access: {
					has: (obj) => "graphInsights" in obj,
					get: (obj) => obj.graphInsights
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _lint_decorators, {
				kind: "method",
				name: "lint",
				static: false,
				private: false,
				access: {
					has: (obj) => "lint" in obj,
					get: (obj) => obj.lint
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _exportProject_decorators, {
				kind: "method",
				name: "exportProject",
				static: false,
				private: false,
				access: {
					has: (obj) => "exportProject" in obj,
					get: (obj) => obj.exportProject
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _importProject_decorators, {
				kind: "method",
				name: "importProject",
				static: false,
				private: false,
				access: {
					has: (obj) => "importProject" in obj,
					get: (obj) => obj.importProject
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		/** Required services. */
		static inject = [
			"llm",
			"timer",
			"credentials"
		];
		/** Loader validation for the deployment configuration. */
		static Config = s.object({
			wikiRoot: s.string().required(),
			mainRoot: s.string().default(""),
			credential: s.string().default("VISION_API_KEY"),
			llmProvider: s.string().default("deepseek-official"),
			llmModel: s.string().default("deepseek-reasoner")
		});
		wikiRoot = __runInitializers(this, _instanceExtraInitializers);
		mainRoot;
		currentRoot;
		credential;
		llmProvider;
		llmModel;
		queue = [];
		restoredQueueRoots = /* @__PURE__ */ new Set();
		snapshots = new WikiSnapshotStore();
		queueDrain;
		activeIngest;
		backgroundStages = /* @__PURE__ */ new Set();
		queueNextId = 1;
		projectGeneration = 0;
		/**
		* @param ctx - Host context.
		* @param config - Resolved deployment configuration.
		*/
		constructor(ctx, config) {
			super(ctx, "knowledgeWiki");
			this.wikiRoot = config.wikiRoot.replace(/\/+$/u, "");
			const parent = dirname(this.wikiRoot);
			this.mainRoot = config.mainRoot.replace(/\/+$/u, "") || parent;
			this.currentRoot = this.mainRoot;
			this.credential = credentialRef(config.credential);
			this.llmProvider = config.llmProvider;
			this.llmModel = config.llmModel;
		}
		/** Resolve on every operation so Keychain updates apply without a restart. */
		async resolveApiKey() {
			return (await this.ctx.credentials.resolve(this.credential))?.value ?? "";
		}
		/** Optional trusted verifier/build owner; project files can never supply it. */
		get verifierAuthority() {
			const value = this.ctx.get("knowledgeWikiVerifierAuthority");
			if (typeof value !== "object" || value === null || typeof Reflect.get(value, "authorityId") !== "string" || typeof Reflect.get(value, "sourceIdentity") !== "function" || typeof Reflect.get(value, "verifyCandidate") !== "function" || typeof Reflect.get(value, "validateCandidateResult") !== "function" || typeof Reflect.get(value, "sealPromotion") !== "function" || typeof Reflect.get(value, "validatePromotion") !== "function") return void 0;
			return value;
		}
		/** Parent-owned hard-deadline stage executor; absence disables non-cooperative ingest. */
		get stageExecutor() {
			const value = this.ctx.get("knowledgeWikiStageExecutor");
			return isKnowledgeWikiStageExecutor(value) ? value : void 0;
		}
		/** Knowledge-base directory of the active workspace: the main wikiRoot, or `<root>/wiki` for a registered workspace. */
		get activeWikiRoot() {
			return this.currentRoot === this.mainRoot ? this.wikiRoot : join(this.currentRoot, "wiki");
		}
		captureProjectContext() {
			return createProjectExecutionContext(this.currentRoot, this.mainRoot, this.wikiRoot, this.projectGeneration);
		}
		/**
		* Start the source-folder auto-watch: restore the persisted queue, scan
		* raw/sources every 60s, and enqueue newly changed files for two-stage
		* ingest. A completed session may create one governed candidate after the
		* session-level admission gate accepts it; individual turns never create pages.
		*/
		[Service.init]() {
			return promiseFromSync(() => {
				this.restoreQueue(this.currentRoot);
				recoverCandidateReviewTransactions(this.verifierAuthority, this.reviewFile(this.currentRoot), this.activeWikiRoot, join(this.mainRoot, "jiuzhang-tarballs", "archive"));
				this.ctx.effect(() => () => {
					this.snapshots.dispose();
				}, "knowledge-wiki: snapshot store");
				this.ctx.effect(() => () => {
					this.activeIngest?.controller.abort(/* @__PURE__ */ new Error("knowledge-wiki disposed"));
				}, "knowledge-wiki: ingest owner");
				this.ctx.effect(() => () => {
					for (const controller of this.backgroundStages) controller.abort(/* @__PURE__ */ new Error("knowledge-wiki disposed"));
				}, "knowledge-wiki: background stages");
				const dispose = this.ctx.timer.interval(() => {
					this.scanSources();
					this.drainQueue();
				}, 6e4);
				this.ctx.effect(() => dispose, "knowledge-wiki: source auto-watch");
				const onAgentDisposed = (payload) => {
					this.summarizeSession(payload.agent.id);
				};
				this.ctx.on("agent/disposed", onAgentDisposed);
			});
		}
		/**
		* 会话级 AI 提炼：agent 销毁时把整段对话交给 LLM 浓缩为一页知识，
		* 写入会话所属工作区的 `_candidates/sessions/`（每会话一页）。
		* 候选页不进入主图谱，等待治理提案与人工审批后再晋升。
		*
		* 与实时沉淀同一套工作区策略（非主工作区才写）；幂等靠 slug 含会话
		* id + 页面存在检查。LLM 失败静默（不阻塞 agent 销毁）。
		*/
		async summarizeSession(sessionId) {
			const controller = new AbortController();
			this.backgroundStages.add(controller);
			try {
				if (!sessionId) return;
				const sessionQuery = this.ctx.get("sessionQuery");
				if (!isSessionQueryReader(sessionQuery)) return;
				const surface = await sessionQuery.readSession(sessionId);
				const target = sedimentTarget(surface.session.cwd, this.mainRoot);
				if (!target) return;
				const events = surface.events;
				if (!Array.isArray(events) || events.length === 0) return;
				const conversation = extractConversationText(events);
				if (conversation.trim().length < 200) return;
				const parsed = parseSummaryJson((await executeKnowledgeWikiStage(this.stageExecutor, {
					kind: "llm-complete",
					provider: this.llmProvider,
					model: this.llmModel,
					prompt: buildSummaryPrompt(conversation),
					operation: "session summary",
					timeoutMs: 12e4
				}, controller.signal)).text ?? "");
				if (!parsed || parsed.action === "skip" || !parsed.title) return;
				const isIncident = parsed.action === "incident_open" || parsed.action === "incident_verified";
				const isReflection = parsed.action === "reflection";
				const slug = issueSlugFrom(parsed.issueKey);
				const rel = join("_candidates", isIncident ? "incidents" : isReflection ? "reflections" : "topics", `${slug}.md`);
				const alreadyExists = pageExists(target.wikiRoot, rel);
				const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
				const content = buildSessionSummaryPage({
					title: parsed.title,
					summary: parsed.summary,
					related: parsed.related,
					sessionId,
					today,
					workspaceName: target.workspaceName,
					candidateKind: isIncident ? "incident" : isReflection ? "reflection" : "knowledge",
					epistemicStatus: parsed.action === "incident_verified" ? "verified" : "hypothesis",
					evidenceCount: 1,
					independentSourceCount: 1,
					...isIncident ? {
						resolutionStatus: parsed.action === "incident_verified" ? "verified" : "open",
						issueId: slug
					} : {}
				});
				try {
					const full = join(target.wikiRoot, rel);
					mkdirSync(dirname(full), { recursive: true });
					const next = alreadyExists ? isIncident ? mergeIncidentCandidate(readRegularFileBounded(full, 5 * 1024 * 1024).toString("utf8"), content, sessionId, today, parsed.action === "incident_verified" ? "verified" : "open") : mergeSessionCandidate(readRegularFileBounded(full, 5 * 1024 * 1024).toString("utf8"), content, sessionId, today, isReflection ? "反思证据增量" : "知识证据增量") : content;
					if (next !== readFileIfExists(full)) atomicWriteFile(full, next);
					const projectRoot = dirname(target.wikiRoot);
					appendCandidateReviews(join(projectRoot, ".llm-wiki", "review.json"), projectRoot, `session:${sessionId}`, [`wiki/${rel}`]);
					this.ctx.logger.info(`[knowledge-wiki] session-summary: ${rel}`);
				} catch (error) {
					this.ctx.logger.warn("[knowledge-wiki] session summary write failed");
					this.ctx.logger.warn(error);
				}
			} catch (error) {
				this.ctx.logger.warn("[knowledge-wiki] session summary failed");
				this.ctx.logger.warn(error);
			} finally {
				this.backgroundStages.delete(controller);
			}
		}
		/** Retry cooldown for failed ingests (prevents 60s crash-looping on a broken key). */
		static FAILED_RETRY_MS = 3600 * 1e3;
		queueFile(projectRoot = this.currentRoot) {
			return join(projectRoot, ".llm-wiki", "ingest-queue.json");
		}
		/** Restore resumable tasks and cancelled-source tombstones. */
		restoreQueue(projectRoot = this.currentRoot) {
			if (this.restoredQueueRoots.has(projectRoot)) return;
			try {
				const parsed = JSON.parse(readRegularFileBounded(this.queueFile(projectRoot), 5 * 1024 * 1024).toString("utf8"));
				if (!Array.isArray(parsed)) throw new Error("invalid knowledge ingest queue state");
				const context = createProjectExecutionContext(projectRoot, this.mainRoot, this.wikiRoot, this.projectGeneration);
				for (const value of parsed) {
					if (typeof value !== "object" || value === null) continue;
					const task = value;
					if (typeof task.input !== "string" || ![
						"pending",
						"running",
						"done",
						"error",
						"cancelled"
					].includes(task.status ?? "")) continue;
					const id = typeof task.id === "number" ? task.id : this.queueNextId;
					if (this.queue.some((item) => item.projectRoot === projectRoot && item.input === task.input && (item.status === "pending" || item.status === "running" || item.status === "cancelled"))) continue;
					this.queue.push({
						id,
						input: task.input,
						projectRoot,
						wikiRoot: context.wikiRoot,
						projectGeneration: typeof task.projectGeneration === "number" ? task.projectGeneration : context.generation,
						createdAt: typeof task.createdAt === "number" ? task.createdAt : Date.now(),
						status: task.status === "running" ? "pending" : task.status,
						...typeof task.ingestedHash === "string" ? { ingestedHash: task.ingestedHash } : {},
						...Array.isArray(task.written) ? { written: task.written.filter((value) => typeof value === "string") } : {},
						...Array.isArray(task.warnings) ? { warnings: task.warnings.filter((value) => typeof value === "string") } : {},
						...typeof task.error === "string" ? { error: task.error } : {},
						...typeof task.failedAt === "number" ? { failedAt: task.failedAt } : {},
						...typeof task.completedAt === "number" ? { completedAt: task.completedAt } : {},
						...typeof task.cancelRequestedAt === "number" ? { cancelRequestedAt: task.cancelRequestedAt } : {},
						...typeof task.runId === "string" ? { runId: task.runId } : {},
						...typeof task.leaseStartedAt === "number" ? { leaseStartedAt: task.leaseStartedAt } : {}
					});
					this.queueNextId = Math.max(this.queueNextId, id + 1);
				}
				this.restoredQueueRoots.add(projectRoot);
			} catch (error) {
				if (!isMissingPathError$2(error)) throw error;
				this.restoredQueueRoots.add(projectRoot);
			}
		}
		/** Persist resumable tasks and cancelled-source tombstones. */
		persistQueue(projectRoot) {
			const roots = projectRoot === void 0 ? new Set(this.queue.map((task) => task.projectRoot)) : new Set([projectRoot]);
			for (const root of roots) {
				const durable = this.queue.filter((task) => task.projectRoot === root);
				atomicWriteFile(this.queueFile(root), `${JSON.stringify(durable, null, 2)}\n`);
			}
		}
		/**
		* Enqueue one input (project-relative path or URL) with dedup and
		* failure cooldown: an error task retries only after the cooldown, and
		* pending/running tasks are never duplicated. Done and cancelled tasks re-enqueue
		* only on an explicit manual request (force) — the scanner never
		* re-runs a completed ingest, so a content change mid-ingest cannot
		* stack duplicate tasks for the same input.
		* @param input - cache-relative path or URL.
		* @param force - allow re-enqueue of a done task (manual ingestQueueAdd).
		* @returns whether the task was enqueued.
		*/
		enqueueIngest(input, force = false, context = this.captureProjectContext()) {
			const normalized = input.replace(/^\/+/u, "").replace(/^raw\/sources\//u, "");
			const existing = this.queue.findLast((task) => task.projectRoot === context.projectRoot && task.input === normalized);
			if (existing !== void 0) {
				if (existing.status === "pending" || existing.status === "running") return false;
				if (existing.status === "done" && !force) {
					if (existing.ingestedHash !== void 0 && existing.ingestedHash === this.currentHash(normalized, context.projectRoot)) return false;
				}
				if (existing.status === "cancelled" && !force && existing.ingestedHash !== void 0 && existing.ingestedHash === this.currentHash(normalized, context.projectRoot)) return false;
				if (existing.status === "error") {
					const failedAt = existing.failedAt;
					if (failedAt !== void 0 && Date.now() - failedAt < KnowledgeWikiService.FAILED_RETRY_MS) return false;
				}
			}
			this.queue.push({
				id: this.queueNextId++,
				input: normalized,
				projectRoot: context.projectRoot,
				wikiRoot: context.wikiRoot,
				projectGeneration: context.generation,
				createdAt: Date.now(),
				status: "pending"
			});
			this.persistQueue(context.projectRoot);
			return true;
		}
		/** Current content hash of a cache-relative source path, or undefined
		* for URLs and unreadable files. */
		currentHash(input, projectRoot = this.currentRoot) {
			if (/^https?:\/\//i.test(input)) return void 0;
			const source = resolveRawSourcePath(projectRoot, input);
			return this.sha256(readRegularFileBounded(source, MAX_RAW_SOURCE_BYTES));
		}
		cacheFile(projectRoot = this.currentRoot) {
			return join(projectRoot, ".llm-wiki", "ingest-cache.json");
		}
		readCache(projectRoot = this.currentRoot) {
			return readOptionalJson(this.cacheFile(projectRoot), {});
		}
		writeCache(cache, projectRoot = this.currentRoot) {
			atomicWriteFile(this.cacheFile(projectRoot), `${JSON.stringify(cache, null, 2)}\n`);
		}
		sha256(value) {
			return createHash("sha256").update(value).digest("hex");
		}
		listRawSources(projectRoot = this.currentRoot) {
			const root = join(projectRoot, "raw", "sources");
			const out = [];
			let rootStat;
			try {
				rootStat = lstatSync(root);
			} catch (error) {
				if (isMissingPathError$2(error)) return out;
				throw error;
			}
			if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("raw source root is not an ordinary directory");
			const visited = /* @__PURE__ */ new Set();
			const visitedFiles = /* @__PURE__ */ new Set();
			const walk = (dir) => {
				const directory = lstatSync(dir);
				if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error(`unsafe raw source directory: ${dir}`);
				const identity = `${directory.dev}:${directory.ino}`;
				if (visited.has(identity)) throw new Error(`revisited raw source directory inode: ${dir}`);
				visited.add(identity);
				const entries = readdirSync(dir);
				for (const name of entries) {
					if (name.startsWith(".") || name === "node_modules") continue;
					const full = join(dir, name);
					const st = lstatSync(full);
					const rel = relative(root, full).split(sep).join("/");
					if (st.isSymbolicLink()) throw new Error(`symbolic links are not allowed in raw sources: ${rel}`);
					if (st.isDirectory()) walk(full);
					else if (!st.isFile()) throw new Error(`non-regular raw source is not allowed: ${rel}`);
					else {
						if (st.nlink !== 1) throw new Error(`hard-linked raw source is not allowed: ${rel}`);
						const fileIdentity = `${st.dev}:${st.ino}`;
						if (visitedFiles.has(fileIdentity)) throw new Error(`revisited raw source file inode: ${rel}`);
						visitedFiles.add(fileIdentity);
						if (st.size > MAX_RAW_SOURCE_BYTES) throw new Error(`raw source exceeds 100 MiB: ${rel}`);
						out.push(rel);
					}
				}
			};
			walk(root);
			return out;
		}
		scanSources() {
			return promiseFromSync(() => {
				const context = this.captureProjectContext();
				const cache = this.readCache(context.projectRoot);
				for (const rel of this.listRawSources(context.projectRoot)) {
					const source = resolveRawSourcePath(context.projectRoot, rel);
					const hash = this.sha256(readRegularFileBounded(source, MAX_RAW_SOURCE_BYTES));
					if (cache[rel] === hash) continue;
					this.enqueueIngest(rel, false, context);
				}
			});
		}
		reviewFile(projectRoot = this.currentRoot) {
			return join(projectRoot, ".llm-wiki", "review.json");
		}
		utilityFile(projectRoot = this.currentRoot) {
			return join(projectRoot, ".llm-wiki", "knowledge-utility.json");
		}
		readUtility(projectRoot = this.currentRoot) {
			return readOptionalJson(this.utilityFile(projectRoot), {});
		}
		writeUtility(records, projectRoot = this.currentRoot) {
			atomicWriteFile(this.utilityFile(projectRoot), `${JSON.stringify(records, null, 2)}\n`);
		}
		recordKnowledgeRetrieval(paths, projectRoot = this.currentRoot) {
			if (paths.length === 0) return;
			const records = this.readUtility(projectRoot);
			const now = (/* @__PURE__ */ new Date()).toISOString();
			for (const path of [...new Set(paths)]) {
				const current = records[path] ?? {
					path,
					retrievalHits: 0,
					successfulUses: 0,
					userCorrections: 0,
					utilityScore: 0
				};
				records[path] = {
					...current,
					retrievalHits: current.retrievalHits + 1,
					lastRetrievedAt: now
				};
			}
			this.writeUtility(records, projectRoot);
		}
		/**
		* The concept graph (nodes + wikilink edges, Louvain clusters).
		* @returns the graph computed from the wiki page tree.
		*/
		computeGraph() {
			const wikiRoot = this.activeWikiRoot;
			return this.snapshots.get(wikiRoot, "graph", () => promiseFromSync(() => buildGraph(wikiRoot)));
		}
		/**
		* Provides the graph operation.
		* @returns The computed graph value.
		*/
		graph() {
			return this.computeGraph();
		}
		/**
		* Provides the full graph operation.
		* @returns The computed graph value.
		*/
		fullGraph() {
			return this.computeGraph();
		}
		/**
		* Lists the list operation.
		* @returns The wiki file entries.
		*/
		list() {
			const wikiRoot = this.activeWikiRoot;
			return this.snapshots.get(wikiRoot, "list", () => promiseFromSync(() => listPages(wikiRoot)));
		}
		/**
		* Hybrid search over the wiki (BM25 + optional vector).
		* @param request - query text and optional hit count.
		* @returns ranked hits.
		*/
		async search(request) {
			const context = this.captureProjectContext();
			const topK = request.topK ?? 8;
			const hits = await this.snapshots.get(context.wikiRoot, `search:${topK}:${request.query}`, async () => hybridSearch(context.wikiRoot, request.query, await this.resolveApiKey(), topK));
			this.recordKnowledgeRetrieval(hits.map((hit) => hit.path), context.projectRoot);
			return hits.map((hit) => ({
				path: hit.path,
				score: hit.score
			}));
		}
		/**
		* Provides the knowledge utility operation.
		* @returns The knowledge utility records.
		*/
		knowledgeUtility() {
			return promiseFromSync(() => Object.values(this.readUtility()).sort((left, right) => right.utilityScore - left.utilityScore));
		}
		/**
		* Record whether retrieved knowledge helped or required a user correction.
		* @param request - The request input.
		* @returns The value produced by record knowledge outcome.
		*/
		recordKnowledgeOutcome(request) {
			return promiseFromSync(() => {
				const records = this.readUtility();
				const now = (/* @__PURE__ */ new Date()).toISOString();
				let updated = 0;
				for (const candidate of [...new Set(request.paths)]) {
					let safe;
					try {
						safe = resolveSafePath(this.activeWikiRoot, candidate, false).relativePath;
					} catch {
						continue;
					}
					const current = records[safe] ?? {
						path: safe,
						retrievalHits: 0,
						successfulUses: 0,
						userCorrections: 0,
						utilityScore: 0
					};
					const successfulUses = current.successfulUses + (request.outcome === "successful" ? 1 : 0);
					const userCorrections = current.userCorrections + (request.outcome === "corrected" ? 1 : 0);
					const denominator = Math.max(1, current.retrievalHits);
					records[safe] = {
						...current,
						successfulUses,
						userCorrections,
						utilityScore: Number(((successfulUses * 2 - userCorrections * 3) / denominator).toFixed(4)),
						lastOutcomeAt: now
					};
					updated += 1;
				}
				if (updated > 0) this.writeUtility(records);
				return updated;
			});
		}
		/**
		* Provides the page content operation.
		* @param request - The request input.
		* @returns The requested page content.
		*/
		pageContent(request) {
			return promiseFromSync(() => {
				try {
					const { relativePath: safe, absolutePath: resolved } = resolveSafePath(this.activeWikiRoot, request.path, false);
					if (lstatSync(resolved).isDirectory()) return {
						path: request.path,
						content: ""
					};
					return {
						path: request.path,
						content: readPage(this.activeWikiRoot, safe)
					};
				} catch (error) {
					if (!isMissingPathError$2(error) && !(error instanceof Error && error.message === "path does not exist")) throw error;
					return {
						path: request.path,
						content: ""
					};
				}
			});
		}
		/**
		* Write one wiki page.
		* @param request - page path and Markdown content.
		* @returns the written path.
		*/
		writePage(request) {
			return promiseFromSync(() => {
				try {
					const { relativePath: safe, absolutePath: full } = resolveSafePath(this.activeWikiRoot, request.path, true);
					if (!existsSync(full) && !safe.startsWith("_candidates/")) return {
						path: safe,
						ok: false,
						error: "new generated pages must be written under _candidates/"
					};
					if (request.expectedContent !== void 0 && existsSync(full)) {
						if (readRegularFileBounded(full, 5 * 1024 * 1024).toString("utf8") !== request.expectedContent) return {
							path: safe,
							ok: false,
							conflict: true,
							error: "page changed on disk; reload before saving"
						};
					}
					atomicWriteFile(full, request.content);
					this.snapshots.invalidate(this.activeWikiRoot);
					return {
						path: safe,
						ok: true
					};
				} catch (error) {
					return {
						path: request.path,
						ok: false,
						error: error instanceof Error ? error.message : String(error)
					};
				}
			});
		}
		/**
		* Create a new wiki page under wiki/concepts.
		* @param request - page title and optional content.
		* @returns the created path.
		*/
		createPage(request) {
			return promiseFromSync(() => {
				try {
					const rel = `concepts/${request.title.trim().replace(/[\\/:*?"<>|\s]+/gu, "-").replace(/-+/gu, "-").replace(/^-|-$/gu, "")}.md`;
					const full = join(this.activeWikiRoot, rel);
					if (existsSync(full)) return {
						path: rel,
						ok: false,
						error: "page already exists"
					};
					const frontmatter = `---\ntype: concept\nstatus: canonical\norigin: human\ntitle: ${request.title.trim()}\napproved_at: ${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}\napproved_by: human\ncreated: ${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}\nupdated: ${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}\n---\n\n${request.content ?? ""}\n`;
					mkdirSync(join(this.activeWikiRoot, "concepts"), { recursive: true });
					atomicWriteFile(full, frontmatter);
					this.snapshots.invalidate(this.activeWikiRoot);
					return {
						path: rel,
						ok: true
					};
				} catch (error) {
					return {
						path: "",
						ok: false,
						error: error instanceof Error ? error.message : String(error)
					};
				}
			});
		}
		/**
		* Two-stage ingest of one source file (project-relative raw/sources path).
		* @param request - the source path.
		* @returns written wiki paths and warnings.
		*/
		async ingestSource(request) {
			try {
				const context = this.captureProjectContext();
				resolveRawSourcePath(context.projectRoot, request.path);
				return await this.enqueueAndWait(request.path, context);
			} catch (error) {
				return ingestFailure(error, "invalid-input");
			}
		}
		async ingestSourceWithContext(request, context, signal) {
			resolveRawSourcePath(context.projectRoot, request.path);
			signal.throwIfAborted();
			if (isImagePath(request.path)) {
				const outcome = await this.ingestImage(request.path, context, signal);
				signal.throwIfAborted();
				this.snapshots.invalidate(context.wikiRoot);
				return outcome;
			}
			const outcome = await ingestSource(this.stageExecutor, this.llmProvider, this.llmModel, context.projectRoot, request.path, signal);
			signal.throwIfAborted();
			if (outcome.written.length > 0) this.snapshots.invalidate(context.wikiRoot);
			return {
				written: outcome.written,
				warnings: outcome.warnings
			};
		}
		/** Multimodal image ingest: copy into wiki/media and caption with the vision LLM. */
		async ingestImage(relPath, context, signal) {
			signal.throwIfAborted();
			const source = resolveRawSourcePath(context.projectRoot, relPath);
			const apiKey = await this.resolveApiKey();
			if (apiKey && this.stageExecutor === void 0) throw new Error("knowledge Wiki stage executor unavailable; refusing vision work");
			signal.throwIfAborted();
			const fileName = basename(relPath);
			const slug = fileName.replace(/[\/:*?"<>|\s]+/gu, "-").replace(/-+/gu, "-").replace(/\.[^.]+$/u, "");
			const mediaRel = `_candidates/ingest/media/${slug}${extname(fileName).toLowerCase()}`;
			atomicWriteFile(join(context.wikiRoot, mediaRel), readRegularFileBounded(source, 16 * 1024 * 1024));
			signal.throwIfAborted();
			const caption = apiKey ? (await executeKnowledgeWikiStage(this.stageExecutor, {
				kind: "vision-describe",
				apiKey,
				path: source,
				timeoutMs: 6e4
			}, signal)).text ?? "" : "";
			signal.throwIfAborted();
			if (!caption) return {
				written: [mediaRel],
				warnings: ["视觉说明生成失败（检查 apiKey/网络）"]
			};
			const pageRel = `_candidates/ingest/sources/${slug}.md`;
			const page = `---\ntype: source\nstatus: candidate\norigin: image\ntitle: ${fileName}\nsources: ["${relPath}"]\ncreated: ${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}\nupdated: ${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}\n---\n\n# ${fileName}\n\n![${fileName}](/${mediaRel})\n\n## 图片说明\n\n${caption}\n`;
			mkdirSync(dirname(join(context.wikiRoot, pageRel)), { recursive: true });
			atomicWriteFile(join(context.wikiRoot, pageRel), page);
			appendCandidateReviews(this.reviewFile(context.projectRoot), context.projectRoot, relPath, [`wiki/${pageRel}`]);
			return {
				written: [pageRel, mediaRel],
				warnings: []
			};
		}
		/**
		* Fetch one URL, clip it to Markdown, and ingest it.
		* @param request - the URL.
		* @returns written wiki paths and warnings.
		*/
		async ingestUrl(request) {
			try {
				const url = new URL(request.url);
				if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http and https URLs are allowed");
				return await this.enqueueAndWait(request.url, this.captureProjectContext());
			} catch (error) {
				return ingestFailure(error, "invalid-input");
			}
		}
		async ingestUrlWithContext(request, context, signal) {
			const fetched = await fetchPublicText(request.url, signal);
			signal.throwIfAborted();
			const md = htmlToMarkdown(fetched.text, fetched.url);
			const rel = `raw/sources/clips/${new URL(fetched.url).hostname.replace(/\./gu, "-")}-${Date.now()}.md`;
			atomicWriteFile(join(context.projectRoot, rel), `# ${request.url}\n\n> 来源：${request.url}\n\n${md}\n`);
			signal.throwIfAborted();
			return this.ingestSourceWithContext({ path: rel }, context, signal);
		}
		/**
		* Enqueue sources for two-stage ingest (serialized, deduped; a completed
		* task can be re-run manually, an errored one only after its cooldown).
		* @param request - inputs (project-relative paths or URLs).
		* @returns the queue snapshot.
		*/
		ingestQueueAdd(request) {
			return promiseFromSync(() => {
				const context = this.captureProjectContext();
				for (const input of request.inputs) this.enqueueIngest(input, true, context);
				this.drainQueue();
				return this.queueSnapshot();
			});
		}
		/**
		* Provides the ingest queue status operation.
		* @returns The current ingest queue snapshot.
		*/
		ingestQueueStatus() {
			return promiseFromSync(() => this.queueSnapshot());
		}
		/**
		* Provides the ingest queue cancel operation.
		* @returns The current ingest queue snapshot after cancellation.
		*/
		ingestQueueCancel() {
			return promiseFromSync(() => {
				this.cancelPendingForRoot(this.currentRoot);
				return this.queueSnapshot();
			});
		}
		cancelPendingForRoot(projectRoot) {
			let changed = false;
			for (let index = 0; index < this.queue.length; index += 1) {
				const task = this.queue[index];
				if (task === void 0 || task.projectRoot !== projectRoot) continue;
				if (task.status === "running" && this.activeIngest?.taskId === task.id) {
					const cancelRequestedAt = Date.now();
					this.queue[index] = {
						...task,
						cancelRequestedAt
					};
					this.activeIngest.controller.abort(/* @__PURE__ */ new Error("knowledge-wiki ingest cancelled"));
					changed = true;
					continue;
				}
				if (task.status !== "pending") continue;
				const ingestedHash = this.currentHash(task.input, task.projectRoot);
				this.queue[index] = {
					...task,
					status: "cancelled",
					cancelRequestedAt: Date.now(),
					completedAt: Date.now(),
					...ingestedHash === void 0 ? {} : { ingestedHash }
				};
				changed = true;
			}
			if (changed) this.persistQueue(projectRoot);
			return changed;
		}
		queueSnapshot() {
			const tasks = this.queue.filter((task) => task.projectRoot === this.currentRoot);
			return {
				tasks: [...tasks],
				running: tasks.some((task) => task.status === "running"),
				cancelled: tasks.some((task) => task.status === "cancelled")
			};
		}
		queueTaskContext(task) {
			return Object.freeze({
				projectRoot: task.projectRoot,
				wikiRoot: task.wikiRoot,
				generation: task.projectGeneration,
				startedAt: task.createdAt
			});
		}
		executeQueuedIngest(task, context, signal) {
			return /^https?:\/\//i.test(task.input) ? this.ingestUrlWithContext({ url: task.input }, context, signal) : this.ingestSourceWithContext({ path: `raw/sources/${task.input}` }, context, signal);
		}
		drainQueue() {
			if (this.queueDrain !== void 0) return this.queueDrain;
			const drain = this.runQueue().finally(() => {
				this.queueDrain = void 0;
			});
			this.queueDrain = drain;
			return drain;
		}
		async runQueue() {
			for (const [index, task] of this.queue.entries()) {
				if (task.status !== "pending") continue;
				const controller = new AbortController();
				const running = {
					...task,
					status: "running",
					runId: randomUUID(),
					leaseStartedAt: Date.now()
				};
				this.queue[index] = running;
				this.activeIngest = {
					taskId: task.id,
					controller
				};
				this.persistQueue(running.projectRoot);
				const timeoutState = { expired: false };
				const timeout = setTimeout(() => {
					timeoutState.expired = true;
					controller.abort(/* @__PURE__ */ new Error("ingest timed out after 5 minutes"));
				}, 300 * 1e3);
				const context = this.queueTaskContext(running);
				try {
					const outcome = await this.executeQueuedIngest(running, context, controller.signal);
					controller.signal.throwIfAborted();
					if (outcome.written.length === 0 && outcome.warnings.length > 0) throw new Error(outcome.warnings.join("; "));
					const ingestedHash = this.markIngested(running.input, context);
					this.queue[index] = running;
					this.queue[index] = {
						...running,
						status: "done",
						written: outcome.written,
						warnings: outcome.warnings,
						completedAt: Date.now(),
						...ingestedHash !== void 0 ? { ingestedHash } : {}
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					const current = this.queue[index];
					const cancelled = !timeoutState.expired && current.cancelRequestedAt !== void 0;
					console.error("[knowledge-wiki] ingest failed:", running.input, message);
					this.queue[index] = {
						...running,
						status: cancelled ? "cancelled" : "error",
						error: message,
						completedAt: Date.now(),
						...cancelled ? { cancelRequestedAt: current.cancelRequestedAt ?? Date.now() } : { failedAt: Date.now() }
					};
				} finally {
					clearTimeout(timeout);
					this.activeIngest = void 0;
					this.persistQueue(context.projectRoot);
				}
			}
		}
		async enqueueAndWait(input, context) {
			this.enqueueIngest(input, true, context);
			const task = this.queue.findLast((item) => item.projectRoot === context.projectRoot && item.input === input.replace(/^\/+|^raw\/sources\//gu, ""));
			if (task === void 0) throw new Error("ingest task was not admitted");
			await this.drainQueue();
			const terminal = this.queue.find((item) => item.id === task.id);
			if (terminal?.status === "done") {
				const warnings = terminal.warnings ?? [];
				return {
					written: terminal.written ?? [],
					warnings,
					status: warnings.length > 0 ? "degraded" : "ok"
				};
			}
			const error = terminal?.error ?? `ingest task ${task.id} did not complete`;
			const errorCode = terminal?.status === "cancelled" ? "cancelled" : error.includes("timed out") ? "timeout" : "ingest-failed";
			return {
				written: [],
				warnings: [error],
				status: "error",
				errorCode
			};
		}
		/** Record the content hash in the ingest cache only after a successful
		* ingest, so a failed task is retried once its cooldown elapses.
		* @returns the recorded hash (undefined for URLs or unreadable files). */
		markIngested(input, context = this.captureProjectContext()) {
			if (/^https?:\/\//i.test(input)) return void 0;
			const cache = this.readCache(context.projectRoot);
			const source = resolveRawSourcePath(context.projectRoot, input);
			const hash = this.sha256(readRegularFileBounded(source, MAX_RAW_SOURCE_BYTES));
			cache[input] = hash;
			this.writeCache(cache, context.projectRoot);
			return hash;
		}
		/**
		* Expand a topic, search, and write research Candidates for the workspace captured at entry.
		* Written pages receive Candidate reviews and invalidate that workspace's cached snapshot.
		* @param request - Topic passed to query expansion and synthesis.
		* @param signal - Cancels executor stages; pipeline cancellation/failure becomes a degraded result.
		* @returns Findings with project-relative paths and warnings; pipeline failures include an error code.
		* @throws If recording Candidate reviews fails after the pipeline returns.
		*/
		async deepResearch(request, signal) {
			const context = this.captureProjectContext();
			let result;
			try {
				result = await deepResearch(this.stageExecutor, this.llmProvider, this.llmModel, context.projectRoot, request.topic, signal);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					findings: [],
					warnings: [message],
					degraded: true,
					errorCode: message.includes("stage executor unavailable") ? "stage-executor-unavailable" : "research-failed"
				};
			}
			appendCandidateReviews(this.reviewFile(context.projectRoot), context.projectRoot, `research:${request.topic}`, result.written);
			if (result.written.length > 0) this.snapshots.invalidate(context.wikiRoot);
			return {
				findings: result.written.map((path) => ({
					title: basename(path),
					path
				})),
				warnings: result.warnings,
				degraded: result.warnings.length > 0
			};
		}
		/**
		* Unresolved review items from .llm-wiki/review.json.
		* @param request - status filter and limit.
		* @returns matching review items.
		*/
		reviews(request) {
			return promiseFromSync(() => {
				const all = readOptionalJson(this.reviewFile(), []);
				if (!Array.isArray(all)) throw new Error("invalid knowledge review state");
				const status = request.status ?? "unresolved";
				return (status === "all" ? all : all.filter((item) => status === "resolved" ? item.resolved : !item.resolved)).slice(0, request.limit ?? 100);
			});
		}
		/**
		* Ask the injected independent authority to verify a Candidate, then bind a passing receipt to its review.
		* Receipt persistence precedes review binding; this operation does not apply the governance action.
		* @param request - Review id and proposed governance action to bind into verification.
		* @param signal - Cancellation checked around and passed through the independent verifier call.
		* @returns Verdict/evidence or an explicit blocker; binding failure retains the receipt with ok: false.
		* @throws On cancellation, authority errors, malformed persisted state, or uncaught I/O failures.
		*/
		async verifyCandidate(request, signal) {
			const authority = this.verifierAuthority;
			const reviewFile = this.reviewFile();
			const result = await verifyCandidate(authority, reviewFile, this.activeWikiRoot, request.reviewId, request.action, signal);
			if (result.ok && result.receiptId !== void 0) {
				if (!recordCandidateVerification(authority, reviewFile, this.activeWikiRoot, request.reviewId, result.receiptId, request.action)) return {
					...result,
					ok: false,
					errorCode: "verification-failed"
				};
			}
			return result;
		}
		/**
		* Resolve one review item.
		* @param request - review id and optional action.
		* @returns whether the item was found and updated.
		*/
		resolveReview(request) {
			return promiseFromSync(() => {
				const reviewFile = this.reviewFile();
				const advisory = resolveAdvisoryReviewBatch(reviewFile, [request.reviewId], request.action ?? "skip");
				if (advisory.resolvedCount > 0) return true;
				for (const candidateId of advisory.candidateIds) {
					const candidateResult = applyCandidateReview(this.verifierAuthority, reviewFile, this.currentRoot, this.activeWikiRoot, join(this.mainRoot, "jiuzhang-tarballs", "archive"), candidateId, request.action ?? "Skip");
					if (candidateResult) this.snapshots.invalidate(this.activeWikiRoot);
					return candidateResult === true;
				}
				return false;
			});
		}
		/**
		* Bulk-resolve review items.
		* @param request - review ids and optional action.
		* @returns the number resolved.
		*/
		resolveReviews(request) {
			return promiseFromSync(() => {
				const projectRoot = this.currentRoot;
				const wikiRoot = this.activeWikiRoot;
				const reviewFile = this.reviewFile(projectRoot);
				const advisory = resolveAdvisoryReviewBatch(reviewFile, request.ids, request.action ?? "skip");
				let count = advisory.resolvedCount;
				let snapshotChanged = false;
				for (const id of advisory.candidateIds) if (applyCandidateReview(this.verifierAuthority, reviewFile, projectRoot, wikiRoot, join(this.mainRoot, "jiuzhang-tarballs", "archive"), id, request.action ?? "Skip")) {
					count += 1;
					snapshotChanged = true;
				}
				if (snapshotChanged) this.snapshots.invalidate(wikiRoot);
				return count;
			});
		}
		workspacesFile() {
			return join(this.mainRoot, ".llm-wiki", "workspaces.json");
		}
		readWorkspaces() {
			const file = this.workspacesFile();
			if (!existsSync(file)) return [];
			const parsed = JSON.parse(readRegularFileBounded(file, 5 * 1024 * 1024).toString("utf8"));
			if (parsed.workspaces === void 0) return [];
			if (!Array.isArray(parsed.workspaces)) throw new Error("invalid knowledge project registry");
			return parsed.workspaces.map((value) => {
				if (typeof value !== "object" || value === null) throw new Error("invalid knowledge project registry entry");
				const row = value;
				if (typeof row.path !== "string" || row.path.length === 0 || typeof row.name !== "string" || row.name.length === 0) throw new Error("invalid knowledge project registry entry");
				return {
					path: row.path,
					name: row.name
				};
			});
		}
		writeWorkspaces(workspaces) {
			atomicWriteFile(this.workspacesFile(), `${JSON.stringify({ workspaces }, null, 2)}\n`);
		}
		/**
		* Lists the list projects operation.
		* @returns The available workspaces and current workspace.
		*/
		listProjects() {
			return promiseFromSync(() => {
				return {
					projects: [{
						path: this.mainRoot,
						name: "万相织鉴",
						main: true
					}, ...this.readWorkspaces()],
					current: this.currentRoot
				};
			});
		}
		/**
		* Switch the active workspace.
		* @param request - workspace path (main or a registered workspace).
		* @returns the new current root.
		*/
		setProject(request) {
			return promiseFromSync(() => {
				const target = request.path.replace(/\/+$/u, "");
				if ([this.mainRoot, ...this.readWorkspaces().map((ws) => ws.path.replace(/\/+$/u, ""))].includes(target)) {
					if (this.currentRoot !== target) {
						this.currentRoot = target;
						this.projectGeneration += 1;
						this.restoreQueue(target);
						recoverCandidateReviewTransactions(this.verifierAuthority, this.reviewFile(target), this.activeWikiRoot, join(this.mainRoot, "jiuzhang-tarballs", "archive"));
					}
				}
				return { current: this.currentRoot };
			});
		}
		/**
		* Create and register a new workspace (initialized wiki/raw structure).
		* @param request - workspace name and path.
		* @returns the created path or an error.
		*/
		createProject(request) {
			return promiseFromSync(() => {
				try {
					const name = request.name.trim();
					const root = request.path.trim().replace(/\/+$/u, "");
					if (name.length === 0 || root.length === 0) return {
						path: "",
						error: "project name and path are required"
					};
					if (root === this.mainRoot) return {
						path: "",
						error: "主工作区已存在"
					};
					const workspaces = this.readWorkspaces();
					mkdirSync(join(root, "wiki", "concepts"), { recursive: true });
					mkdirSync(join(root, "wiki", "entities"), { recursive: true });
					mkdirSync(join(root, "wiki", "sources"), { recursive: true });
					mkdirSync(join(root, "raw", "sources"), { recursive: true });
					if (!existsSync(join(root, "wiki", "index.md"))) atomicWriteFile(join(root, "wiki", "index.md"), "# Wiki Index\n\n## Entities\n\n## Concepts\n\n## Sources\n");
					if (!existsSync(join(root, "wiki", "log.md"))) atomicWriteFile(join(root, "wiki", "log.md"), "# Research Log\n");
					if (!existsSync(join(root, "purpose.md"))) atomicWriteFile(join(root, "purpose.md"), `# 项目目的 — ${name}\n\n## 核心问题\n\n> 待补充\n`);
					if (!existsSync(join(root, "schema.md"))) atomicWriteFile(join(root, "schema.md"), "# Wiki Schema\n\n## Page Types\n\n| Type | Directory | Purpose |\n|------|-----------|---------|\n| entity | wiki/entities/ | Named things |\n| concept | wiki/concepts/ | Ideas and techniques |\n| source | wiki/sources/ | Source materials |\n");
					if (!workspaces.some((ws) => ws.path.replace(/\/+$/u, "") === root)) {
						workspaces.push({
							path: root,
							name
						});
						this.writeWorkspaces(workspaces);
					}
					return { path: root };
				} catch (error) {
					return {
						path: "",
						error: error instanceof Error ? error.message : String(error)
					};
				}
			});
		}
		/**
		* Remove a workspace from the registry (files untouched). The main
		* workspace cannot be removed.
		* @returns the remaining workspace list.
		* @param request - The request input.
		*/
		removeProject(request) {
			return promiseFromSync(() => {
				const target = request.path.replace(/\/+$/u, "");
				if (target === this.mainRoot) return {
					projects: [{
						path: this.mainRoot,
						name: "万相织鉴",
						main: true
					}, ...this.readWorkspaces()],
					current: this.currentRoot
				};
				const registered = this.readWorkspaces();
				if (!registered.some((ws) => ws.path.replace(/\/+$/u, "") === target)) return {
					projects: [{
						path: this.mainRoot,
						name: "万相织鉴",
						main: true
					}, ...registered],
					current: this.currentRoot
				};
				const remaining = registered.filter((ws) => ws.path.replace(/\/+$/u, "") !== target);
				this.writeWorkspaces(remaining);
				this.cancelPendingForRoot(target);
				if (this.currentRoot === target) {
					this.currentRoot = this.mainRoot;
					this.projectGeneration += 1;
					this.restoreQueue(this.mainRoot);
				}
				return {
					projects: [{
						path: this.mainRoot,
						name: "万相织鉴",
						main: true
					}, ...remaining],
					current: this.currentRoot
				};
			});
		}
		/**
		* Graph insights: surprising connections, isolated pages, bridge nodes,
		* and sparse communities.
		* @returns the insight report.
		*/
		async graphInsights() {
			const graph = await this.computeGraph();
			const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
			const isolated = graph.nodes.filter((node) => node.linkCount <= 1).slice(0, 20).map((node) => ({
				id: node.id,
				label: node.label,
				path: node.path
			}));
			const communityNeighbors = /* @__PURE__ */ new Map();
			for (const edge of graph.edges) {
				const a = nodesById.get(edge.source);
				const b = nodesById.get(edge.target);
				if (!a || !b) continue;
				let aCommunities = communityNeighbors.get(a);
				if (aCommunities === void 0) {
					aCommunities = /* @__PURE__ */ new Set();
					communityNeighbors.set(a, aCommunities);
				}
				aCommunities.add(b.community);
				let bCommunities = communityNeighbors.get(b);
				if (bCommunities === void 0) {
					bCommunities = /* @__PURE__ */ new Set();
					communityNeighbors.set(b, bCommunities);
				}
				bCommunities.add(a.community);
			}
			return {
				isolated,
				bridges: [...communityNeighbors.entries()].filter(([, communities]) => communities.size >= 3).map(([node, communities]) => ({
					id: node.id,
					label: node.label,
					path: node.path,
					communities: communities.size
				})).slice(0, 15),
				sparseCommunities: graph.communities.filter((community) => community.nodeCount >= 3).slice(0, 10).map((community) => ({
					id: community.id,
					nodeCount: community.nodeCount,
					topNodes: community.topNodes
				}))
			};
		}
		/**
		* Lint the wiki: broken wikilinks, empty pages, and isolated pages.
		* @returns the lint report.
		*/
		async lint() {
			const mdPages = (await this.list()).filter((page) => page.path.endsWith(".md"));
			const known = new Set(mdPages.map((page) => page.path));
			const brokenLinks = [];
			const emptyPages = [];
			for (const page of mdPages) {
				const body = readPage(this.activeWikiRoot, page.path).replace(/^---\n[\s\S]*?\n---\n?/u, "");
				if (body.trim().length === 0) emptyPages.push(page.path);
				for (const link of extractWikiLinkTargets(body)) {
					const target = link.replace(/\//gu, "/");
					const normalized = target.replace(/\.md$/u, "");
					if (!(known.has(target) || known.has(`${normalized}.md`) || [...known].some((knownPath) => knownPath.endsWith(`/${normalized}.md`) || knownPath === `${normalized}.md`))) brokenLinks.push({
						from: page.path,
						target
					});
				}
			}
			return {
				brokenLinks: brokenLinks.slice(0, 50),
				emptyPages,
				totalPages: mdPages.length
			};
		}
		/**
		* Export the whole knowledge-base project as a ZIP archive.
		* @returns the archive path or an error.
		*/
		async exportProject() {
			try {
				const outDir = join(this.currentRoot, ".llm-wiki", "exports");
				mkdirSync(outDir, { recursive: true });
				const outPath = join(outDir, `wanxiang-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.zip`);
				const { execFileSync } = await import("node:child_process");
				execFileSync("/usr/bin/zip", [
					"-r",
					"-q",
					outPath,
					"wiki",
					"raw",
					"purpose.md",
					"schema.md"
				], { cwd: this.currentRoot });
				return { path: outPath };
			} catch (error) {
				return {
					path: "",
					error: error instanceof Error ? error.message : String(error)
				};
			}
		}
		/**
		* Import a project archive: list the ZIP contents (wiki/raw/purpose/schema).
		* @param request - archive path.
		* @returns the archive summary or an error.
		*/
		async importProject(request) {
			try {
				const { execFileSync } = await import("node:child_process");
				return {
					ok: true,
					entries: execFileSync("/usr/bin/unzip", ["-l", request.path], { encoding: "utf8" }).split("\n").slice(3, -2).map((line) => line.trim().replace(/^.*\s/u, "")).filter(Boolean).slice(0, 200)
				};
			} catch (error) {
				return {
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				};
			}
		}
	};
})();
/**
* Normalize user input without repairing traversal into a different path.
* @param input - The input input.
* @returns The value produced by normalize wiki relative path.
*/
function normalizeWikiRelativePath(input) {
	if (input.includes("\0") || input.includes("\\")) throw new Error("invalid wiki path");
	const value = input.replace(/^\/+|\/+$/gu, "");
	const parts = value.split("/");
	if (value === "" || parts.some((part) => part === "" || part === "." || part === "..")) throw new Error("wiki path traversal is not allowed");
	return parts.join("/");
}
/**
* Checks the is blocked network address operation.
* @param address - The address input.
* @returns The value produced by is blocked network address.
*/
function resolveSafePath(root, input, allowMissingLeaf) {
	const relativePath = normalizeWikiRelativePath(input);
	return {
		relativePath,
		absolutePath: resolveConfinedPath(root, relativePath, allowMissingLeaf)
	};
}
function resolveRawSourcePath(projectRoot, input) {
	const normalized = normalizeWikiRelativePath(input);
	const prefix = "raw/sources/";
	if (normalized === "" || normalized === "raw/sources") throw new Error("raw source path must name a file below raw/sources");
	const rel = normalized.startsWith(prefix) ? normalized.slice(12) : normalized;
	return resolveSafePath(resolve(projectRoot, "raw", "sources"), rel, false).absolutePath;
}
/**
* Checks whether an address belongs to a network range blocked by the wiki fetcher.
* @param address - The address to classify.
* @returns Whether the address belongs to a blocked range.
*/
function isBlockedNetworkAddress(address) {
	const value = address.toLowerCase().replace(/^\[|\]$/gu, "");
	if (isIP(value) === 4) {
		const parsed = parseIpv4(value);
		return parsed === void 0 || IPV4_BLOCKED_RANGES.some(([network, bits]) => cidr4(parsed, network, bits));
	}
	if (isIP(value) === 6) {
		const parsed = parseIpv6(value);
		if (parsed === void 0) return true;
		const mapped = ipv6EmbeddedIpv4(parsed);
		if (mapped !== void 0) return isBlockedIpv4(mapped);
		return !cidr6(parsed, 8192n << 112n, 3) || IPV6_BLOCKED_RANGES.some(([network, bits]) => cidr6(parsed, network, bits));
	}
	return false;
}
const IPV4_BLOCKED_RANGES = [
	[0, 8],
	[167772160, 8],
	[1681915904, 10],
	[2130706432, 8],
	[2851995648, 16],
	[2886729728, 12],
	[3221225472, 24],
	[3221225984, 24],
	[3227017984, 24],
	[3232235520, 16],
	[3323068416, 15],
	[3325256704, 24],
	[3405803776, 24],
	[3758096384, 4],
	[4026531840, 4]
];
const IPV6_BLOCKED_RANGES = [
	[0n, 96],
	[0n, 128],
	[1n, 128],
	[524413980668812575603097810486951936n, 48],
	[1329227995784915872903807060280344576n, 64],
	[42540488161975842760550356425300246528n, 32],
	[42540488320432167789079031612388147200n, 48],
	[42540489429626442988779757922003451904n, 28],
	[42540490697277043217009159418706657280n, 28],
	[42540766411282592856903984951653826560n, 32],
	[42545680458834377588178886921629466624n, 16],
	[85065399433376081038215121361612832768n, 20],
	[334965454937798799971759379190646833152n, 7],
	[338288524927261089654018896841347694592n, 10],
	[338620831926207318622244848606417780736n, 10],
	[338953138925153547590470800371487866880n, 8]
];
function parseIpv4(input) {
	const parts = input.split(".");
	if (parts.length !== 4) return void 0;
	let output = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/u.test(part)) return void 0;
		const value = Number(part);
		if (value > 255) return void 0;
		output = output * 256 + value >>> 0;
	}
	return output;
}
function cidr4(value, network, bits) {
	const mask = bits === 0 ? 0 : 4294967295 << 32 - bits >>> 0;
	return (value & mask) >>> 0 === (network & mask) >>> 0;
}
function isBlockedIpv4(value) {
	return IPV4_BLOCKED_RANGES.some(([network, bits]) => cidr4(value, network, bits));
}
function parseIpv6(input) {
	if (input.includes("%") || input.split("::").length > 2) return void 0;
	let source = input;
	const ipv4Tail = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(source)?.[1];
	if (ipv4Tail !== void 0) {
		const ipv4 = parseIpv4(ipv4Tail);
		if (ipv4 === void 0) return void 0;
		source = source.slice(0, -ipv4Tail.length) + `${(ipv4 >>> 16).toString(16)}:${(ipv4 & 65535).toString(16)}`;
	}
	const [leftRaw = "", rightRaw] = source.split("::");
	const left = leftRaw === "" ? [] : leftRaw.split(":");
	const right = rightRaw === void 0 || rightRaw === "" ? [] : rightRaw.split(":");
	const missing = 8 - left.length - right.length;
	if (rightRaw === void 0 && missing !== 0 || rightRaw !== void 0 && missing < 1) return void 0;
	const parts = [
		...left,
		...Array.from({ length: missing }, () => "0"),
		...right
	];
	if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/u.test(part))) return void 0;
	return parts.reduce((result, part) => result << 16n | BigInt(`0x${part}`), 0n);
}
function cidr6(value, network, bits) {
	if (bits === 0) return true;
	const shift = BigInt(128 - bits);
	return value >> shift === network >> shift;
}
function ipv6EmbeddedIpv4(value) {
	const prefix96 = value >> 32n;
	if (prefix96 === 65535n || prefix96 === 122099644659926101980610560n) return Number(value & 4294967295n);
}
async function publicAddressFor(url) {
	if (!["http:", "https:"].includes(url.protocol)) throw new Error("only http and https URLs are allowed");
	if (url.username || url.password) throw new Error("URL credentials are not allowed");
	if (url.port && !(url.protocol === "http:" && url.port === "80" || url.protocol === "https:" && url.port === "443")) throw new Error("non-default URL ports are not allowed");
	const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
	if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) throw new Error("local network targets are not allowed");
	const family = isIP(hostname);
	const addresses = family === 4 || family === 6 ? [{
		address: hostname,
		family
	}] : await lookup(hostname, {
		all: true,
		order: "verbatim"
	});
	if (addresses.length === 0 || addresses.some((item) => isBlockedNetworkAddress(item.address))) throw new Error("private or non-routable network targets are not allowed");
	const selected = addresses[0];
	if (selected === void 0 || selected.family !== 4 && selected.family !== 6) throw new Error("URL target has no supported public address");
	return {
		address: selected.address,
		family: selected.family
	};
}
/**
* Start one HTTP(S) GET with DNS lookup pinned to the supplied address.
* The caller validates the URL/address and handles redirects, status, deadlines, and body limits.
* @param url - Request URL; its host is retained for Host and HTTPS server-name verification.
* @param address - Prevalidated destination address and IP family supplied to the lookup callback.
* @param signal - Passed to Node's request to abort transport, including an outstanding response body.
* @param tlsAuthority - Optional HTTPS CA certificates; omitted to use Node's default trust roots.
* @returns Response when headers arrive; the caller must consume or destroy its body.
* @throws Rejects on request setup, transport, TLS, or abort errors before the response is returned.
*/
function requestPinned(url, address, signal, tlsAuthority) {
	const pinnedLookup = ((_hostname, options, callback) => {
		if (typeof options === "object" && options !== null && Reflect.get(options, "all") === true) callback(null, [address]);
		else callback(null, address.address, address.family);
	});
	return new Promise((resolveRequest, reject) => {
		const options = {
			method: "GET",
			signal,
			lookup: pinnedLookup,
			...url.protocol === "https:" ? {
				servername: url.hostname,
				ca: tlsAuthority
			} : {},
			headers: {
				Host: url.host,
				"User-Agent": "Mozilla/5.0 (Ark knowledge engine)",
				Accept: "text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.1"
			}
		};
		const request$2 = (url.protocol === "https:" ? request$1 : request)(url, options, resolveRequest);
		request$2.once("error", reject);
		request$2.end();
	});
}
/**
* Consume a response through EOF with a byte ceiling, destroying it when the ceiling is exceeded.
* @param response - Response stream whose chunks are collected in arrival order.
* @param limit - Maximum accumulated body bytes; the over-limit diagnostic always says 5 MiB.
* @param signal - Checked for each yielded chunk; the transport owner must abort a stalled read.
* @returns Concatenated bytes after the stream ends, including an empty buffer for an empty body.
* @throws On stream failure, cancellation observed at a chunk, or accumulated bytes exceeding limit.
*/
async function readResponseBounded(response, limit, signal) {
	const chunks = [];
	let total = 0;
	for await (const value of response) {
		signal.throwIfAborted();
		const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
		total += chunk.byteLength;
		if (total > limit) {
			response.destroy(/* @__PURE__ */ new Error("remote document exceeds 5 MiB"));
			throw new Error("remote document exceeds 5 MiB");
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks, total);
}
async function fetchPublicText(input, ownerSignal) {
	let url = new URL(input);
	for (let redirects = 0; redirects <= 5; redirects += 1) {
		ownerSignal.throwIfAborted();
		const address = await publicAddressFor(url);
		ownerSignal.throwIfAborted();
		const requestController = new AbortController();
		const forwardAbort = () => {
			requestController.abort(ownerSignal.reason);
		};
		ownerSignal.addEventListener("abort", forwardAbort, { once: true });
		const timeout = setTimeout(() => {
			requestController.abort(/* @__PURE__ */ new Error("remote document request timed out after 15 seconds"));
		}, 15e3);
		try {
			const response = await requestPinned(url, address, requestController.signal);
			const status = response.statusCode ?? 0;
			if (status >= 300 && status < 400) {
				const location = response.headers.location;
				response.destroy();
				if (typeof location !== "string" || location === "") throw new Error(`redirect ${status} has no location`);
				url = new URL(location, url);
				continue;
			}
			if (status < 200 || status >= 300) {
				response.destroy();
				throw new Error(`fetch failed (${status})`);
			}
			if (Number(response.headers["content-length"] ?? 0) > 5 * 1024 * 1024) {
				response.destroy();
				throw new Error("remote document exceeds 5 MiB");
			}
			return {
				text: (await readResponseBounded(response, 5 * 1024 * 1024, requestController.signal)).toString("utf8"),
				url: url.toString()
			};
		} finally {
			clearTimeout(timeout);
			ownerSignal.removeEventListener("abort", forwardAbort);
		}
	}
	throw new Error("too many redirects");
}
function readFileIfExists(path) {
	try {
		return readRegularFileBounded(path, 5 * 1024 * 1024).toString("utf8");
	} catch (error) {
		if (!isMissingPathError$2(error)) throw error;
		return "";
	}
}
function ingestFailure(error, errorCode) {
	return {
		written: [],
		warnings: [error instanceof Error ? error.message : String(error)],
		status: "error",
		errorCode
	};
}
/** Stable issue key used to append repeated repair attempts to one Incident. */
function issueSlugFrom(issueKey) {
	return issueKey.trim().toLowerCase().replace(/[\\/:*?"<>|\s]+/gu, "-").replace(/-+/gu, "-").replace(/^-|-$/gu, "").slice(0, 64) || "unresolved-incident";
}
/** Append one session delta to an existing Incident instead of creating another page. */
function mergeIncidentCandidate(existing, incoming, sessionId, today, resolutionStatus) {
	if (existing.includes(`session:${sessionId}`)) return existing;
	let merged = existing.replace(/^updated:\s*.*$/mu, `updated: ${today}`).replace(/^resolution_status:\s*.*$/mu, `resolution_status: ${resolutionStatus}`);
	merged = merged.replace(/^sources:\s*\[([^\]]*)\]$/mu, (_line, inner) => {
		const prefix = inner.trim();
		return `sources: [${prefix}${prefix ? ", " : ""}"session:${sessionId}"]`;
	});
	const body = incoming.replace(/^---\n[\s\S]*?\n---\n*/u, "").replace(/^#[^\n]*\n*/u, "").trim();
	return `${merged.trimEnd()}\n\n## 会话增量 ${sessionId.slice(0, 8)}\n\n${body}\n`;
}
/** Upsert repeated sessions into one stable topic candidate instead of creating siblings. */
function mergeSessionCandidate(existing, incoming, sessionId, today, heading) {
	if (existing.includes(`session:${sessionId}`)) return existing;
	let merged = existing.replace(/^updated:\s*.*$/mu, `updated: ${today}`);
	merged = merged.replace(/^evidence_count:\s*(\d+)\s*$/mu, (_line, count) => `evidence_count: ${Number(count) + 1}`);
	merged = merged.replace(/^sources:\s*\[([^\]]*)\]$/mu, (_line, inner) => {
		const prefix = inner.trim();
		return `sources: [${prefix}${prefix ? ", " : ""}"session:${sessionId}"]`;
	});
	const delta = incoming.replace(/^---\n[\s\S]*?\n---\n*/u, "").replace(/^#[^\n]*\n*/u, "").trim();
	return `${merged.trimEnd()}\n\n## ${heading} ${sessionId.slice(0, 8)}\n\n${delta}\n`;
}
/** 会话提炼 prompt：要求 LLM 输出结构化 JSON（标题/要点/相关概念）。 */
function buildSummaryPrompt(conversation) {
	return [
		"你是知识库准入审查员。判断以下完整会话是否包含值得长期保留的新知识，或者是在反复处理同一个尚未关闭的问题。",
		"不要因为会话很长、完成了任务或包含技术细节就保留。操作过程、工具调用、构建日志、提交哈希、文件路径、部署状态、进度确认和“继续/看看/修一下”都不是知识。",
		"助手自己声称“已完成/已修复”、编译通过、打包成功、提交完成都不是问题已解决的证据。",
		"如果用户在后续轮次继续报告同一症状，前面的修复尝试必须视为 failed 或 superseded，问题保持 open。",
		"只有用户明确确认、刷新或重启后的真实复现通过、针对原问题的测试通过、或明确观察到未再复发，才能输出 incident_verified。",
		"同一个问题无论尝试多少次，只输出一个稳定 issue_key 和一组 attempts，不要拆成多条知识。",
		"如果只是重复已有结论且没有新增尝试、证据或稳定知识，action 必须是 skip。",
		"每项评分为 0-2：reusable 可复用性、novelty 新颖性、evidence 证据性、stability 稳定性；总分低于 6 必须 skip。",
		"上述评分只约束 candidate；incident_open 可以低分保存为未关闭事件，但不能晋升知识。",
		"candidate 必须至少包含 claims、decisions、procedures 之一；一次会话最多生成一个候选主题、一个 reflection 或一个 Incident。",
		"reflection 不是事实，只用于记录可复用的失败反思。必须同时包含失败模式、根因假设、反事实做法、防复发动作、适用条件和证据；“以后更仔细/加强验证/已经完成”一律 skip。",
		"同一 reflection 或 candidate 必须输出稳定 topic_key，后续会话更新同一候选并累计证据，不得换标题制造新页。",
		"单一会话无论包含多少轮都只算一个来源；reflection 默认 hypothesis，不能声称 verified。",
		"只输出 JSON：",
		"{\"action\":\"skip|candidate|reflection|incident_open|incident_verified\",\"reason\":\"判断理由\",\"title\":\"稳定主题名\",\"topic_key\":\"知识或反思的稳定主题键\",\"issue_key\":\"组件:对象:症状；仅事件填写\",\"claims\":[\"可验证主张\"],\"decisions\":[\"可复用决定\"],\"procedures\":[\"可重复流程\"],\"failure_pattern\":\"仅 reflection\",\"root_cause_hypothesis\":\"仅 reflection\",\"counterfactual\":\"仅 reflection\",\"prevention\":\"仅 reflection\",\"applicability\":\"仅 reflection\",\"attempts\":[{\"hypothesis\":\"假设\",\"action\":\"采取的动作\",\"result\":\"proposed|applied|failed|unverified|superseded|verified|reverted\"}],\"final_root_cause\":\"仅 verified 填写\",\"final_fix\":\"仅 verified 填写\",\"verification_evidence\":[\"用户确认或真实验证证据\"],\"related\":[\"相关正式概念\"],\"scores\":{\"reusable\":0,\"novelty\":0,\"evidence\":0,\"stability\":0}}",
		"",
		"对话内容：",
		conversation
	].join("\n");
}
/** 解析 LLM 返回的提炼 JSON（容忍 ```json 围栏与前后杂音）。 */
function parseSummaryJson(text) {
	const cleaned = text.replace(/```json/gu, "").replace(/```/gu, "").trim();
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	try {
		const parsed = JSON.parse(cleaned.slice(start, end + 1));
		const empty = (action = "skip") => ({
			action,
			title: "",
			summary: "",
			related: [],
			issueKey: ""
		});
		if (parsed.action === "skip") return empty();
		const action = parsed.action;
		if (![
			"candidate",
			"reflection",
			"incident_open",
			"incident_verified"
		].includes(action) || typeof parsed.title !== "string" || !parsed.title.trim()) return null;
		const title = parsed.title.trim();
		if (/^(会话知识沉淀|会话沉淀|问题解决|继续)$/u.test(title)) return empty();
		const list = (value) => Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim() !== "").map((item) => item.trim()) : [];
		const claims = list(parsed.claims);
		const decisions = list(parsed.decisions);
		const procedures = list(parsed.procedures);
		const verificationEvidence = list(parsed.verification_evidence);
		const issueKey = typeof parsed.issue_key === "string" ? parsed.issue_key.trim() : "";
		const topicKey = typeof parsed.topic_key === "string" ? parsed.topic_key.trim() : "";
		const incident = action === "incident_open" || action === "incident_verified";
		const reflection = action === "reflection";
		if (incident && !issueKey) return null;
		if (!incident && !reflection && claims.length + decisions.length + procedures.length === 0) return empty();
		const reflectionFields = reflection ? [
			parsed.failure_pattern,
			parsed.root_cause_hypothesis,
			parsed.counterfactual,
			parsed.prevention,
			parsed.applicability
		] : [];
		if (reflection && (reflectionFields.some((value) => typeof value !== "string" || value.trim() === "") || !topicKey)) return empty();
		const scores = parsed.scores && typeof parsed.scores === "object" ? parsed.scores : {};
		const values = [
			"reusable",
			"novelty",
			"evidence",
			"stability"
		].map((key) => Number(scores[key]));
		if (!incident && (values.some((value) => !Number.isFinite(value) || value < 0 || value > 2) || values.reduce((sum, value) => sum + value, 0) < 6)) return empty();
		const verifiedEvidence = verificationEvidence.filter((item) => /用户.*确认|真实.*(?:页面|运行时|复现)|(?:测试|复现).*(?:通过|正常)|(?:刷新|重启).*(?:通过|正常)|未再复发/u.test(item));
		const effectiveAction = action === "incident_verified" && verifiedEvidence.length === 0 ? "incident_open" : action;
		const sections = [];
		const add = (heading, items) => {
			if (items.length > 0) sections.push(`## ${heading}\n\n${items.map((item) => `- ${item}`).join("\n")}`);
		};
		add("可验证主张", claims);
		add("可复用决定", decisions);
		add("可重复流程", procedures);
		if (reflection) {
			add("失败模式", [String(parsed.failure_pattern).trim()]);
			add("根因假设", [String(parsed.root_cause_hypothesis).trim()]);
			add("反事实做法", [String(parsed.counterfactual).trim()]);
			add("防复发动作", [String(parsed.prevention).trim()]);
			add("适用条件", [String(parsed.applicability).trim()]);
			add("证据", verificationEvidence);
		} else if (incident) {
			sections.push(`## 当前状态\n\n${effectiveAction === "incident_verified" ? "verified" : "open"}`);
			add("修复尝试", (Array.isArray(parsed.attempts) ? parsed.attempts : []).flatMap((raw, index) => {
				if (!raw || typeof raw !== "object") return [];
				const attempt = raw;
				const hypothesis = typeof attempt.hypothesis === "string" ? attempt.hypothesis.trim() : "";
				const attemptedAction = typeof attempt.action === "string" ? attempt.action.trim() : "";
				const result = typeof attempt.result === "string" ? attempt.result.trim() : "unverified";
				if (!hypothesis && !attemptedAction) return [];
				return [`${index + 1}. [${result}] ${hypothesis}${attemptedAction ? `；动作：${attemptedAction}` : ""}`];
			}));
			if (effectiveAction === "incident_verified") {
				add("最终根因", typeof parsed.final_root_cause === "string" && parsed.final_root_cause.trim() ? [parsed.final_root_cause.trim()] : []);
				add("最终修复", typeof parsed.final_fix === "string" && parsed.final_fix.trim() ? [parsed.final_fix.trim()] : []);
				add("验证证据", verifiedEvidence);
			}
		} else add("证据", verificationEvidence);
		return {
			action: effectiveAction,
			title,
			summary: sections.join("\n\n"),
			related: Array.isArray(parsed.related) ? parsed.related.filter((r) => typeof r === "string") : [],
			issueKey: incident ? issueKey : topicKey || title
		};
	} catch {
		return null;
	}
}
//#endregion
export { KNOWLEDGE_WIKI_ENDPOINT_METADATA, KnowledgeWikiService as default, isBlockedNetworkAddress, normalizeWikiRelativePath, readResponseBounded, requestPinned };
