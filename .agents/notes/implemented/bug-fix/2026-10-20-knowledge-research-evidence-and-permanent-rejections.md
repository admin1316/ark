# Agent Note: Research citation ownership and durable extraction rejections

Status: implemented

English | [中文](2026-10-20-knowledge-research-evidence-and-permanent-rejections.zh.md)

## Problem

A real search result does not prevent a model from inventing another citation, declaring a generated page canonical, or returning no publishable page. A generic failure cooldown also repeats an unsupported or malformed local file after every expiry. Retaining a permanent failure only in bounded queue history loses that protection after pruning or restart.

## Decision

The research owner treats search URLs as authoritative identities and the model response as untrusted Markdown. It normalizes credential-free HTTP(S) URLs without changing query meaning, validates ordinary and reference links against the actual search set, and publishes only pages with a known citation. The Host generates candidate/research provenance, dates and the actually cited sources. Empty or invalid output, invalid citations, and an all-collision/write failure have distinct failure codes; partial success retains warnings. Search snippets remain explicitly labeled incomplete evidence. Neither a matching URL nor successful transport verifies the page's claims.

Local extraction rejects unsupported, binary, malformed, oversized and empty input with typed errors transported through the owned worker. Failed bytes and the actual decoder policy identify a permanent rejection. The existing source-disposition cache retains it independently of bounded queue history. A committed rejection suppresses its old restored lease, while a fresh admission identity preserves a user's explicit retry. Changed content or decoder policy allows another automatic attempt; temporary and unclassified historical failures retain their existing cooldown.

The native client validates source counts and per-page associations, rejects zero-page completion, and displays recorded research URLs with a search-snippet limitation. Opening a source reuses the isolated Workbench browser and consumes a single-use navigation intent. The browser continues to reject non-HTTP(S) or credentialed URLs and receives no Ark credential or local-file bridge.

## Alternatives considered

**Trust the prompt and model frontmatter.** Instructions cannot establish citation membership or override a supplied canonical status. Host-owned validation and stamping enforce the publication decision.

**Fetch every source or call another model to verify it.** The current research feature uses search snippets. Adding retrieval or a second opinion changes latency, cost and trust handling; it does not substitute for honest evidence labels and deterministic URL membership.

**Keep permanent rejections only in task history.** Bounded history deliberately discards terminal records. The source-disposition file owns replay suppression and already shares admission capacity, persistence and restoration checks.

**Block a filename forever.** A replacement document or corrected decoder can make the input processable. Content and policy fingerprints retain the rejection only while its cause remains applicable.

## Verification

A real YAML/Loader composition with the registered LLM runtime, owned executor and synthetic external search/model snapshots invalid citations, governed success and collision failure without a key. Focused tests cover link definitions, dangerous URLs, forced metadata, unchanged rejection after history pruning/restart, fresh retry admission and the cache/queue crash window. Native contracts check source decoding and persistent page provenance; candidate interaction remains a separate acceptance requirement.

## Consequences

Invalid pages consume no publication or review entry, and unchanged permanent file failures consume no repeated model call. The direct Markdown parser dependency replaces ad hoc link matching. Existing queue/cache files carry the extra identity; no additional state file exists. PDF/Office extraction and factual/full-page verification remain unavailable. The [explicit-routing decision](2026-10-20-ark-explicit-routing-and-durable-input.md) retains independent connection, project, cancellation and input-durability rationale; the [ingest decision](../architecture/2026-08-19-knowledge-wiki-contract-aligned-ingest.md) retains the broader queue and canonical write design, so both remain active.
