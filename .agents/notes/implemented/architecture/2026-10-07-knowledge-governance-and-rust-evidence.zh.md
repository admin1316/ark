# Agent Note: Governed knowledge events and evidence-gated Rust selection

Status: implemented

[English](2026-10-07-knowledge-governance-and-rust-evidence.md) | 中文

## Problem

active Ark 源码已经保存 Wiki candidate、评审、verifier receipt 与 utility 计数，但模型可见的检索和注入仍需要持久 provenance、scope 校验、过期、冲突处理与回放。仓库还需要一个可证据审查的 Rust 决策，不能在没有端到端证据时替换可用的 TypeScript 内核。

## Decision

知识记录显式保存 provenance、trust、authority、evidence、verification、scope、ACL、过期时间、冲突和 utility 字段。hash 链项目日志记录 observation、candidate、verification、rejection、retrieval、injection、conflict、expiry、promotion 和 rollback。candidate 生命周期事件携带完整记录；晋级需要现有独立 verifier 与评审事务。模型可见 Wiki 工具追加 `knowledge/retrieved` 和 `knowledge/injected` session 事件，事件包含调用身份、scope、结果 hash 和可回放 JSON 值。未验证、过期、冲突、越界、ACL 拒绝或低置信度记录会 fail closed。

已验证记录达到三次检索且 utility 没有正向提升后，会在下一次模型可见查询前写入过期事件并停止注入。

启用 `ownedStageExecutor` 时，阶段超时或 owner 取消会中止阶段，并等待该阶段 signal 已登记的全部真实进程内 Worker 终止 join。`Promise.allSettled` 会等所有 join 都结束后再传播任一 join 错误；未结束的 join 会让操作继续等待。这只证明已登记 Worker 的静止状态。pre-worker 连接解析和不透明 provider 的终止仍未证明，但解析返回后的 signal 检查会阻止迟到的 Worker 启动。

完整 utility JSON 投影会先按 UTF-8 字节数与现有 5 MiB 消费上限比较，再写入对应生命周期事件。修复流程先只在内存中回放过期状态并生成最终投影；只有投影符合上限后，owner 才持久化过期事件并重新校验经过认证的当前来源。随后按 `knowledge/rejected`、修正后的 `knowledge/injected` 顺序追加事件，再认证回放日志并检查来源身份、rejected/downgraded 状态及四项 utility 计数，之后才写 utility 文件或发布 Candidate 与 Review。首次追加失败不能保证撤销已经发生，并会停止后续写入。修正反馈追加失败时，已持久化的拒绝事件仍生效且来源会被拒绝，utility、Candidate 和 Review 均不写入。外部丢失或损坏日志不在此保证范围内。此顺序不会使事件批次或相关文件成为原子事务。

`.llm-wiki/review.json` owner 让读取方和写入方共用 8 MiB 上限，并按完整格式化 JSON 数组的 UTF-8 字节计数，包括 JSON 转义和末尾换行。Ingest、research、session-summary、correction-repair 和带说明的图片发布方，会在首次发布 Candidate、治理或 Review 状态前，对所有可能成功的部分结果和同路径内容版本完成序列化检查；提交时复查完整 Review 原始字节、受限 Candidate 路径与字节、来源身份和当前治理决定。来源是项目内常规文件时，owner 绑定当前文件字节；外部、虚拟或当前不存在的来源路径只按路径字符串绑定，未提供来源时使用固定的 `unknown-source` 标记。research 使用的 `research:${topic}` 只绑定请求标识，不验证抓取到的事实。来源、媒体或其他原始输入前置写入可能已发生，后续文件或日志失败也可能留下部分发布结果。该计划保留历史重复 id，并像现有消费者一样只更新首条匹配项。它不是跨进程锁或多文件事务。Wiki 页面与 utility 投影仍限制为 5 MiB，晋级 WAL 仍为 8 MiB；带说明的图片来源仍限制为 16 MiB，并在说明生成后和 Review 预检后再次比较来源字节。

验证写入方会在发布 Review 与治理投影前等待完整生命周期事件的认证。它将 Review 原始字节与解析行一起捕获，复用 Candidate 快照生成签名记录，重新验证回执身份与证明，并在 authority 回调后复查当前回执、Candidate、Review、源码及构建身份和事件日志字节。签名期间取消或切换项目会拒绝发布。拒绝或无效签名不会发布投影。这项发布检查保留既有事件格式，不是多文件事务或跨进程锁；之后的投影 I/O 失败仍会抛错，并可能留下部分审计状态，模型访问仍需要经过认证的生命周期事件。测试 authority 的拒绝、延迟签名期间的状态变化、有效回放和真实 Loader 工具调用约束这些行为，不证明生产密钥已有受保护的所有权。

`knowledge-wiki/src/measured-trial.ts` reader 会校验带签名且内容寻址的 proposal、授权、预注册、配对使用与 trial artifact。当前源码通过可选的 launcher-owned `knowledgeWikiMeasuredTrialReader`、新增的 `recordCandidateMeasuredTrial` RPC、review 提交与崩溃恢复接入该 reader；提交只会应用试验回执认证过的精确目标字节。Jiuzhang 现在映射一个精确的 launcher-only JSON 配置，其中包含相互独立的 Ed25519 SPKI 公钥和有界的内容寻址文件库；活动环境仍未提供受信 authority 值或配对证据，因此这些输入配置到位并经过独立复核前，生产规范操作继续失败关闭。

语义验证 owner 会在重建准确的 canonical 动作请求时拒绝缺少 Candidate 或目标字段的输入。实测绑定从与回执匹配的受信请求派生必填字段，不重复检查私有解析评审中的可选字段。事务 owner 会在登记、授权与恢复的 reader 调用前冻结平面的预期绑定值，reader 不能改写它需要满足的条件。Promote 只派生一次经过确认的目标不存在状态；可变的目标存在性与字节、回执有效性、试用资格、Candidate 字节和归档冲突仍在各自的读取与提交位置独立复核。

签名认证通过后仍须校验回执字段。文件哈希与 proposal 绑定由各自的解析器负责；非空且唯一的预注册与精确的 baseline/candidate 顺序保证完整配对。评审提交和崩溃恢复会在写入前独立复核可变的目标状态。事务 owner 会在签名后、日志持久化前重查当前试用资格；成功的 Canonical 恢复使用该校验已要求存在的 trial，Archive 仍是独立动作，仅有经过认证的语义回执的旧日志仍会回滚。校验成功的最终返回与 Canonical 事件投影不再重复提供缺少 trial 的兜底。拒绝错误签名的测试必须真正走到签名方，不能因先前缺少 trial 的拒绝而通过。

evaluator 签名认证使用回执与引用的 artifact hash。每个使用回执的既有证据引用首项指向独立日志负责人凭据；配置的 journal 公钥认证其版本化事实绑定与非空日志字节快照。事实 hash 排除评估者持有的结果及签名和稍后加入的证据引用，使签名没有循环文件依赖。相互独立的身份与密钥保留生产者和评估者边界。这会认证签名者的绑定；完整一致的真实会话采集、独立核对的任务结果、受保护的签名所有权和知识正确复用，仍分别需要证据。

仅由 launcher 提供的 `knowledgeVerifierConfig` 包含验证 authority id、可执行文件、Ed25519 公钥、源码身份以及可选参数和时限；不接受 `privateKey`。配置非空时，Wiki 从 Context 获取 `knowledgeWikiVerifierAuthority`，要求其 authority id 匹配并提供类型化 `sealPromotion` 方法。外部验证器 authority 在创建时固定经过校验的命令、源码身份和时限，复制参数数组，并保留解析后的公钥、绑定的 signer 方法和共享受管子进程 owner，而不保留调用方可变的配置对象。验证结果与委派签名都必须通过配置公钥核验；不同但有效的公钥可以通过创建检查，但首次签名不匹配时会被拒绝。配置的时限只约束验证器子进程。项目 generation 控制器会在切换工作区、删除当前工作区或 dispose 时取消等待中的验证与晋级签名；语义验证会合并调用方与该 generation 的信号。adapter 将信号传给类型化签名 owner，不增加签名时限。晋级事件、WAL 和恢复等待仍保留 generation 与当前状态检查。配合取消的 owner 会停止并等待其进程树退出后再结束调用；不响应信号的 owner 仍可能一直等待，Wiki 的同步 dispose 本身不等待这些调用。签名只接受经过 schema 校验的验证事件、晋级事件或晋级 WAL 操作，并编码其既有规范字节；任意字符串及不匹配的操作或 authority 身份均被拒绝。知识记录的语义校验复用治理 validator。该 owner 在执行现有 `Date.parse` 检查前，要求 `lastVerifiedAt` 与 `expiresAt` 为 `null` 或 JavaScript 字符串；现有可解析日期字符串格式保持不变。`claimKey` 可以缺省，若提供则必须是 JavaScript 字符串。这样可以阻止日期数组被隐式转成字符串，并使严格的 claim-key 比较符合其声明类型。编码器对 trust 与 WAL role 的允许值匹配前同样先要求 JavaScript 字符串，不做强制转换。晋级和经过授权的恢复会在日志操作前取得事件签名，签名后比较当前绑定状态，提交后不再异步请求 signer。类型化委派不能隔离生产密钥，也不能证明 OS 密钥托管受到保护。重新赋值 launcher 配置或修改其参数数组，不能改变验证命令或回执与晋级身份。真实受管进程回归验证命令、参数、时限和身份的稳定性；签名 fixture 证明配置绑定，不证明知识已经过独立验证并被正确复用。

晋级事务按签名 WAL 的顺序应用文件操作、同步父目录并核对完整 after-state，再追加生命周期事件；事件文件与父目录同步后，才写入 `committed` 标记。事件查找先使用类型、candidate knowledge id 和 candidate hash 定位候选项，再拒绝重复项并比较 scope 与完整语义 payload；对晋级事件，比较时只排除 authority 专属 seal proof。仅匹配这三个定位字段不能作为去重规则。恢复会幂等地应用 `prepared` WAL，并确保生命周期事件后再提交。对于已经 `committed` 且存在完整匹配事件的日志，恢复会同步该事件后跳过旧文件 after-state 检查，保留之后合法发生的文件变化。若事件缺失，恢复会重新认证日志并验证每个操作当前都处于签名 after-state，然后只追加缺失事件，不重放或回滚已完成的文件。Archive 与 Skip 的拒绝事件 payload 来自签名治理追加项，且 `appliedPath` 必须匹配实际 candidate-archive 操作。事件冲突、authority 无效或字节分歧都会失败关闭。I/O 错误可能留下仍为 `prepared` 的日志及已可见的操作或事件字节；rename 后报错也可能留下可见的 `committed` 标记，不能保证每次失败都会回滚。这些事务检查不能证明异步 signer 已完成安全退出、OS 密钥保管受保护或真实配对使用效用成立。

首次持久化事务写入前，写入方会将所有格式化 WAL 标记形态按 UTF-8 字节限制在恢复读取方既有的 8 MiB 上限内。检查包含每项操作的 `before`/`after` 字符串、重复保存的 Candidate 与归档正文、累计的 Review 与治理快照、seal、元数据和 JSON 转义；单个文件没有超过自身读取上限，并不保证包含它的 WAL 可提交。该限制保护恢复容量，不新增大输入支持；此前已写出的超限 WAL 仍会被恢复入口拒绝读取。

知识事件读取方和追加方共用完整日志 64 MiB UTF-8 字节上限。追加 owner 会先按现有文件字节数与精确序列化后的 JSONL 行检查，再验证路径和打开的 inode 后复查；越界时拒绝追加。写入方不会截断、压缩或轮换已有超限日志，读取方仍会拒读。调用方必须串行追加同一路径：owner 没有跨进程锁；调用方逐条追加一批事件时，较早的合法行可能已可见，之后的行才因超限被拒绝。这一固定容量不支持无限历史，也不提供多事件原子事务。

修正 RPC 在不可信输入边界校验项目、工作区和会话字段的类型，再解析路径或读取会话。输入 owner 会规范化捕获的规则，在读取会话前拒绝空值；私有授权函数消费已经校验的值，Candidate 发布保留去除首尾空白后的原文。现有写入方会在校验前将平面提案字段与完整访问范围捕获为本次操作持有的冻结对象；调用方修改原对象时，异步查询仍授权并记录同一份规则和会话。公共入口与真实 Loader 回归核对原会话来源、原始 Candidate 正文、来源未变以及 Candidate 不能被模型读取。被拒绝的输入不会修改来源或 Candidate 状态。治理回放对解析后的当前或备用记录只作一次缺失判断；日志追加、评审提交和恢复仍分别校验可变状态。

修正授权扫描把匹配的工具调用绑定到日志中最新的轮次头，因此此前的人类规则不能授权后续轮次，包括轮次数字被复用或最新轮次头损坏的情形。最新直接人类消息的正文无法读取时会拒绝授权，不能借用此前的规则；真实 session-query provider 已在整段日志回放时拒绝格式损坏的正文。写入方在异步读取会话后重新校验注册、路径边界、当前准入、身份和内容。真实 Loader 组装使用会话存储和 session-query provider，核对损坏日志、旧轮次和并发文件修改被拒绝时，生命周期日志与不存在的 Candidate 保持原状；当前轮的原文规则仍能暂存不可信 Candidate 并阻止旧来源。源码回归还覆盖并发撤销、签名替换、删除和工作区移除。签名测试 authority fixture 只代表先前经过认证的状态，不计入正向学习证据。

完整来源读取会清除过期的进程内能力、刷新绑定会话的条目，并在固定 256 项上限时淘汰最早条目。正数容量与私有同步 Map 保证淘汰时存在首个键，因此 owner 直接删除该键。公共入口回归确认过期与被淘汰的会话不会写入、刷新后的会话保留权限，并在返回缓存搜索结果前只记录一次到期事件。这些检查证明授权边界有界，不证明内存或速度提升。

组装后的 ACP 修复快照在 live 和 replay patch 中都插入真实 Wiki 服务，并使用 launcher 的 home-path helper。没有完整读取已验证来源时会拒绝修正，独立的工作区结果预期保持为空。该 authored 回放验证组件组装和拒绝边界，不证明模型学习、正向验证或跨对话复用。日志交错测试在完整读取后制造符号链接、硬链接、目录替换和检查拒绝，确认拒绝追加并保留原始字节。

没有签名的准入事件不能把记录标记为已验证或 canonical。经过认证的验证事件提供完整且身份匹配的记录，负责来源信息，并在实测晋级前保留 Candidate 生命周期。模型内容入口把当前页面字节绑定到最新签名晋级的 hash；最终页面读取和修复来源读取会在返回内容或授权修正前再做比较。通过 Loader 组装的 Wiki 工具会拒绝自行认证的记录且不注入它；在内容检查与最终读取之间替换真实文件时，读取被拒绝且不记录检索。这些回归验证信任边界，不证明正向学习或实时候选验收通过。

检出的源码包含默认关闭的隔离 Rust 搜索 shadow。准备好的索引保留文档 token 总数、词频和标题词成员集合，消费 token 数组并用词频表中唯一的键推导文档频率，不改变排名。现有 serde 格式化器使用 [Ryū-js](https://github.com/boa-dev/ryu-js)，为结果和摘要提供符合 ECMAScript 的分数字节。父进程校验复用 TypeScript 分词器，在启动子进程前检查子进程既有的 UTF-8 和 token 上限；摘要比较仍要求完全一致。活动 runtime 中的知识搜索、图推导、会话持久化和子进程监督仍使用 TypeScript 或已有 native C。Rust 候选矩阵要求在 enforce 模式前提供当前 TypeScript、优化后 TypeScript 和真实 N-API 或 IPC Rust 的对照，以及差分回放、取消、恢复、打包和平台证据。

数字写法兼容与分数相等是不同的门槛。真实进程回放还发现平台 `ln` 与 Node `Math.log` 的舍入差异；隔离实验中的现有 `libm` 库没有复现 Node 的位模式，因此没有采用。完整分数和摘要比较继续严格执行，候选保持关闭，平台和语料匹配仍是未通过的门槛。

学习结论使用相同 model、配置、task、goal 和 policy hash 的 baseline/candidate 配对结果。缺少机会或独立验证时返回 `UNKNOWN`；知识条数、模型调用次数或 Rust 行数不能证明改进。

默认关闭的[固定项目试点](../../../../scripts/rust-migration/README.zh.md#fixed-knowledge-pilot-reference)匹配已审规则字节，独立检查分页、精确发票算术和整轮单行输出。严格清单绑定请求、源码快照与受保护测试；任意命令或适用范围更广的自然语言规则不能获得通过结果。实际使用采集复用核心会话投影、流组装与持久化解码，不改动原始日志。Shell 退出标记即使包在非错误工具结果中仍计为失败，重复调用不能证明重试。独立费用或重试归属缺失时，实测使用凭据保持不可签发。测试密钥签名和历史回放只证明这些机制；受保护 authority 的所有权、实际配对收益和真实候选验收仍是独立要求。

固定使用 producer 与无密钥 evaluator 复用既有采集、任务 oracle 和 v1 reader owner。每个已登记失败都会保留，整轮费用覆盖全部派发 attempt，而不是选中的注入后请求。evaluator 只接收不可变引用并重新推导事实与计数；它向受保护 owner 输出未签名规范字节，不接收密钥或调用方指标。缺少机会时保持 0/0，不能支持晋级。独立的合法 v1 fixture 控制区分 reader 接线与真实学习证据。完整快照评审摘要默认不授予实时派发权限；独立已签名私有准入将明确有限额度绑定到同一 source、trial、已登记 session 和既有 schema-2 账本摘要。容量校验复用 guard owner，不重置预算。原始 rendered 工件使注入字节经过 launcher 规范序列化仍保持精确。既有 Wiki schema-2 验证唯一匹配固定 promotion manifest。私有 recipe 绑定跨 Swift/JavaScript 数值格式的精确传入 wire 字节摘要；既有规范签名 payload 保持不变。实际父进程退出会取消 evaluator；guard owner 丢失会关闭通道、监听器和拥有的进程。完整 Native owner probe 组合真实 CLI 准入和持久化采集，但 guard 事实明确为合成 fixture，因此仍与真实 HTTP 或 provider 执行分开。独立费用 guard 保持 schema-2 预算语义；私有 adapter/guard 登记仅含元数据，受保护 peer 身份仍是部署要求。

既有原生打包 owner 将 evaluator、固定 verifier 和 guard launcher 输出为保留相邻模块身份的未捆绑 ESM。运行时计划对递归发现的源码输入计算摘要，构建计划必须包含完整且精确的编译 helper 清单；只有 source-only 计划可省略这些生成文件。签名任务证据记录实际执行的 verifier/oracle 字节，包括编译后的 `.mjs` 字节。源码 fixture 与编译后执行分开，编译 owner 缺失时不能回退到 TypeScript。

原生 evaluator 与 guard 要求调用方独立提供 Node、入口、配置、安装清单和打包回执的固定摘要。共享验证器在受管执行边界检查既有清单／回执关系、全部包和资源摘要、解析器目标及目录清单，拒绝额外作用域、影子模块和 worker；源码 TSX 参数也会拒绝。重复校验能发现持续存在的改动，但不提供原子执行，也不能证明安装不可变、同一用户瞬时替换不可行或密钥已受保护托管。SHA-256 十六进制编码复用既有摘要 owner，不改变签名字节或跳过检查。完整清单读取会增加可测延迟，启用前必须评估。冻结测试包只证明该包字节，不能代表后续源码修改或已安装候选。

私有就绪桥从固定摘要的 evaluator 配置、已登记 descriptor 和实际 Native signer 公钥推导既有 Node hello。日志与评估密钥保持不同；promotion 可复用既有 evaluator 身份。XPC 只在代码要求及 nonce/version 握手后返回有界公开元数据。broker 每个 generation 共用一个受管 bootstrap，拒绝错误元数据并等待取消的启动工作结束。socket 将异步 hello 纳入既有任务槽，完成前拒绝业务。service 在 shutdown 使用的同一锁内检查就绪并登记任务，避免迟到任务逃过 join。生产 service 仍不配置 authority。临时 Native 密钥、合成 evaluator recipe 和真实 Node/XPC 源码传输检查只证明此接线，不能证明部署托管或学习收益。

预观察准入将不可变任务条件与未来结果分开。已就绪 guard 在 Native 意图登记前提供实际端口；实时派发仍须经过签名准入。App broker 拥有 backend／guard 的退出等待凭据，只通过经过认证的 App 控制提供捕获／冻结。每个已登记 slot 在下一 slot 恢复初始代码前，保存实际修改的任务文件和原始物理日志。Native state-v2 使用既有 owner 锁与单独文件；只有其有序 CAS 提交才能使准备好的捕获成为权威。失败、不完整与未运行的观察继续可审计，不会从试用中丢弃。

最终冻结复用 Native 费用事实和既有完整 evaluator 配置，再将单独的离线启动信息绑定到同一 generation 与有序投影。新的精确 PID／通道只运行一次既有 producer，并消费原 v1 reader；产品启动不会自动生成试用。真实代码修改与测试运行仍是任务证据。公开就绪信息、合成会话 fixture 与临时签名不能证明受保护部署或配对效用。[固定试点参考](../../../../scripts/rust-migration/README.zh.md#fixed-knowledge-pilot-reference)负责执行与失败契约。

## Alternatives considered

固定试点的签名判据产物明确绑定规范清单、版本化任务契约、冻结输入与整轮输出，以及运行时和判据／验证器源码身份。分页在既有准确只读 Seatbelt 规则中增加内核拒网，未知平台或 runner 规则改变时拒绝；不放宽或扩大通用 sandbox。真实回环连接与文件拒绝测试补充正常计算测试。重试次数来自完整、签名且绑定快照的调用／结果分类，父调用须为更早失败的同工具／同参数调用，禁止重复消费，测试重试与日志密钥不同。改变参数后的调整和证据缺失均不在该定义内。测试签名只认证这些绑定，不能证明生产所有权独立或真实学习效用；费用与可信密钥保管仍须单独证明。

- **不记录 Wiki recall：** 拒绝，因为模型可见输入必须能由 session event log 重建。
- **根据 utility 或模型输出自动晋级：** 拒绝，因为低 trust 和未验证内容不能改变运行时策略或 canonical knowledge。
- **优先迁移 Rust：** 拒绝，因为 Rust 尚未实现完整的生产搜索契约，且现有 TypeScript/native owner 已提供取消和恢复。
- **放宽摘要比较或手写数字格式化器：** 拒绝，因为数值相等不能认证结果字节；已有维护者的 ECMAScript 格式化器提供所需的边界行为，不另写十进制转换算法。
- **合并成一个总分：** 拒绝，因为每项 rate 与零泄漏要求必须独立检查。

## Consequences

Wiki 事件日志可审计、可回放，canonical 文件继续由现有评审与 verifier WAL 保护。新增 session event 不改变 session format version。没有 calling session 的工具调用仍可服务非 Agent caller，但模型可见的 Agent 调用不能绕过 session event 记录。Rust enforce 保持 deferred，直到具体候选登记 corpus、边界和三组证据。
