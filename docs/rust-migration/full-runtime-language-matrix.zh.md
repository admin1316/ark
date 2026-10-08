# ARK 功能级 TypeScript/Rust 核对

[English](full-runtime-language-matrix.md) | 中文

## 范围与状态

本参考区分源码覆盖、架构职责、运行验证和语言收益实测。[源码清单](../../scripts/rust-migration/function-language-inventory.json) 绑定 Git 快照、代码摘要、manifest hash、profile/preset hash 和声明位置。它覆盖 50 组、212 个 harness 包，以及声明 workspace 范围内的 vendor、应用/启动器、Swift、Python、C 和 Rust 源码。测试、工具和生成文件仍逐项列出，但不计入运行实现分析。

**声明范围的源码清点已完成；逐功能语义审查只完成一部分，全产品运行和性能验证仍为 UNKNOWN。** 函数或方法声明不等于用户功能；统计包含内部函数和重载。Swift/C/Python/Rust 文件已经列出，但 TS 扫描器没有逐个解析这些语言的函数或界面控件。动态 MCP schema、用户插件/预设、settings 和环境条件下的实际组合仍需要运行证据。

现有工具 catalog 提供 74 条 schema 记录、59 个不同名称；源码的 literal 注册点补入 7 个 Wiki 工具名，共静态识别 66 个不同工具名。清单还记录了 102 个 Remote 装饰器声明点、5 个命令注册点和 83 个 Context 属性声明。这些数量不证明功能已经加载或调用。未执行环境表达式的 Jiuzhang patch 组合和 3 份 Native preset 源文件单独记录。

## 决策含义

`KEEP_TS_AUTHORITY` 表示保留当前权限、事件、回调或生命周期 owner，不代表已经证明 TS 更快，也不排除内部纯计算内核。`KEEP_EXISTING_NATIVE` 表示保留现有系统/库实现。内核标记为 `UNMEASURED` 只允许继续研究，不允许据此迁移。`KEEP_CURRENT_PENDING_REVIEW` 明确表示核对尚未完成，不会把它计为 TS 获胜。剩余声明全部保留在清单中供后续核对；未审查条目不计为已验证。

## 已核对的函数边界

[函数核对记录](../../scripts/rust-migration/function-language-inventory.json) 保存源码选择条件、匹配后的声明行号、决策和原因；重新生成时若选择条件失效会报错。下表概括职责边界，不重复包 catalog。

| 函数或职责 | 当前 owner | 初步判断与所缺证据 |
| --- | --- | --- |
| 工具/Remote/命令分发与注册 | TS | 权威边界保留 TS。内部不可变计算另行测量；不得把 Context、凭据、回调或外部副作用移交 Rust。 |
| 搜索分词、BM25 与评分 | TS，默认关闭的 Rust shadow | 保留 TS。已有 fixture 中缓存 TS 更快；这是组合搜索测试，不是逐函数或全 Ark 测速。 |
| cosine 与 Wiki 图派生 | TS | 纯计算研究项，未测速。embedding/网络和知识治理过滤仍由 TS 负责；比较其他算法前先明确图应使用加权还是无权语义。 |
| `scanZstdFrames` | TS | 只读字节内核研究项，未测速。保留范围、帧数限制、损坏帧错误和残缺尾帧结果；writer 与修复保持原 owner。 |
| Zstd 压缩/解压 | TS 调用 Node native | 保留现有 native。提出替代实现前先测完整 scanner/decoder 边界。 |
| token 估算 helper | TS | 纯计算研究项，未测速。保留 UTF-16 长度、block 递归和 framing 常量；公式改变与语言提速分开评估。 |
| TokenMeter 会话 fold 与重建 | TS | 保留 replay owner：会话状态、provider 计价、seq 检查和来源事件重建应由同一个 owner 管理。 |
| SessionProjectionRegistry | TS | 保留 TS。同步 JS fold、相同对象引用语义和一致性切点不允许直接换成异步 IPC。 |
| 编辑器匹配偏移与行号扫描 | TS | 纯计算研究项，未测速。保留 UTF-16 偏移和匹配规则；授权与写文件仍由 filesystem/tool owner 负责。 |
| UTF-8 输出截断 | TS | 纯计算研究项，未测速。测完整流处理成本；尾部扫描本身已经限制在一个 UTF-8 序列内。 |
| UUID 与 base64 utility | TS/系统 crypto | UUID 使用平台随机字节；base64 可单独测量。该包不是项目 hash/签名的 authority。 |
| 文件搜索、图片、SQLite 与沙盒隔离 | TS 加 ripgrep、sharp/libvips、SQLite、C/native 隔离 | 测量 adapter 与真实负载时保留现有组件；源码集成不能证明性能收益。 |
| Native UI、模型/协议集成、学习规则及其他待审查函数 | 现有 Swift/TS/Python/native owner | 保持当前产品与权威契约；剩余函数逐项核对，不记录“某语言全面更好”的结论。 |

## 实测与后续决策

[30 次迭代的搜索 fixture](../../rust-benchmark.json) 绑定源码 `45ea6452d11156d19568a2137ac43d57262dee38`：current TS cold p50 为 11.756 ms，优化 TS 缓存 p50 为 0.513 ms，Rust cold IPC p50 为 21.189 ms，Rust warm child p50 为 18.248 ms。Rust 复用子进程但仍重建索引，优化 TS 则复用已构建索引。缓存 TS 实现在 benchmark 中，这些数字不证明正式 Ark 已经部署该优化。结果相同只支持该语料的差分回放；索引复用方式不同，不能据此分离语言成本、证明搜索质量提升或预测全 Ark 提速。决策为 `RETAIN_TS`，验收仍为 `UNKNOWN`。

对剩余每项函数，先核对实际 profile 可达性、任务调用频率，再测 CPU/RSS/event-loop 或生命周期成本。只有找到瓶颈或隔离需求才注册三组对照：current TS、优化 TS、真实边界的 Rust。保持相同算法与索引复用条件，检查结果/错误回放、序列化、冷热启动、取消、恢复、包体/CI/平台数据及已有 fallback。持久索引、扫描器和批处理内核在这些证据通过前都只是研究项。
