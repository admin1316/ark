# Knowledge search shadow

English | [中文](README.zh.md)

This isolated binary is a Rust shadow candidate for the pure tokenization and BM25 kernel in [`packages/host/knowledge-wiki/src/search.ts`](../../packages/host/knowledge-wiki/src/search.ts). It accepts one UTF-8 JSON request on stdin and emits one JSON response on stdout. The request contains `schemaVersion: 1`, `pages`, and `queries`; each page has `path`, `title`, `aliases`, and `text`.

The process has no connection to Cordis, Agent, Session, credentials, JavaScript callbacks, model providers, or external services. It computes one stable result list per query and includes a SHA-256 digest for the serialized result bytes and the input bytes. A caller may run it in shadow mode and discard the result whenever parsing, process exit, timeout, or differential replay fails.

Build and test it with `cargo test --manifest-path rust/knowledge-search-shadow/Cargo.toml`. Build the release binary with `cargo build --release --manifest-path rust/knowledge-search-shadow/Cargo.toml`; the binary is `target/release/knowledge-search-shadow`. The crate is intentionally outside the workspace and is not loaded by any profile.

The current implementation is a candidate kernel only. Production remains TypeScript until the benchmark harness records matching current TypeScript, optimized TypeScript, and real Rust process measurements across the required corpus and platforms.
