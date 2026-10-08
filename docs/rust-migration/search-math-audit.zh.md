# Ark 搜索数学公式审计

[English](search-math-audit.md) | 中文

**快照。** 本审计描述 2026-10-08 的源码 `32bb7275`；此前的 `02bf7ebc` benchmark 只作为历史证据。它是设计与验证记录，不修改正式公式，也不启用 Rust enforce。

## 结论

当前系统使用的是可解释的经典公式，但周边的字段处理、混合融合和图权重存在人为规则或实现漂移。BM25 与 cosine 应继续作为兼容基线。最值得优先验证的替代方案是：**结构化字段 BM25F，加上 lexical/semantic 结果的 reciprocal-rank fusion（RRF）**。在有标注查询集证明收益、且 Rust 实现同一契约前，不应改生产公式。

最近本地测量仍显示优化 TypeScript 快于 Rust 进程边界（代表性运行：优化 TypeScript p50 约 0.5–0.8 ms，Rust stdin/stdout p50 约 20.5–20.9 ms）。公式替换的目标应是检索质量和稳定性，不能预设 Rust 会提速。

## 公式清单与发现

### 1. BM25 关键词分数

`packages/host/knowledge-wiki/src/search.ts:100-125`、Rust shadow 和 benchmark 使用 Okapi BM25：

```text
S(q,d) = Σ_t IDF(t) · ((tf(t,d) · (k1 + 1)) /
         (tf(t,d) + k1 · (1 - b + b · |d| / avgdl)))
IDF(t) = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
k1 = 1.5, b = 0.75
```

核心公式适合作为基线，但实现有四个问题：

1. 标题、别名和正文拼接，字段重要性与长度归一化耦合。
2. 每个命中的标题/别名 query token 都把整条分数乘 `1.5`；两个命中就是 `1.5²`，与“double”的注释不一致。
3. 重复 query token 被重复计分，没有明确的 query-term 模型。
4. Rust 候选正确复刻这些行为，这证明兼容性，不证明它们是最好的排序策略。

**建议验证：** BM25F。分开字段，先分别归一化再聚合：

```text
F(t,d) = Σ_f w_f · tf_f(t,d) /
         (1 - b_f + b_f · |d_f| / avgdl_f)
S_BM25F(q,d) = Σ_t IDF(t) · ((k1 + 1) · F(t,d)) / (k1 + F(t,d))
```

字段可使用 body、title、alias，权重由标注查询集学习。若长页面被系统性压低，再单独测试 BM25+：

```text
S_BM25+(q,d) = S_BM25(q,d) + δ · IDF(t)  for terms with tf(t,d) > 0
```

`δ` 必须调参，不能直接当作普遍改进。Lv 与 Zhai 的 BM25+ 研究指出，传统 TF 长度归一化可能过度惩罚长文档，并报告 verbose query 上的收益（[CIKM 2011 原文](https://timan.cs.illinois.edu/czhai/pub/cikm11-bm25.pdf)）。

### 2. 关键词/向量混合分数

`search.ts:181-243` 只给 BM25 前 15 页做 embedding，最终仍只输出 lexical 前 `topK` 页。当前分数是：

```text
S(d) = 0.7 · BM25(d) / max(BM25) +
       0.3 · cosine(query, d) / max(cosine)
```

问题是：

- lexical 前 15 之外的 semantic hit 永远不能进入结果。
- 每个 query 的 max normalization 不稳定，跨 query 分数不可比。
- 现在 embedding 边界会拒绝空向量、缺失向量、维度不一致和非有限值。剩下的排序问题是负 cosine 会被截断为 0，而且 max 归一化混合仍不能让 lexical 候选集合之外的页面进入结果。

**建议验证：** lexical 与 vector 各自 over-fetch，再按排名融合：

```text
RRF(d) = α / (k + rank_bm25(d)) +
         (1 - α) / (k + rank_vector(d))
```

先用 `k=60`，再用留出查询调 `α`，并保留各来源 rank 供解释。RRF 的设计就是避免不兼容的分数尺度，原始评估中持续优于单个排序（[Cormack、Clarke、Büttcher，SIGIR 2009](https://research.google/pubs/reciprocal-rank-fusion-outperforms-condorcet-and-individual-rank-learning-methods/)）。如果必须融合分数，应使用独立拟合的 isotonic/logistic calibration，避免 query-local max。

Cosine 本身是标准公式：

```text
cos(a,b) = (a · b) / (||a||₂ ||b||₂)
```

保留它，当前已经有固定维度、finite 值和零向量检查。向量预归一化后可以使用 dot product。只有在有持久向量索引或 ANN 时，semantic 才能真正贡献 lexical 候选之外的新页面；HNSW 可以作为大语料的后续选择，现在没有理由为它引入 Rust。

### 2.1 benchmark 方法学限制

优化 benchmark 复用了预构建的 TypeScript index，而 current 实现每个 query 都重建 token frequency 和 document frequency。Rust 测量每次都新建进程、解析 JSON 并重建 index，三者执行边界不同。旧 optimized benchmark 只有 12 个 stop-word，正式搜索列出 257 个（去重后 244 个）；现在 benchmark 已复用正式 `STOP_WORDS` 集。此前合成语料上的 digest 一致因此不能证明完整等价。benchmark 也没有 warmup，迭代次数较少，并且同步循环无法取得 event-loop delay 样本。

benchmark 现在已经分开测量四种边界：TypeScript cold/rebuild、TypeScript warm/cached index、Rust warm persistent child、Rust cold process。Rust warm 路径复用子进程和管道，但当前 Rust 内核仍会为每个请求重建索引，因此不能据此证明有持久索引。helper 会记录 harness 级别的崩溃/重启探针；同步 harness 的取消仍明确标记为未测量。在用延迟数字决定迁移前，仍需分别报告 index build、序列化/IPC、embedding 和 search 的耗时，以及子进程 CPU/RSS 和生产取消/恢复证据。差分语料要加入 stop words、重复 query token、title/alias 命中、Unicode 与非 BMP 文本、缺失词、长页面和 byte-limit 边界。同一公式继续使用当前 exact digest contract；换 BM25F 或 RRF 必须建立版本化 baseline，不能放宽比较条件。

### 3. 图社区与链接特征

`graph.ts:229-281` 使用简化 Louvain modularity move。图构建统计了重复 raw edge，但邻接表在 `graph.ts:303-321` 强制存成 weight `1`，所以社区公式没有使用暴露的 edge weight。`GraphNode.linkCount` 实际只有 inbound，而类型注释描述 inbound+outbound；`CommunityInfo.cohesion` 永远为 0。

这些首先是 source-truth 漂移，而非马上换算法。应先保留权重并统一 weighted degree，再计算 cohesion，例如：

```text
cohesion(C) = 2 · E_inside(C) / (|C| · (|C| - 1))
```

bridge 检测可以用 participation coefficient：

```text
P(v) = 1 - Σ_C (k_v,C / k_v)²
```

只有在图契约修正、并证明质量需求后才考虑 Leiden。Louvain 可能产生断开的社区；Leiden 论文给出连通性保证，并报告更快和更好的分区（[Traag、Waltman、van Eck，2019](https://arxiv.org/abs/1810.08473)）。

### 4. 治理相似度、质量与 utility

候选去重使用归一化字符 n-gram Jaccard，包含特殊的 containment 处理和固定 `0.82` 阈值（`governance-policy.ts:268-315`）。质量分是 0–10 的人工特征加减分，晋级 confidence `min(0.98, 0.72 + 0.026 · score)` 是政策分，不是校准概率。

Knowledge utility 使用：

```text
U = (2 · successfulUses - 3 · userCorrections) /
    max(1, retrievalHits)
```

同一个 retrieval counter 被当作注入机会数；一次成功使用就可能得到很高点估计，没有置信区间。

应保留硬安全门、独立证据和冲突拒绝。获得标注后，再把 token/character similarity 作为特征，并用 isotonic/logistic 校准 promotion confidence。保留判断要分开 retrieval attempt 与 injection opportunity，并使用 Beta-Binomial posterior 或 Wilson lower bound，加最小样本数。不能凭直觉替换治理公式。

## 建议迁移顺序

| 优先级 | 变更 | 原因 | 门禁 |
| --- | --- | --- | --- |
| P0 | 记录 semantic candidate hits；定义完整 hybrid DTO | 向量边界已经校验，接着补可观测性 | semantic-candidate 与 malformed-vector 回归测试，以及 differential replay |
| P1 | BM25F shadow：title/alias/body 分字段 | 去掉 `1.5^m` 和字段长度耦合 | Recall@K、MRR、nDCG@K、exact alias 不回退 |
| P1 | 独立 lexical/vector over-fetch 后做 RRF shadow | 避免不稳定分数归一化和 lexical-only recall | judged queries，按语言和 query 类型切片 |
| P1 | 修复 graph weight、linkCount、cohesion | 先消除契约漂移 | graph fixture invariant 与 deterministic replay |
| P2 | 校准 governance confidence 和 utility | 让晋级/保留有统计解释 | 成对、独立验证的 outcome 与置信区间 |
| P3 | Leiden、HNSW、SPLADE 或 ColBERT late interaction | 复杂度和模型/索引依赖更高 | 只有规模或质量证据支持时才做 |

Rust shadow 应在 TypeScript shadow 稳定后，才实现约定好的 BM25F/RRF 契约。当前 Rust 仍是 BM25-only 候选，enforce 必须保持关闭。

## 必须做的实验

从真实候选 Ark query 建立带版本的 judged set：至少 50 条，覆盖中英文、别名、精确标识符、长解释、空/stop-word query 和跨语言 query；每条有独立 relevance label 与 query 类型。比较 current BM25、BM25F、BM25+、current hybrid、RRF，指标包括 Recall@5/10、MRR、nDCG@5/10、空结果率、stale/false recall、p50/p95 延迟、embedding 调用次数和内存。固定 corpus hash，并让所有候选通过同一治理过滤。只有在目标切片提升且不违反安全/延迟门禁时，公式才可从 shadow 进入候选 Ark。

离线 smoke scaffold 位于 `scripts/rust-migration/search-formula-experiment.ts`，测试位于 `search-formula-experiment.spec.ts`。运行 `pnpm exec tsx scripts/rust-migration/search-formula-experiment.ts`，即可在无网络条件下用一个固定 fixture 重放 current BM25、BM25F、BM25+ 和 RRF，并输出 Recall@5、MRR、nDCG@5、空结果率以及 corpus hash。这个 fixture 只用于确认可复现性和管线连通，Recall@5 全部为 1 不足以支持生产公式替换；在比较质量或晋级候选前，必须替换为独立审阅的 50 条 Ark judged set。

## 参考

- Robertson、Zaragoza，《The Probabilistic Relevance Framework: BM25 and Beyond》([PDF](https://www.staff.city.ac.uk/~sbrp622/papers/foundations_bm25_review.pdf))。
- Lv、Zhai，《Lower-Bounding Term Frequency Normalization》([CIKM PDF](https://timan.cs.illinois.edu/czhai/pub/cikm11-bm25.pdf))。
- Cormack、Clarke、Büttcher，《Reciprocal Rank Fusion》([Google Research](https://research.google/pubs/reciprocal-rank-fusion-outperforms-condorcet-and-individual-rank-learning-methods/))。
- Traag、Waltman、van Eck，《From Louvain to Leiden》([arXiv](https://arxiv.org/abs/1810.08473))。
- Khattab、Zaharia，《ColBERT》([SIGIR PDF](https://people.eecs.berkeley.edu/~matei/papers/2020/sigir_colbert.pdf))。
