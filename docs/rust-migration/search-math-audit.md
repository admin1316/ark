# Ark search math audit

English | [中文](search-math-audit.zh.md)

**Snapshot.** This audit describes source code at `02bf7ebc` on 2026-10-08. It is a design and verification record; it does not change the production formula or enable Rust enforcement.

## Verdict

The current system uses sound, explainable classical formulas, but several surrounding choices are ad-hoc or mathematically inconsistent. Keep BM25 and cosine as compatibility baselines. The first replacement worth testing is **BM25F for structured fields plus reciprocal-rank fusion (RRF) for lexical/semantic results**. Do not replace the formulas in production until a judged query set proves a lift and the Rust candidate implements the same contract.

The latest local measurements still show the optimized TypeScript path faster than the Rust process boundary (representative runs: optimized TypeScript about 0.5–0.8 ms p50; Rust stdin/stdout about 20.5–20.9 ms p50). Formula changes therefore target retrieval quality and stability, not an assumed Rust speedup.

## Formula inventory and findings

### 1. BM25 keyword score

`packages/host/knowledge-wiki/src/search.ts:100-125`, the Rust shadow, and the benchmark use Okapi BM25:

```text
S(q,d) = Σ_t IDF(t) · ((tf(t,d) · (k1 + 1)) /
         (tf(t,d) + k1 · (1 - b + b · |d| / avgdl)))
IDF(t) = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
k1 = 1.5, b = 0.75
```

The core formula is a good baseline. The implementation around it has four issues:

1. Title and aliases are concatenated with body text, so field importance and length normalization are coupled.
2. Every matching title/alias query token multiplies the whole score by `1.5`; two matches produce `1.5²`, despite the comment saying “double”. This is an unbounded interaction rather than a calibrated field weight.
3. Repeated query tokens are counted repeatedly, so a duplicated query term receives extra weight without an explicit query-term model.
4. The Rust candidate faithfully reproduces these quirks, which is correct for differential replay but not evidence that they are the best ranking policy.

**Recommended replacement to test:** BM25F. Keep separate fields and normalize each field before combining them:

```text
F(t,d) = Σ_f w_f · tf_f(t,d) /
         (1 - b_f + b_f · |d_f| / avgdl_f)
S_BM25F(q,d) = Σ_t IDF(t) · ((k1 + 1) · F(t,d)) / (k1 + F(t,d))
```

Use body, title, and alias fields with weights learned from the judged set. BM25+ is a smaller alternative when long pages are systematically under-ranked:

```text
S_BM25+(q,d) = S_BM25(q,d) + δ · IDF(t)  for terms with tf(t,d) > 0
```

`δ` must be tuned; it is not a safe universal improvement. The BM25+ paper specifically identifies lower-bounded term-frequency normalization as a problem for very long documents and reports gains especially for verbose queries ([Lv and Zhai, CIKM 2011](https://timan.cs.illinois.edu/czhai/pub/cikm11-bm25.pdf)).

### 2. Hybrid keyword/vector score

`search.ts:181-243` currently embeds only the top 15 BM25 pages and returns only the top `topK` lexical pages. The final score is:

```text
S(d) = 0.7 · BM25(d) / max(BM25) +
       0.3 · cosine(query, d) / max(cosine)
```

This has three correctness problems:

- A semantic hit outside the lexical top 15 can never enter the result.
- Per-query max normalization is unstable and makes scores from different queries incomparable.
- The embedding boundary now rejects empty, missing, mismatched-dimension, and non-finite vectors. The remaining ranking issue is that a negative cosine is clamped to zero and the `max`-normalized blend still cannot introduce a page outside the lexical candidate list.

**Recommended replacement to test:** over-fetch independent lexical and vector lists, then fuse ranks rather than raw scores:

```text
RRF(d) = α / (k + rank_bm25(d)) +
         (1 - α) / (k + rank_vector(d))
```

Start with `k=60`, tune `α` on held-out queries, and keep the source-specific rank positions for explanation. Reciprocal Rank Fusion was designed to avoid incompatible score scales and consistently beat individual rankings in the original evaluation ([Cormack, Clarke, and Büttcher, SIGIR 2009](https://research.google/pubs/reciprocal-rank-fusion-outperforms-condorcet-and-individual-rank-learning-methods/)). If score fusion is required, calibrate each score stream with an independently fitted isotonic or logistic model instead of dividing by a query-local maximum.

Cosine itself is standard:

```text
cos(a,b) = (a · b) / (||a||₂ ||b||₂)
```

Keep it, with the current fixed-dimension, finite-value, and explicit zero-vector checks. Pre-normalized vectors can use a dot product. A persistent vector index or an ANN structure is needed before semantic retrieval can contribute new candidates; HNSW is a possible later choice for a large corpus, not a reason to add Rust now.

### 2.1 Benchmark caveats

The optimized benchmark reuses a prepared TypeScript index while the current implementation rebuilds token frequencies and document frequencies for every query. The Rust measurement starts a new process, reparses JSON, and rebuilds its index for every call. Those are different execution envelopes. The old optimized benchmark used only 12 stop-word entries while production lists 257 entries (244 unique); the benchmark now shares the production `STOP_WORDS` set. Equal digests on the earlier synthetic corpus therefore do not establish full equivalence. The benchmark also has no warmup, uses few iterations, and cannot obtain event-loop delay samples during its synchronous loop.

The benchmark now measures four envelopes separately: TypeScript cold/rebuild, TypeScript warm/cached index, Rust warm persistent child, and Rust cold process. The Rust warm lane reuses the child and pipes but still rebuilds the current Rust index for each request; it is not evidence for a persistent index. The helper records a harness-level crash/restart probe, while cancellation remains explicitly unmeasured in this synchronous harness. Before using a latency number for a migration decision, still report index-build, serialization/IPC, embedding, and search time separately, plus child CPU/RSS and production cancellation/recovery evidence. Expand the differential corpus with stop words, duplicate query terms, title/alias hits, Unicode and non-BMP text, missing terms, long pages, and byte-limit boundaries. Keep the current exact digest contract for the same formula; a new BM25F or RRF formula needs a versioned baseline rather than a relaxed comparison.

### 3. Graph communities and link features

`graph.ts:229-281` uses a simplified Louvain modularity move. The graph builder counts repeated raw edges, then stores every neighbor with weight `1` (`graph.ts:303-321`), so the community formula does not actually use the exposed edge weights. `GraphNode.linkCount` is also inbound-only while the type comment describes inbound plus outbound, and `CommunityInfo.cohesion` is always zero.

These are source-truth drifts before they are algorithm choices. The first fix is to preserve edge weights in the adjacency map and compute weighted degree consistently. Then compute cohesion, for example:

```text
cohesion(C) = 2 · E_inside(C) / (|C| · (|C| - 1))
```

For bridge detection, use the participation coefficient instead of the current community-count threshold:

```text
P(v) = 1 - Σ_C (k_v,C / k_v)²
```

Only consider Leiden after the graph contract is corrected and a quality need is demonstrated. Louvain can produce disconnected communities; Leiden provides connected-community guarantees and can be faster in the published analysis ([Traag, Waltman, and van Eck, 2019](https://arxiv.org/abs/1810.08473)).

### 4. Governance similarity, quality, and utility

Candidate deduplication uses normalized character n-gram Jaccard similarity, with special containment handling and a fixed `0.82` threshold (`governance-policy.ts:268-315`). The quality score is a hand-built integer from 0–10, and promotion confidence is `min(0.98, 0.72 + 0.026 · score)`. That value is a policy score, not a calibrated probability.

Knowledge utility is:

```text
U = (2 · successfulUses - 3 · userCorrections) /
    max(1, retrievalHits)
```

The same retrieval counter is used as the denominator even when an injection opportunity was not actually observed. With one successful use, a record can look strong without a confidence interval.

Keep the hard safety gates, independent evidence, and conflict rejection. If labeled outcomes become available, add token/character similarity as a feature and calibrate promotion confidence with isotonic or logistic calibration. For retention, separate retrieval attempts from injection opportunities and use a conservative lower bound, such as a Beta-Binomial posterior or Wilson lower bound, with a minimum sample count. Do not replace the governance formula from intuition alone.

## Recommended migration order

| Priority | Change | Why | Gate |
| --- | --- | --- | --- |
| P0 | Record semantic candidate hits and define a complete hybrid candidate DTO | Correctness and observability after vector-boundary validation | semantic-candidate and malformed-vector regression tests plus differential replay |
| P1 | BM25F shadow with title/alias/body fields | Removes `1.5^m` and field-length coupling | Recall@K, MRR, nDCG@K, no regression on exact aliases |
| P1 | RRF shadow over independent lexical/vector over-fetch | Avoids unstable score normalization and lexical-only recall | judged queries, per-language and per-query-type slices |
| P1 | Repair graph weights, linkCount, and cohesion | Fixes contract drift before changing community math | graph fixture invariants and deterministic replay |
| P2 | Calibrate governance confidence and utility | Makes promotion/retention decisions statistically interpretable | paired, independently verified outcomes with confidence intervals |
| P3 | Leiden, HNSW, SPLADE, or ColBERT-style late interaction | Higher complexity and model/index dependencies | only after corpus scale or quality evidence justifies it |

The Rust shadow should first implement the agreed BM25F/RRF contract only after TypeScript shadow results are stable. The current Rust process is a BM25-only candidate; enforce mode must remain disabled.

## Required experiment

Build a versioned judged set from real candidate Ark queries: at least 50 queries spanning Chinese, English, aliases, exact identifiers, long explanations, empty/stop-word queries, and cross-language queries. Each query needs independently reviewed relevance labels and a query type. Compare current BM25, BM25F, BM25+, current hybrid, and RRF using Recall@5/10, MRR, nDCG@5/10, empty-result rate, stale/false recall, p50/p95 latency, embedding calls, and memory. Keep a frozen corpus hash and replay all candidates through the same governance filters. A formula may move from shadow to candidate Ark only when it improves the target slices without violating safety or latency gates.

An offline smoke scaffold is available at `scripts/rust-migration/search-formula-experiment.ts` with tests in `search-formula-experiment.spec.ts`. Run `pnpm exec tsx scripts/rust-migration/search-formula-experiment.ts` to replay one frozen, network-free fixture through current BM25, BM25F, BM25+, and RRF and obtain Recall@5, MRR, nDCG@5, and empty-result rate plus the corpus hash. The fixture is only a reproducibility and plumbing check; its perfect Recall@5 does not justify a production formula change. Replace it with the independently reviewed 50-query Ark judged set before comparing quality or promoting a candidate.

## References

- Robertson and Zaragoza, *The Probabilistic Relevance Framework: BM25 and Beyond* ([PDF](https://www.staff.city.ac.uk/~sbrp622/papers/foundations_bm25_review.pdf)).
- Lv and Zhai, *Lower-Bounding Term Frequency Normalization* ([CIKM PDF](https://timan.cs.illinois.edu/czhai/pub/cikm11-bm25.pdf)).
- Cormack, Clarke, and Büttcher, *Reciprocal Rank Fusion* ([Google Research](https://research.google/pubs/reciprocal-rank-fusion-outperforms-condorcet-and-individual-rank-learning-methods/)).
- Traag, Waltman, and van Eck, *From Louvain to Leiden* ([arXiv](https://arxiv.org/abs/1810.08473)).
- Khattab and Zaharia, *ColBERT* ([SIGIR PDF](https://people.eecs.berkeley.edu/~matei/papers/2020/sigir_colbert.pdf)).
