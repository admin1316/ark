# Agent Note: 平台路径、持久化句柄与实际测试阶段

Status: implemented

[English](2026-10-14-platform-path-durability-test-contracts.md) | 中文

## Problem

文件系统路径、逻辑仓库路径和文件 URL 具有不同契约。混用这些表示会破坏 Windows 模块加载、签名和退役入口检测。Windows 也可能在普通文件下报告 ENOENT，刷新只读 stage 句柄则可能在持久化故障测试到达目标操作前失败。根据先前事件或固定文件轮询推断异步阶段的测试，可能在所描述操作开始前注入故障。

## Decision

验证器启动路径使用标准的文件 URL 转换。既有仓库路径投影负责以斜杠分隔的逻辑路径；签名收据字节和签名编码器保持不变。Wiki 缺失路径判断区分真正缺失与祖先阻挡，同时保留经既有目录别名访问缺失路径的行为。晋级恢复在 Windows 上以可写方式打开其拥有的既有 stage，再执行必需的文件刷新；字节、inode、链接计数和刷新后检查继续保护发布。

生命周期测试等待实际被调用程序或已持久化的 journal 阶段。缓存测试关闭 cache fiber，通过既有 domain 写队列排空操作完成写入，同时保持存储 owner 可用。Claude fixture 先关闭自己拥有的 HTTP 传输，再等待消费者退出，并保留清理错误。平台故障 fixture 在被检查的 syscall 处保持原故障语义，不依赖 POSIX chmod 或 rename 行为假设。

Native owner 连接器继续仅支持 Unix。Windows 协议测试使用真实命名管道流，stat 替身仅作用于自己拥有的 fixture 端点。独立的真实文件系统控制拒绝实际 Windows 管道，不发布 authority。Native roster 快照保留明确的 Unix 和 Windows shell catalog，不通过归一化抹去工具差异。

托管 macOS Native 检查在运行契约前安装同样固定的 Node 和不可变 pnpm 依赖。Swift fixture 启动实际 `tsx` 源码消费者，验证 Native/XPC journal 签名与重复调用拒绝；只有 Swift 源码的 checkout 无法执行该消费者。既有源码别名解析 workspace 导入，无需新增产物构建或修改签名检查。

验证器 helper 在 leader 响应前写入自己的就绪标记。POSIX 保留真实的 leader 退出后幸存进程测试。Windows 检查未分离 helper 实际消失，并将其归因于 [libuv 的父进程 job](https://github.com/nodejs/node/blob/v24.x/deps/uv/src/win/process.c)；期限与取消测试则在真实 leader 退出后单独控制受管理的等待。[既有验证器等待契约](2026-10-13-verifier-post-exit-cancellation.zh.md)继续保留操作期限和独立观察上限。

## Alternatives considered

**忽略文件系统错误或跳过 Windows suites。** 这样可能掩盖损坏路径，或绕过测试必须证明的拒绝和协议行为。

**增加超时或轮询先前事件。** 更长的等待无法确定故障应发生于哪个实际 callee 或持久化阶段。

**将 helper 消失视为 Harness 清理。** spawn PID 本身不证明启动，Windows job 清理也不证明 Harness 发出了信号或能管理已分离的幸存进程。

## Consequences

源码与测试 owner 使用主机的路径和持久化语义，不改变 wire 格式、签名、权限、重试策略或覆盖率门槛。测试替身仅证明分支契约，不构成 Windows 可信 Native owner 的证据。子进程 provider 继续明确 Windows 直接子进程存活判断和已分离后代的限制。

PowerShell 大输出的严格前缀断言附带有界返回输出和保留终端诊断。在实际 Windows 执行提供这些字节前，前缀缺失的原因仍未解决；诊断不代表终端已修复。源码测试和托管 CI 仍分别区别于候选任务验收及正式安装。
