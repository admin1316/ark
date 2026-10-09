# Knowledge search shadow

[English](README.md) | 中文

这是一个隔离的 Rust shadow 候选，用于实现 [`packages/host/knowledge-wiki/src/search.ts`](../../packages/host/knowledge-wiki/src/search.ts) 中的纯分词和 BM25 内核。它从 stdin 接收一条 UTF-8 JSON 请求，从 stdout 输出一条 JSON 响应。请求包含 `schemaVersion: 1`、`pages` 和 `queries`；每个页面包含 `path`、`title`、`aliases` 和 `text`。

该进程不连接 Cordis、Agent、Session、credential、JavaScript callback、模型 provider 或外部服务。它为每个 query 计算稳定的结果列表，并为序列化后的结果字节和输入字节提供 SHA-256 摘要。调用方可以在 shadow 模式运行它；解析失败、进程退出、超时或差分回放失败时都必须丢弃结果。

使用 `cargo test --manifest-path rust/knowledge-search-shadow/Cargo.toml` 构建并测试。使用 `cargo build --release --manifest-path rust/knowledge-search-shadow/Cargo.toml` 构建 release binary；binary 位于 `target/release/knowledge-search-shadow`。这个 crate 有意放在 workspace 之外，不会被任何 profile 加载。

当前实现只是候选内核。生产环境继续使用 TypeScript，直到 benchmark harness 在要求的语料和平台上记录当前 TypeScript、优化 TypeScript 与真实 Rust 进程的匹配结果和性能指标。
