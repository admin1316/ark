# Agent Note: Governed knowledge events and evidence-gated Rust selection

Status: implemented

[English](2026-10-07-knowledge-governance-and-rust-evidence.md) | 中文

## Problem

active Ark 源码已经保存 Wiki candidate、评审、verifier receipt 与 utility 计数，但模型可见的检索和注入仍需要持久 provenance、scope 校验、过期、冲突处理与回放。仓库还需要一个可证据审查的 Rust 决策，不能在没有端到端证据时替换可用的 TypeScript 内核。

## Decision

知识记录显式保存 provenance、trust、authority、evidence、verification、scope、ACL、过期时间、冲突和 utility 字段。hash 链项目日志记录 observation、candidate、verification、rejection、retrieval、injection、conflict、expiry、promotion 和 rollback。candidate 生命周期事件携带完整记录；晋级需要独立验证、评审和独立实测的 trial 证据。模型可见 Wiki 工具追加 `knowledge/retrieved` 和 `knowledge/injected` session 事件，事件包含调用身份、scope、结果 hash 和可回放 JSON 值。未验证、过期、冲突、越界、ACL 拒绝或低置信度记录会 fail closed。

未签名的接纳不能替换已有 identity，也不能赋予 verified trust。验证使用经过认证的完整记录，拒绝被改写的先前接纳。普通模型正文要求 canonical 生命周期；语义验证通过的 candidate 不能在缺少授权 trial 时进入页面召回。经过认证的 candidate 评审元数据继续使用语义 receipt 和实际字节校验，使评审可用而不向普通召回开放正文。Native 预览和 Archive 保留原有规则。历史 canonical 接纳绑定最终 content hash；模型投影在搜索、embedding、图谱派生、列表或页面读取前检查实际文件字节。完整回放中的精确 source 字符串必须只有一个经过认证的 identity，terminal 记录也参与检查。竞争 identity 会拒绝模型投影、Native 搜索与页面读取，以及受治理的 utility 或 outcome 更新；插入顺序和旧展示计数不能选择 owner。Source 字符串保留原有 URI 语义，不做文件系统别名规范化。搜索在异步工作后重新回放当前治理状态，模型搜索在记录检索前重新检查受路径约束的当前字节。这些绑定防止未签名 hash 链或新算出的文件 hash 冒充验证。

语义验证检查不代表成功 trial。Semantic receipt 无法认证实测 trial 收益，canonical 操作的 owner 也未配置实测 trial authority。Promote、Merge、Replace 和 Deduplicate 在修改前拒绝；prepared canonical WAL 恢复同样拒绝，包括标记为 Archive 的 canonical 操作。正向 UI 反馈与声称来自 evaluator 的标签保留为观察，不能增加受治理的 successful-use 计数或维持保留。纠正保留负向 utility 效果。Archive、Skip、advisory resolution 和 rollback 保留现有 authority 与事务要求。

仅在源码中接入的[只读学习校验器](../../../../packages/host/knowledge-wiki/README.zh.md#read-only-learning-evidence)将有预算的 artifact 校验和公开角色验证绑定到现有 authority owner，不接受调用者声称成功的标志。它消费保留的请求和捕获的任务/journal 关系，从每个已登记的签名 use 重建共用归约器的输入。已知失败任务仍保留在分母中；未知结果仍为未知。图关系有效或数值收益不能授予访问权，也不能提交 successful-use 信用。将该 consumer 与激活分开，使实际 evaluator 密钥保管和 provider 观察尚未配置时，canonical 拒绝规则仍然成立。

Canonical 目标预备一次性捕获 candidate 正文、已解析目标路径、精确原始状态或显式不存在、评审时间和 actor。同一纯转换保留已有的各操作时间戳与原始日期戳语义。规范化正文比较用于选择保留内容，不证明字节相同或验证通过。预备不认证这些输入，也不授予 canonical 资格；apply 与 recovery 的拒绝规则保持不变。

Candidate identity 包含路径和内容 hash。字节变化会创建独立的评审 revision；再次观察相同字节不能重开已解决的评审，也不能覆盖已经认证的 identity。

删除回滚只在路径仍不存在时恢复原候选，或接受已经恢复的精确原始状态。其他写入重新创建的不同字节会触发冲突，prepared journal 保留供检查；回滚不能覆盖其他写入者的内容。恢复在修改前验证同一 before/after 关系。

共享文件系统 owner 为评审事务和事件追加提供[文件与目录同步](../../../../packages/host/knowledge-wiki/README.zh.md#governed-page-reads)。POSIX 同步错误始终视为失败，包括发布字节已可见之后的错误；相同状态的重试会重新同步，不能将可见字节当作持久性证明。回滚标记失败会同时保留原始错误和标记错误。已完成的历史 journal 快速分支会重新执行本地同步，不改变原有 authority，也不认证新的结果。旧版 win32 例外只提供可见性。

checkout 包含隔离的 [knowledge-search shadow crate](../../../../rust/knowledge-search-shadow/README.zh.md) 与默认关闭的 TypeScript child boundary。搜索 authority、图谱派生、session 持久化和 subprocess 管理继续由 TypeScript 或已有 native owner 负责；没有 receipt 授权 Rust enforce。Rust candidate matrix 要求三组对照、差分回放、取消、恢复、打包和平台证据通过后才允许 enforce。[源码清点](../process/2026-10-08-function-language-census.zh.md) 区分声明覆盖与功能、性能验证。

学习结论使用相同 model、配置、task、goal 和 policy hash 的 baseline/candidate 配对结果。缺少机会或独立验证时返回 `UNKNOWN`；知识条数、模型调用次数或 Rust 行数不能证明改进。CLI 与只读 graph consumer 共用一个[评估归约器](../../../../scripts/rust-migration/README.zh.md)，使用精确整数交叉乘积比较汇总计数的比例，即使显示的浮点比例相同，也能保留真实大小关系。数值改善不能证明统计显著性，也不能认证输入证据。

[Phase 6 审计 CLI](../../../../scripts/rust-migration/README.zh.md)将显式选择、有大小限制的公钥映射传给现有审计 owner。信任选择属于调用方；仓库证据不能选择自己的 authority。缺少配置时保持 `UNKNOWN`，显式配置畸形时在归约前失败。这接通了 receipt 认证，不改变检查项，也不配置评估者的密钥保管关系。真实 CLI 子进程测试使用临时签名 fixture，覆盖公钥拒绝与绑定变化；它们不证明运行时验收。

## Alternatives considered

- **不记录 Wiki recall：** 拒绝，因为模型可见输入必须能由 session event log 重建。
- **根据 utility 或模型输出自动晋级：** 拒绝，因为低 trust 和未验证内容不能改变运行时策略或 canonical knowledge。
- **把验证检查当作成功使用：** 拒绝，因为检查 candidate 不等于测量它对后续任务的效果。
- **优先迁移 Rust：** 拒绝，因为 shadow crate 和相同结果 digest 不证明端到端收益，且现有 TypeScript/native owner 已提供取消和恢复。
- **合并成一个总分：** 拒绝，因为每项 rate 与零泄漏要求必须独立检查。

外部语义检查 adapter 把进程创建与销毁交给已挂载的 subprocess owner。取消、截止时间、输出超限及 leader 完成，都要在整棵进程树终止并静止后才结算，并保留最先发生的失败原因。adapter 保持显式 child 环境允许列表和有界诊断前缀。它不再单独启动不等待结果的 kill timer，尚未结束的检查也参与产品 service 销毁；原有语义请求和结果签名前像不变。缺少进程 service 时拒绝已配置的执行，不创建失管 child。

## Consequences

Wiki 事件日志可审计、可回放。prepared canonical journal 会阻止初始化或项目切换并保留证据，不会在缺少实测 trial authority 时继续提交。Archive 恢复认证操作身份并只记录一次终态 rejection；单独的 committed 标记不能认证文件状态已提交。历史接纳 fixture 用于检查读取边界，不会启用当前晋级。新增 session event 不改变 session format version。没有 calling session 的工具调用仍可服务非 Agent caller，但模型可见的 Agent 调用不能绕过 session event 记录。Rust enforce 保持 deferred，直到具体候选登记 corpus、边界和三组证据。

无需密钥的 headless 场景通过普通 runtime 子进程运行完整 Wiki 工具组合与冷 session 回放。源码 service 通过 tsconfig paths 解析，构建后的 service 通过 package exports 解析。源码拥有的 Archive、seed 和 verifier fixture producer 与这些 service 分开。稳定 transcript 捕获与受认证的可变 Wiki 状态断言分开；fixture seal 不授权当前 canonical 晋级。`examples` 作为已声明的 workspace，使构建后的依赖通过普通安装解析，不使用临时 resolver link。

Source 归属回归覆盖真实 Loader 工具、完整 Wiki 文件状态不变、冷 session 回放，以及异步搜索期间的纠正。它们不覆盖文件系统别名、外部并发写入、Native 原始 graph/list 投影，或撤回已经发送给 provider 的内容。冻结输入预备测试建立精确字节的确定性，不启用 canonical 操作。

测试 authority 只验证确定性的认证与拒绝行为。独立评估者密钥分离、原生配置、实际 trial 收益与真实 provider 的配对学习证据仍未验证；验证结果通过和 UI 反馈不能证明修复规则被正确复用。

真实 Archive 子进程与 YAML Loader 回归在删除后重新创建候选并中断事务，验证被拒绝的回滚和后续恢复保留这些字节及 prepared journal，不产生完成事件。完整 headless transcript 记录作用域内的空 review 结果和被拒绝的页面读取；冷 CLI 进程带着实际的 divergent-state 错误退出。这些检查覆盖进程中断，不证明 rename 或 unlink 在断电时的持久性。
