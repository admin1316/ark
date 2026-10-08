# ARK intelligence runtime decision log

- The immutable project boundary is recorded in `project-manifest.json`; automatic runs may update evidence and benchmark observations but must reject changes to its immutable hashes.
- The current source truth is the checked-out GitHub-derived tree and the active Jiuzhang profile. The official Ark.app remains untouched.
- Knowledge promotion remains gated by independent authority, provenance, scope/ACL, freshness, conflict, utility, and replay evidence. Missing runtime evidence stays `UNKNOWN`.
- The offline formula experiment compares current BM25 with BM25F, BM25+, and RRF. Its small frozen fixture validates the replay plumbing only; no production formula change is authorized.
- The Rust knowledge-search implementation remains a default-disabled shadow. Differential replay matches the TypeScript result, but optimized TypeScript is faster at the measured process boundary and production cancellation, cross-platform, child CPU/RSS, and signed enforcement evidence are incomplete. Decision: `RETAIN_TS`.
- Smartness claims remain `UNKNOWN` until independently verified paired baseline/candidate outcomes show lower repeated errors, higher verified success and utility, zero unsafe recall/leakage/privilege escalation, and complete replay evidence.
