# Agent Note: 跨平台 Wiki 路径与提供方事务终态

Status: implemented

[English](2026-10-10-cross-platform-path-and-transaction-terminality.md) | 中文

## 问题

会话摘要写入器使用宿主路径分隔符构造持久 Wiki 相对路径。Windows 上，review 治理边界正确拒绝了反斜杠路径，导致候选页面已写入但没有对应审核记录。另一个竞态是：设置已持久化、但事务读取已提交描述符之前，提供方设置 owner 被卸载；此时返回 `provider-transaction-in-doubt` 会错误描述一个已知的“已持久化但未激活”结果。

## 决策

[Knowledge Wiki 会话摘要器](../../../../packages/host/knowledge-wiki/src/index.ts)使用 `path.posix.join` 构造持久 Wiki 相对路径，文件系统路径仍使用宿主的 `path.join`。[提供方事务 owner](../../../../packages/llm/llm/src/provider-transaction.ts)在设置持久化后 owner 消失时，写入带有 `settings-rejected` 失败信息的 `committed-not-live` 终态。已无法取得已提交设置描述符时，不会报告激活成功，也不会让已知结果保持为待恢复事务。

Windows 原生门继续保留较大范围的包链接和输出截断断言，同时限制覆盖率插桩下的重复次数和数据量：profile 测试每轮仍会重指向全部 160 个链接，PowerShell 输出仍超过 16,000 字符的响应上限。

## 考虑过的替代方案

**在治理边界接受反斜杠。** 持久 Wiki 引用有意采用 POSIX 格式，并拒绝路径遍历和平台专用分隔符。保持边界严格、修复可信调用方，可维持单一可移植格式。

**设置 owner 消失后仍保留不确定事务。** 此时设置持久化已经完成。写入 `committed-not-live` 终态回执可以记录已知事实，避免后续恢复被误认为已激活。

**保留原有 Windows 压力规模。** 对 160 个链接完整重指向 40 次，再加上 12,050 行 PowerShell 输出，会超过 Windows 覆盖率测试的运行时间。12 轮仍覆盖 1,920 次链接变更，5,000 行仍超过输出上限；两项检查都以更短耗时保留了原来验证的行为。

## 影响

审核索引现在在所有宿主上收到相同的斜杠分隔候选路径。提供方关闭竞态会留下明确终态回执，区分“已持久化”和“已激活”。在 GitHub Windows runner 成功完成之前，跨平台验收仍未通过。

## 测试

针对 provider transaction、Wiki session summary、profile fallback 和持久 PowerShell Loader composition 的定向 Vitest 测试在 macOS 上通过：132 项通过，1 个环境专用 PowerShell suite 按条件跳过。Windows 原生用例仍需 GitHub Windows runner 完成最终验证。
