# Knowledge search shadow

[English](README.md) | 中文

这是一个隔离的 Rust shadow 候选，用于实现 [`packages/host/knowledge-wiki/src/search.ts`](../../packages/host/knowledge-wiki/src/search.ts) 中的纯分词和 BM25 内核。它从 stdin 接收一条 UTF-8 JSON 请求，从 stdout 输出一条 JSON 响应。请求包含 `schemaVersion: 1`、`pages` 和 `queries`；每个页面包含 `path`、`title`、`aliases` 和 `text`。

该进程不连接 Cordis、Agent、Session、credential、JavaScript callback、模型 provider 或外部服务。它为每个 query 计算稳定的结果列表，并为序列化后的结果字节和输入字节提供 SHA-256 摘要。调用方可以在 shadow 模式运行它；解析失败、进程退出、超时或差分回放失败时都必须丢弃结果。

分数在响应序列化和结果哈希中都使用符合 ECMAScript 的 JSON 数字写法。TypeScript 父进程在启动子进程前按 UTF-8 字节检查字符串限制：请求和会话标识最多 256 字节，路径最多 1024 字节，页面标题、正文及每个别名最多 128 KiB，query 最多 8192 字节且在过滤停用词前最多生成 256 个 token。Rust 解析器独立执行同样的限制。无效请求在 shadow 模式回退，在 enforce 模式 fail closed；这些候选限制不影响 TypeScript 正式搜索。

数字写法兼容不保证分数位模式相同：Rust 原生 `ln` 与 Node `Math.log` 对同一输入可能返回不同的近似值。差分回放严格检查完整分数、顺序和序列化结果摘要，不使用容差。分数不同，即使顺序相同，也仍在 shadow 模式回退、在 enforce 模式 fail closed。启用前仍须完成平台和语料回放。

使用 `cargo test --manifest-path rust/knowledge-search-shadow/Cargo.toml` 构建并测试。使用 `cargo build --release --manifest-path rust/knowledge-search-shadow/Cargo.toml` 构建 release binary；binary 位于 `target/release/knowledge-search-shadow`。这个 crate 有意放在 workspace 之外，不会被任何 profile 加载。

默认调用仍是每个进程处理一条请求。可选的 `--serve` 模式会按顺序读取多条 JSONL 请求，并为每条请求输出一行响应；它只用于 benchmark 中测量进程复用。此模式受限于每条请求 8 MiB、每条响应 16 MiB、每个进程 512 条请求和每个进程累计 256 MiB 请求数据。输入格式错误或超限会使进程报错退出。没有任何 Ark profile 会启动此模式。

准备好的索引保留每个文档的 token 总数、词频和标题词成员集合。构建词频时消费 token 数组，再用词频表中唯一的键推导文档频率。BM25 参数、重复 query 词和同分结果的稳定顺序保持 TypeScript 算法。

当前实现只是候选内核。生产环境继续使用 TypeScript，直到 benchmark harness 在要求的语料和平台上记录当前 TypeScript、优化 TypeScript 与真实 Rust 进程的匹配结果和性能指标。
