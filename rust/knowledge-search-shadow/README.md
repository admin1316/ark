# Knowledge search shadow

English | [中文](README.zh.md)

This isolated binary is a Rust shadow candidate for the pure tokenization and BM25 kernel in [`packages/host/knowledge-wiki/src/search.ts`](../../packages/host/knowledge-wiki/src/search.ts). It accepts one UTF-8 JSON request on stdin and emits one JSON response on stdout. The request contains `schemaVersion: 1`, `pages`, and `queries`; each page has `path`, `title`, `aliases`, and `text`.

The process has no connection to Cordis, Agent, Session, credentials, JavaScript callbacks, model providers, or external services. It computes one stable result list per query and includes a SHA-256 digest for the serialized result bytes and the input bytes. A caller may run it in shadow mode and discard the result whenever parsing, process exit, timeout, or differential replay fails.

Scores use ECMAScript-compatible JSON number formatting for both response serialization and result hashing. The TypeScript parent checks string limits in UTF-8 bytes before spawning: request/session identities are limited to 256 bytes, paths to 1024 bytes, page titles/text/each alias to 128 KiB, and queries to 8192 bytes and 256 tokenizer outputs before stop-word filtering. The Rust parser independently enforces these limits. Invalid requests fall back in shadow mode and fail closed in enforce mode; TypeScript production search is unaffected by the candidate limits.

Compatible number formatting does not guarantee identical score bits: native Rust `ln` and Node `Math.log` can return different approximations for the same input. Differential replay checks complete scores, ordering, and serialized result digests without tolerance. A differing score still falls back in shadow mode and fails closed in enforce mode, even when its ordering is unchanged. Platform and corpus replay remain required before activation.

Build and test it with `cargo test --manifest-path rust/knowledge-search-shadow/Cargo.toml`. Build the release binary with `cargo build --release --manifest-path rust/knowledge-search-shadow/Cargo.toml`; the binary is `target/release/knowledge-search-shadow`. The crate is intentionally outside the workspace and is not loaded by any profile.

The default invocation remains one request per process. An optional `--serve` mode reads sequential JSONL requests and writes one response line per request; it exists only for benchmark-only process-reuse measurements. It is bounded to 8 MiB per request, 16 MiB per response, 512 requests, and 256 MiB of request data per process. Malformed or over-limit input ends the process with an error. No Ark profile starts this mode.

The prepared index retains each document's token count, term frequencies, and title-term membership. It consumes the token vector while building frequencies and derives document frequency from unique frequency-map keys. BM25 parameters, repeated query terms, and stable tie ordering retain the TypeScript algorithm.

The current implementation is a candidate kernel only. Production remains TypeScript until the benchmark harness records matching current TypeScript, optimized TypeScript, and real Rust process measurements across the required corpus and platforms.
