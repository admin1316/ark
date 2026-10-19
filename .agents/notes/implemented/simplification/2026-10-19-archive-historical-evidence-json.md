# Agent Note: Retain current evidence and archive historical JSON

Status: implemented

English | [中文](2026-10-19-archive-historical-evidence-json.zh.md)

## Problem

The migration branch tracked dated candidate and superseded result JSON beside the source and the current acceptance inputs. Keeping every historical output in the working tree made the repository noisy, obscured the evidence that current checks actually consume, and allowed benchmark run receipts to accumulate as independent files.

## Decision

The repository keeps the current acceptance inventory and the seven run receipts referenced by the retained aggregate benchmark records. The other 61 historical result JSON files are removed from the working tree. `scripts/rust-migration/historical-evidence-index.tsv` records each removed path, byte count, line count, and SHA-256. A local quarantine archive retains the exact bytes for rollback and forensic replay; it is intentionally outside the repository. Human-facing links point to the index, while append-only progress and security records retain their original historical path and hash pairs. New benchmark run receipts are ignored until they are folded into an aggregate record.

## Alternatives considered

**Keep every historical result in Git.** Rejected because the current acceptance inputs already define the evidence required for a run, while dated superseded outputs increase checkout noise and make generated accumulation look like source.

**Delete the files without an archive.** Rejected because the old results remain useful for forensic comparison and their path hashes are part of the retained cleanup evidence.

**Commit one raw archive to GitHub.** Rejected because it would preserve the same generated bulk in another form and would make routine source checkouts carry evidence that current code does not consume.

## Consequences

Current source, tests, acceptance artifacts, and aggregate benchmark receipts remain available in a clean checkout. Historical raw results require the local quarantine archive and its SHA-256 index for restoration; the repository no longer presents those results as active inputs. Future benchmark runs cannot silently add one JSON file per attempt without an explicit aggregation step.
