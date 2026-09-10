# Agent Note: Ark 原生风险边界

Status: implemented

[English](2026-08-29-ark-native-risk-boundaries.md) | 中文

## Problem

Ark 可能把 Native 客户端与较旧的 Host RPC 集合组装在一起，也可能直接覆盖既有或正式 `Ark.app`；Provider 恢复 journal 或子进程 argv 可能持久化秘密；Git 运行期间新产生的编辑可能被完成回调丢弃；旧 EventPump 的 WebSocket receive loop 尚未静止时又可能创建新实例；重复 wire/config 标识可能触发 trap；inactive Provider 的模型可能被误判可路由；Workbench debounce 窗口内的最后编辑可能丢失；Terminal 也可能只停止前台 shell 而留下后代进程；Markdown 可能自动拉取远程图片；持久 profile 可能继续装配漂移的第三方 bundle；监听器即使声称 API-only，仍可能分派非 API WebSocket upgrade。

## Decision

Native 构建只产候选。输出 owner 拒绝正式、link-shaped、嵌套与既有 App 目标；self-contained 构建跟随 Native API runtime plan，在嵌入前后都要求每条严格 Remote route 同时存在于实现、生成 descriptor、Host lookup 与 package entry。

Provider mutation 为每个 Provider 保留一个持久事务 identity。active journal 只包含设置意图与 credential digest，绝不包含凭据材料。macOS Keychain 写入在私有伪终端中运行 `/usr/bin/security`，通过终端输入完成两次确认；值不会进入 argv、捕获输出、文档或向上传播的诊断。

Workbench Git 操作在启动时捕获 clean file-tab 状态。改变 worktree 的操作成功后，只有当前状态仍与该 clean snapshot 完全相同时才重置 tabs；之后产生的编辑、打开的 tab 与选择变化继续由用户拥有，现有保存 CAS 会拒绝外部文件冲突。

`ArkEventPump.stop()` 是所有并发调用方共享的一次异步 quiescence 操作。它取消 socket 与 receive task，等待全部 task 后才结束 stream。`ArkAppModel.shutdown()` 等待该操作完成，AppKit 才释放界面或启动替代 backend lifecycle。

重复 identity 在各自 domain owner 处理，不再交给 trapping dictionary initializer。Provider model rows、sessions 与 Wiki paths/pages 保留 Host 顺序和第一条明确记录；重复 feedback message ID 会拒绝 wire response。Composer 用当前 Provider `active` 事实过滤 fallback model groups，并在这些事实尚未知时保持 unavailable。

AppDelegate 拥有 `NativeWorkbenchDraftFlushCoordinator`，已挂载的 Workbench model 注册弱引用 flush callback。正常退出与 backend replacement 在 model shutdown 前后刷新最新 dirty-tab snapshot；任何持久化失败都会 veto teardown 并保留界面。Journal 继续使用 owner-only、同目录原子持久化，也不记录 draft text。

Native Terminal 现在通过 Ark 可执行文件的 pre-application helper 模式启动，使用 `posix_spawn`、新 session、`login_tty` 与经过验证的前台进程组。关闭标签页时，只异步枚举自有 session 内的进程组，按有界 HUP、TERM、KILL 升级，并执行唯一一次 `waitpid`；主动用新 session 逃逸的子进程不属于此所有权边界。远程 Markdown 图片改为经过校验的原生链接与静态元数据，不再由 `AsyncImage` 后台请求。

API-only 权威在 upgrade route 分派前执行：通过 loopback Host 栅栏但不在 `/api` 下的 upgrade，即使携带 token 也返回 404。Ark 自有 profile 文件只通过普通、非共享、不可被其他用户写入的目录与文件路径协调；漂移内容先写入 owner-only、完整核验的内容寻址回滚，再以 compare-and-swap 替换。强制 Native overlay 禁用浏览器名录并设置 `serveFrontend: false`，因此 Ark 不解析 frontend dist、不挂载 HTML fallback，同时保留当前 startup/readiness 与 `/api` 事件传输的 Host 半边。

Queue 控件与 composer 暴露稳定的辅助功能 identity。已保存模型路由只有在所属 Provider active 时才可用；路由缺失时明确显示不可用，即使 draft 非空也保持 Send 禁用。Queue 的编辑、移除与严格插话仍是基于稳定 item identity 的 Host-owned mutation。

根部三列 `Layout` 不导出任何 alignment guide，因此横向与纵向两个 `explicitAlignment` overload 都直接返回 `nil`。这会覆盖 SwiftUI 默认实现；默认实现原本会为推导 alignment 重新进入 `placeSubviews`，反复测量完整 chat `LazyVStack`。main、divider 与 Workbench 的几何仍只由 placement 持有。

## Verification

Artifact policy contracts 会拒绝不安全输出与缺失 Host route。Provider 与 Keychain 测试覆盖 digest-only journal、事务恢复、无密错误及 PTY 输入。assembled-app E2E 使用隔离 home 与无害凭据证明 Keychain set、凭据文档零秘密、restore 与 unset。Native contracts 覆盖 dirty-tab 保留、duplicate-key 输入、inactive Provider 过滤、termination flush、EventPump 并发 stop、Terminal session 所有权、远程图片惰性链接、Queue 辅助功能 seam 与根部 explicit-alignment override。候选行为覆盖精确 backend 换代、UI 恢复、进程与端口完整清理，以及隔离的未保存文件：quit 后成为 `0600` 恢复记录，经恢复页重新打开，源文件保持不变。v82 候选还证明了 live profile 回滚 identity、active browser roster 与 Better Sidebar 均为零、两个 Better Sidebar terminal upgrade 在有无 Bearer 时均为 404、`events.mux` 未鉴权/已鉴权分别为 401/101、真实 PTY 命令与抗 HUP/TERM 后台进程回收、不可用模型明确禁发且 Session 数为零，以及针对本地 stall mock 的真实 Queue 编辑/移除/插话。它的五分钟 soak 随后复现布局故障：`ps` 衰减读数连续 35 次超过 80%，而五秒 sample 进一步确认主线程 3,607/3,880 个样本位于 SwiftUI flush，889 次经默认 alignment 进入 `ArkRootSplitLayout.placeSubviews`。override 后的 v83 sample 中，主线程 4,285/4,285 个样本都停在正常 `mach_msg`；区间 `top` 对 Hero 重复点击测得峰值 63%、达到或超过 80% 的样本为零，对三分钟真实用户任务测得峰值 47.5%、达到或超过 80% 的样本同样为零。仅断开 `events.mux` socket 后的 Queue 恢复仍未证明。

## Alternatives considered

**原地修补既有 bundle。** 这会保留 source/artifact 漂移，并绕过候选 identity、rollback 与 codesign 证据，因此构建选择直接失败。

**通过 `security -w` argv 传入 Keychain 值。** 进程检查与子进程诊断可能暴露它，因此 argv 不再承载凭据材料。

**把值写入普通 stdin。** macOS `security -w` 从 controlling terminal 读取并要求确认；普通 pipe 可能在没有保存预期值时仍退出。实现复用已锁定的 `node-pty` 依赖并要求两个提示都出现。

**在整个 Git 操作期间禁用编辑器。** 这会缩小用户交互，却不能证明迟到回调会保留状态。snapshot owner 保留正常编辑，并在 destructive reset 的 commit point 进行条件判定。

**保留 trapping dictionary initializer 并相信 Host 唯一性。** 多项数据跨越 wire、persistence 与 plugin 边界，重复值仍可表达。按 domain 选择首行 owner 或明确 invalid-response，能保留顺序，也不会把歧义升级为进程崩溃。

**把 model ID membership 当作 routability。** inactive Provider 仍可能保留 catalog/settings rows，因此 membership 只是 advisory；当前 Provider activity 才是 fail-closed authority。

**正常退出时依赖 350 ms draft debounce。** Quit 与 backend replacement 可能先于计划写入发生。Lifecycle owner 会直接调用同一 journal，并在失败时 veto teardown。

## Consequences

credentials-local 在 macOS Keychain 模式下依赖已经随产品交付的 `node-pty` 包。候选组装会拒绝 stale runtime，而不是产出部分可用的 App。Git 仍可能在观察到并发编辑前改变 worktree，但内存 draft 会保留，也不能静默覆盖变化后的文件。Wiki first-wins 去重会隐藏后续歧义记录，而不是修复上游数据。Native 产品不打包浏览器应用、HTML fallback 或 WebKit surface；Host-only Remote 与 NativeEvents owner 提供经过鉴权的 loopback API 与事件传输。本决策不关闭固定端口策略、Queue 的 mux-only reconnect 证明、B0 freeze、unified soak 或正式版晋级。
