# Agent Note：Knowledge Wiki 每个根目录复用 BM25 索引

[English](2026-10-11-knowledge-search-index-cache.md) | 中文

状态：已实现

## 问题

每个不同的搜索 query 都会遍历同一批 Wiki 文件、为每页分词并重新构建 BM25 词频与文档频率。现有 query-result cache 只对完全相同的 query 有效；连续提出不同问题时仍会反复支付页面读取和索引构建成本。

## 决策

`KnowledgeWikiService` 现在通过现有 `WikiSnapshotStore`，为每个 Wiki 根目录准备一次 `KnowledgeSearchIndex`。`modelSearch()` 和公开的 `search()` 路径共享这个根目录本地投影。Wiki 写入会使受影响根目录的所有 snapshot 失效；递归文件 watcher 也会在检测到外部编辑时执行相同操作。索引数据由 Wiki 文件派生，不会另存为独立事实来源。

Cache 只保存页面／token 评分数据。每个请求仍会读取当前受治理 Knowledge 记录，并在排序后执行既有 verifier 和访问检查。Rust shadow 对照使用同一份已缓存页面快照，并计算相同的 TypeScript BM25 oracle；生产搜索继续使用 TypeScript。

## 考虑过的替代方案

**只保留逐 query 结果缓存。** 不采用，因为不同 query 仍会重新读取并索引同一份 Wiki 语料。

**增加第二套持久化或 service 专属 cache。** 不采用，因为这会重复维护 `WikiSnapshotStore` 已有的所有权和失效逻辑。

**把 BM25 移到 Rust。** 当前活动路径不采用，因为测得的 Rust 进程路径慢于 TypeScript，而且没有实现完整的 hybrid embedding 契约。

## 验证

## 验证

定向 search 和 service-surface 套件通过 26/26 项，其中包含 prepared-index 差分检查，以及验证写入后旧词项不可搜索、新词项可以搜索的回归。Package typecheck 通过。[五 query cache 基准](../../../../scripts/rust-migration/knowledge-search-index-cache-current-20261011.json)使用绑定源码 hash 的 240 页合成语料，独立运行三轮、每轮 30 个批次；三轮结果一致，显式写入失效检查也全部通过。热批次 p50/p95/p99 从 48.988/53.216/54.600 ms 降至 0.559/0.696/1.528 ms，父进程 CPU 降低 98.95%。冷索引构建中位数为 9.496 ms，首个完整批次中位数为 11.758 ms。可复现的[单 query TypeScript/Rust 对照](../../../../scripts/rust-migration/knowledge-search-cache-vs-rust-reproduction-20261011.json)在同一份基于文件的合成 Wiki 上进行了三轮独立 30 样本测量，所有轮次的精确结果字节均匹配，三个 Rust worker 都正常退出。p50/p95/p99 中位数分别为：每次重读文件的 TypeScript 10.109/11.072/11.577 ms；从已解析页面重建索引的优化 TypeScript 2.172/3.024/4.048 ms；生产热缓存查找加评分 0.095/0.127/0.195 ms；新建 Rust 子进程 IPC 6.631/6.881/7.032 ms；常驻 Rust 4.079/4.595/5.554 ms。热缓存 p50 约比常驻 Rust 快 43 倍；Rust 仍慢于优化 TypeScript 和实际热路径。event-loop delay p95 已按 1 ms 分辨率采样，但各场景样本数不均；Rust 子进程 CPU/RSS 仍未计入。这些源码级测量不包括模型／provider 延迟、embeddings、verifier／ACL 工作、子进程总资源、压力、取消和恢复；不能据此声称 Ark UI 或真实 Wiki 端到端提速或稳定性提升。

## 结果

在同一份 Wiki 未变化时，多个不同搜索可避免重复遍历文件、分词和构建 BM25 索引。首次查询仍需支付冷索引构建成本，之后编辑会触发重建。既有 query-result cache、治理回放、verifier authority 和 ACL 行为仍由原 owner 管理。本改动没有建立崩溃恢复、压力测试、长时间运行或候选稳定性提升的证据。
