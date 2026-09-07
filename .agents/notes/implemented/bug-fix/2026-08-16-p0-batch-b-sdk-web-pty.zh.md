# Agent Note: P0 批次 B——SDK 启动竞态、Web API 令牌默认值、PTY helper 守卫

Status: implemented

[English](2026-08-16-p0-batch-b-sdk-web-pty.md) | 中文

## Problem

企业审计（第二阶段 P0 实施）暴露三项启动级缺陷。其一，Python SDK 的 `HarnessClient.start()` 在锁外执行 check-then-act（先判断 `if self._proc is not None` 再 `Popen`）：两个并发 `start()` 会各自拉起一个子进程，后一次 `Popen` 覆盖 `_proc` 并使首进程无人回收；并发 `close()` 还可能 terminate 掉并发 `start()` 刚启动的进程。`DeepSeekHarness.start()` 对 `_initialized` 的守卫同模式。close→start 复用后，上一次 close 的哨兵残留在通知/请求队列中，`next_notification()` 会对健康运行时立即抛出过期的 `TransportClosedError`。其二，webserver 的 API 门禁默认关闭：未导出 `DSH_API_TOKEN` 时每个 `/api` 请求都被放行，任何本地进程都能无凭据驱动整个 harness；webserver 配置 schema 仍接受 `0.0.0.0`，远程暴露只是一行组合配置的距离。其三，固定的 `node-pty` 补丁让 `DSH_NODE_PTY_SPAWN_HELPER` 成为未经校验的路径，被原生 `pty.fork` 作为 helper 执行：任何能注入 `process.env` 的主体（启动 shell、`loadEnv` 轨的 `.env`）都能让 PTY 后端以用户权限执行任意二进制，而子进程环境擦洗不覆盖此面——node-pty 读取的是父进程环境。

## Decision

**Python SDK 串行化 start/close 并重置复用队列。** `HarnessClient.start()` 把整个 check-then-act（`_proc is None` 判断、`_session_parents.clear()`、`Popen`、两个读线程启动）移入 `self._lock`，并用新队列替换 `_notifications`/`_requests`，使 close→start 复用不再复活上次 close 的哨兵。`close()` 在 terminate/wait 之后于同一锁内原子释放认领（`if self._proc is proc: self._proc = None`），并发 `start()` 不会观察到半关闭进程、并发 `close()` 不会重复 terminate；shutdown 请求、stdin 关闭、terminate/wait 与线程 join 留在锁外，避免与 `_fail_waiters` 重入死锁。`DeepSeekHarness` 增加独立的 `_start_lock`（client 锁不可重入——`client.start()` 内部会再次进入自身锁）。回归：双线程 barrier `start()` 断言恰好一个存活进程；close→start 复用断言队列未被预投毒。

**webserver API 门禁默认永不关闭。** 令牌依次取自新增的 config `apiToken` 字段、`DSH_API_TOKEN`，两者皆无时每次启动以 `randomBytes(32)` 新铸造；生效令牌可通过 `apiToken` 属性读回。绑定 `0.0.0.0` 要求显式令牌（配置或环境），否则拒绝启动——随机单次令牌对合法远程客户端不可知，只会掩盖暴露面。浏览器仍经 index tap 植入的 SameSite cookie 正常鉴权；无凭据的 `/api` 请求从放行变为 401。`stays open when no token is exported` 测试改写为 `generates a launch-scoped token and rejects /api without it`，并新增 `0.0.0.0` 拒绝测试。

**node-pty helper 覆盖项受可信根守卫。** 补丁（经 `pnpm patch-commit` 重新生成，lockfile hash 已更新）仅在 `DSH_NODE_PTY_SPAWN_HELPER` 解析为可执行文件自身的 `-spawn-helper` 伴随文件或 node-pty 包目录（`path.resolve(__dirname, native.dir)`）下的路径时接受；其余一律忽略并回退到默认解析（executable sibling，再打包内 helper）。可见仓库无任何代码设置此变量——Python runtime 打包使用 executable sibling，在白名单内——既有路径无回归。

## Alternatives considered

**门禁保持 opt-in（导出 `DSH_API_TOKEN` 才启用）。** 否决：该 P0 的全部意义就在于默认是开放的；随机单次铸造在保持浏览器流程不变的同时关闭无凭据本地 RCE。

**启动时从环境剥离 `DSH_NODE_PTY_SPAWN_HELPER`。** 否决：node-pty 在模块加载时从父进程读取该变量，剥离必须发生在 import 之前——补丁是唯一的强制点，可信根守卫在拒绝注入的同时保留消费方 helper 位于包外的预期覆盖能力。

**Python start/close 用一把粗锁包住全部 I/O。** 否决：shutdown 请求与进程回收较慢，且会经 `_fail_waiters` 重入 `_lock`；只有认领状态迁移需要互斥。

## Consequences

webserver 行为变更对手写本地客户端可见：它们现在必须从 `webServer.apiToken` 携带 bearer 或 cookie。Python SDK 公开表面不变；并发 `start()` 不再遗留进程。node-pty 补丁在不影响打包运行时（macOS 构建器的 helper 缺失失败保留）的前提下守卫覆盖通道。2026-07-29 持久 bash 说明中的覆盖项描述已更新为守卫机制；2026-08-15 启动级安全加固说明的令牌门禁决策由本文记录的默认铸造与 `0.0.0.0` 规则扩展。
