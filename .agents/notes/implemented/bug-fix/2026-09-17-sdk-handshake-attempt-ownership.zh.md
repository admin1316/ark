# Agent Note: SDK 启动尝试的所有权

Status: implemented

[English](2026-09-17-sdk-handshake-attempt-ownership.md) | 中文

## 问题

`DeepSeekHarness` 会把一次 `start()` 尝试记忆为同一个 Promise，让并发调用方共享同一次运行时握手。该尝试在等待失败客户端的 `close()` 之前就释放了这份记忆，由此产生两个缺陷。落在清理窗口内的 `start()` 会针对正在关闭的客户端开启一次竞争尝试：多出一个客户端、多一次 `client.start()` 调用，并把原始握手失败替换成 `TransportClosedError`；当清理也失败时，调用方拿到的 `AggregateError` 首因是这个多余的传输错误，而不是 initialize 错误。同步抛出的握手更糟：重置发生在异步尝试仍处于同步前导阶段时，随后的记忆赋值把已 settle 的 rejection 重新装了回去，之后每次 `start()` 都重放它，harness 永久卡死。

## 决策

被记忆的尝试在自己清理 settle 之前一直拥有这次握手。`start()` 记忆 `handshake()` 并返回该记忆；`handshake()` 把 `this.clientInstance` 捕获到局部引用，对该捕获客户端调用 `start()` 与 `initialize(...)`，失败时先 await 该客户端的 `close()`，然后才触碰记忆。只有清理 settle 之后，尝试才把 `this.initialized` 置回 `undefined`，并在清理已证明旧进程退出、且 harness 仍处于开启状态时，从工厂装入一个新客户端。

清理失败会保留被尝试的客户端：其退出未被证明，`HarnessClient.close()` 是永久终态，重试因此对着该客户端快速失败，而不是在一个可能仍在运行的进程旁再启动一个进程。该失败以 `AggregateError([error, cleanupError], 'DeepSeek Harness initialization and cleanup failed')` 的先后顺序抛出；清理成功时原样重新抛出原始错误。`close()` 保持终态，因此之后的尝试永远不会装入替代客户端。

所有权按实例划分，只通过记忆与捕获的客户端表达；harness 不持有全局锁、单例或永久注册表。

## 测试

`packages/sdk/client/tests/lifecycle.spec.ts` 用 deferred 结算驱动一个完全脚本化的客户端：并发 start 共享一次握手；落在清理窗口内的 start 观察到待定尝试的结果；清理完成后的重试恰好创建一个替代客户端；清理失败保留两个原因并保留未证明退出的客户端；close 在窗口内与迟到的握手结果面前保持终态；`start()` 或 `initialize()` 的同步抛出与 `initialize()` 的异步拒绝走同一条释放路径；两个 harness 保持独立。

`packages/sdk/client/tests/sdk-client.spec.ts` 用真实子进程重复清理窗口场景：假运行时在 stdin EOF 时触碰标记文件（`FAKE_EOF_FILE`），无需固定 sleep 即可打开窗口，两次 start 合计只有一个 `initialize` 请求到达运行时。

这些测试未覆盖：客户端自身套件之外的 dispose 阶梯失败、上述之外的其它交错时序、以及进程收尾的平台差异。

## 考虑过的替代方案

**在清理前释放记忆。** 这正是缺陷：窗口内的调用方无法区分"仍在清理"与"可以重试"，而同步握手抛出根本无法被重置，因为记忆赋值尚未发生。

**用锁、令牌集合或忙等来串行化尝试。** 每实例标志会重复记忆的所有权且仍需同一释放点，进程级锁或永久集合会把独立 harness 耦合在一起，轮询则把确定性的拒绝换成没有上界的等待。

**清理失败后保留已 settle 的 rejection 记忆。** 重试会直接重放已存的 `AggregateError` 而不真正重试，既看不出保留的客户端是否可用，也让记忆的含义取决于发生过哪种失败。

**任何失败都保留失败客户端。** 清理已成功的客户端已是永久关闭状态；保留它会让每次重试都撞上已知死亡的传输，而不是 API 承诺的新尝试。

## 后果

并发调用方只能观察到一次尝试的结果，清理期间也是如此，因此每次尝试的客户端、握手与子进程数量由构造而不是时序限定。在清理期间重试的调用方拿到原始失败，而不是多余的传输错误。代价是重试会等待清理 settle 而不是立即失败，且清理失败会让 harness 在关闭前无法启动新进程——这是"绝不在退出未被证明的进程旁启动"的对价。后续修改必须保持释放点在清理之后、保持捕获客户端位于尝试内部、保持 `AggregateError` 的原因顺序，并保持 `close()` 终态。
