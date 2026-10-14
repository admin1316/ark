# Agent Note: 平台路径、持久化句柄与实际测试阶段

Status: implemented

[English](2026-10-14-platform-path-durability-test-contracts.md) | 中文

## Problem

文件系统路径、逻辑仓库路径和文件 URL 具有不同契约。混用这些表示会破坏 Windows 模块加载、签名和退役入口检测。Windows 也可能在普通文件下报告 ENOENT，刷新只读 stage 句柄则可能在持久化故障测试到达目标操作前失败。根据先前事件或固定文件轮询推断异步阶段的测试，可能在所描述操作开始前注入故障。

将操作系统的 inode 身份转换为 JavaScript 数字，会让安全整数范围外的不同文件合并为同一个值。这可能误报 Wiki 页面重复访问、接受被替换的文件，或删除其他写入者的锁。毫秒时间戳也会丢失操作系统元数据中可见的变化。保留可变 fixture 数组的清理钩子可能消费下一轮测试的资源，而 Cordis disposal promise fulfilled 也不能排除已经记录的 effect 错误。

## Decision

验证器启动路径使用标准的文件 URL 转换。既有仓库路径投影负责以斜杠分隔的逻辑路径；签名收据字节和签名编码器保持不变。Wiki 缺失路径判断区分真正缺失与祖先阻挡，同时保留经既有目录别名访问缺失路径的行为。晋级恢复在 Windows 上以可写方式打开其拥有的既有 stage，再执行必需的文件刷新；字节、inode、链接计数和刷新后检查继续保护发布。

Wiki 遍历、有界读取、原子发布、unlink、review stage、事件日志同步和写入锁释放保留 BigInt device/inode 元数据。读取后检查比较纳秒时间戳。这些值只存在于文件系统检查内部：有界的公开页面大小仍是数字，JSON、WAL 和签名 payload 字节继续使用既有编码器。共用 governed-path resolver 在检查子路径前拒绝已存在的非目录中间组件；真正缺失的后缀与非缺失 I/O 错误继续分别处理。

生命周期测试等待实际被调用程序、已收束的 subagent end 或已持久化的 journal 阶段。缓存测试关闭 cache fiber，通过既有 domain 写队列排空操作完成写入，同时保持存储 owner 可用。Claude fixture 在异步工作前固定每个 query 的消息与清理 owner，先关闭自己拥有的 HTTP 传输再等待消费者退出，并独立于后续 fixture 保留失败。SQLite differential 样本在删除目录前释放两个 backend 及重新打开的实例。受限清理观察器同时保留已记录的 effect 错误、初始化错误与断言错误。平台故障 fixture 在被检查的 syscall 处保持原故障语义，不依赖 POSIX chmod 或 rename 行为假设。

Profile resolver fixture 等待实际子进程就绪，并在 IPC 完成回调后退出，确保结果已发送。有界阶段诊断保留既有样本数和超时限制。凭据重载断言要求完整的替换快照，同时检查保留和删除的键。Benchmark 子进程选择平台对应的可执行文件后缀；这个选择不构成性能结果。Windows 私有 Core 测试断言既有 POSIX-only 配置拒绝与原状态保持，不声称试用成功。

Native owner 连接器继续仅支持 Unix。Windows 协议测试使用真实命名管道流，stat 替身仅作用于自己拥有的 fixture 端点。独立的真实文件系统控制拒绝实际 Windows 管道，不发布 authority。Native roster 快照保留明确的 Unix 和 Windows shell catalog，不通过归一化抹去工具差异。

托管 macOS Native 检查在运行契约前安装同样固定的 Node 和不可变 pnpm 依赖。Swift fixture 启动实际 `tsx` 源码消费者，验证 Native/XPC journal 签名与重复调用拒绝；只有 Swift 源码的 checkout 无法执行该消费者。既有源码别名解析 workspace 导入，无需新增产物构建或修改签名检查。

验证器 helper 在 leader 响应前写入自己的就绪标记。POSIX 保留真实的 leader 退出后幸存进程测试。Windows 检查未分离 helper 实际退出，并将其归因于 [libuv 的父进程 job](https://github.com/nodejs/node/blob/v24.19.0/deps/uv/src/win/process.c)；期限与取消测试则在真实 leader 退出后单独控制受管理的等待。[既有验证器等待契约](2026-10-13-verifier-post-exit-cancellation.zh.md)继续保留操作期限和独立观察上限。

Leader 退出后的测试在取消前绑定 helper 的实际启动身份。Linux 进程组收束可能包含同一身份的 Z/X 状态；诊断区分残留进程条目与 PID 不存在，并拒绝仍执行、身份替换或无法读取的情况。Windows 取消 fixture 保持实际匿名 stdin 管道打开，待实际就绪后再动作。其终止证据来自操作系统信号或 job 边界，不冒充未执行的 POSIX handler。清理在删除 fixture 前分别等待父子进程，并同时保留正文与清理错误。Windows ESRCH 证明已不再执行或已不存在，不证明全部内核进程对象已被销毁。

缓存计数测试在测量后续事件门槛前先确认已持久化的初始化 cut。HMR 创建测试保留注册 watcher 的就绪、事件、规范路径与刷新阶段的有界诊断，不延长时限或替换为 polling。这些观察没有修复尚未查明的 HMR 事件丢失原因或 Windows junction 发布空窗。

## Alternatives considered

**忽略文件系统错误或跳过 Windows suites。** 这样可能掩盖损坏路径，或绕过测试必须证明的拒绝和协议行为。

**增加超时或轮询先前事件。** 更长的等待无法确定故障应发生于哪个实际 callee 或持久化阶段。

**将 helper 消失视为 Harness 清理。** spawn PID 本身不证明启动，Windows job 清理也不证明 Harness 发出了信号或能管理已分离的幸存进程。

**舍入身份或将 promise 收束等同于清理成功。** 相邻的大 inode 值会舍入为同一个数字，Cordis 则可能记录 effect 错误而仍让 disposal promise fulfilled。实际 owner 资源收束与保留错误是分别检查的事实。

## Consequences

源码与测试 owner 使用主机的路径、整数精度和持久化语义，不改变 wire 格式、签名、权限、重试策略或覆盖率门槛。受控高 inode 元数据结合实际文件替换证明拒绝机制，不构成已证实的 NTFS 攻击。平台 dispatch fixture 只证明分支契约，不构成其他操作系统的内核执行或 Windows 可信 Native owner 的证据。子进程 provider 继续明确 Windows 直接子进程存活判断和已分离后代的限制。

PowerShell 大输出的严格前缀断言附带有界返回输出和保留终端诊断。在实际 Windows 执行提供这些字节前，前缀缺失的原因仍未解决；诊断不代表终端已修复。源码测试和托管 CI 仍分别区别于候选任务验收及正式安装。
