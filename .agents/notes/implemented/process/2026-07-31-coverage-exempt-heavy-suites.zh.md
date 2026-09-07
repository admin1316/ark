# Agent Note: 覆盖率豁免重型套件

Status: implemented

[English](2026-07-31-coverage-exempt-heavy-suites.md) | 中文

## Problem

CI 覆盖率 lane（`check:ci:coverage`）的墙钟被少数几个重型测试文件钉死：本地 6-worker 全量剖析中，555 个测试文件聚合 1595 秒，其中 `packages/typert/generator/tests/type-model.spec.ts` 一个文件占 885 秒，前 10 个文件占聚合时长的 84%。这类套件的共同点是每个用例都做全工作区编译器分析或真实子进程 fixture（测试前置数据），v8 插桩把这类代码的运行时间放大数倍。

关键的浪费在于：针对 `scripts/` 的子进程 fixture 缴纳的插桩税对 per-file 100% 阈值**没有任何贡献**，因为 `coverage.include` 只包含 package 源码。只要 package 套件会执行分母中的源码，就必须保留在插桩门禁中。

## Decision

`ci-coverage` 聚合拆成两个并行 gate，全部测试仍然执行，只有重型套件不再交插桩税：

- **插桩 gate**（`test:coverage`）：设 `DSH_COVERAGE_EXEMPT_HEAVY=1`，`vitest.config.ts` 据此从两个 project 的 exclude 中剔除豁免套件，其余全部文件照旧插桩并承担全部阈值证明。经 gate 自带 env 注入（既有 `Gate.env` 机制），不进 workflow 全局环境，因此并排的无插桩 gate 和本地直跑 `vitest run` 都看不到该变量、行为不变。
- **无插桩 gate**（`test:coverage-exempt-heavy`）：用配对的 positional filter 恰好运行豁免套件，保证正确性信号不缩水。

Linux 覆盖率 CI 与原生 Windows CI 在插桩门禁内部使用 [job 内分区覆盖率](2026-08-18-in-job-partitioned-coverage.zh.md)。其合并报告承担相同的阈值证明；豁免门禁及其成员资格规则保持不变。

`scripts/coverage-exempt.ts` 是唯一名单点，集中持有成员资格约定与 filter/exclude 配对，防止两侧漂移。

### 豁免名单与逐项对账

一个套件对覆盖率有贡献，当且仅当它在进程内执行了被度量的文件（`coverage.include` = 包 src 树）。现行名单逐项核对：

| 豁免套件 | 进程内执行的被度量代码 | 覆盖由谁接住 |
| --- | --- | --- |
| `scripts/install-lefthook.spec.ts`、`scripts/oxlint-contract.spec.ts`、`scripts/change-scope.spec.ts`、`scripts/translation-pairing-merge.spec.ts` | 无——被测对象是 `scripts/` 源码（从不在 coverage.include），执行方式是 spawn 子进程 | 无需接 |

Typert generator 源码属于覆盖率分母，因此全部 generator 测试都在插桩门禁运行。不能仅因其他套件当前也覆盖同一批行，就把某个 package 测试加入豁免名单。

### 成员资格约定

新增豁免必须同时满足：套件进程内不执行任何被度量的 package 源码；filter 与 exclude 选中完全相同的文件集。约定文本随名单同文件维护。

### 门禁自动守卫名单正确性

per-file 100% 阈值本身就是豁免名单的守卫，名单错误无法静默通过：

- 若未来某个豁免套件实际独家覆盖着某个被度量文件，插桩 gate 当场红（该文件跌破 100%）；
- 反向同理：出现「只有豁免套件才覆盖」的新代码，同样立刻红。

因此覆盖率结果的不变性不依赖人工维护名单，符合「misconfiguration fails loud」约定。唯一失去的是豁免套件自身的执行不再产出覆盖数据——由上表可知这些数据全部冗余，最终报告在阈值意义上逐文件相同。

## Alternatives considered

- **CLI `--exclude` 从插桩 gate 剔除豁免套件。** 实证无效：vitest 4 的 `cliExclude` 不参与 per-project include 解析，多 project 配置下豁免套件仍被选中，故改走 env + config。
- **降低 worker 数或提高 gate 并发。** 事故期间实测无效：lane 墙钟被尾部最长文件钉死（聚合/墙钟 ≈ 4× 有效并行），并发旋钮两个方向都动不了尾巴。
- **跨 runner 分片（`--shard` + blob 合并）。** 不予采用，因为 matrix、产物流水线和合并 job 会引入第二套工作流拓扑。所选的 [job 内分区](2026-08-18-in-job-partitioned-coverage.zh.md)只把 Vitest shard 用作既有 job 内的本地单 worker 进程。
- **直接删除或跳过脚本 fixture。** 拒绝：无插桩并排执行可以保住完整正确性信号，也不会假装它们贡献了 package 源码覆盖率。

## Verification

若错误豁免了仍在分母中的 package 套件，插桩门禁会立即失败。`vitest list` 验证 env 开关两态恰好增删当前仅含脚本的豁免集；`run-gates.spec.ts` 覆盖聚合图构造。

## Consequences

- 豁免套件在执行时不会向阈值门禁叠加插桩开销；分区墙钟数据由 [job 内分区决策](2026-08-18-in-job-partitioned-coverage.zh.md)负责记录。
- `DSH_GATE_CONCURRENCY` 在本 lane 重新拥有两个可调度对象，聚合调度器不再是直通。
- 向名单新增重型脚本套件必须完成上述成员资格对账；package 测试套件保持插桩。
- 豁免套件不再出现在覆盖率报告的贡献文件列表中；其正确性信号完全由无插桩 gate 的红绿承载。
