# Agent Note: 根据持久终态生成原生轮次导航

Status: proposed

[English](2026-09-13-native-turn-navigation-terminal-state.md) | 中文

## 问题

导入历史包含全部九个轮次结束事件，但原生导航仍将第 1、3、4、9 轮标为运行中。这些轮次实际已经意外中断或取消。导航把不在成功 fork 集合中的轮次当作运行中，并从最后一条助手消息推断中断。轮次可以在没有中断消息、甚至没有任何助手消息的情况下结束；此时空导航详情还会错误显示等待中。

## 提案

现有[轮次投影](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellUI/ArkChatTurnMetrics.swift) 保留每个 `turn/end` 的终态。[历史快照](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellUI/ArkHistoryReadingWindow.swift) 从同一截点的轮次种子携带该事实，实时快照则从现有模型投影携带该事实。[导航](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellUI/ArkRootView.swift) 将该状态用于标记、无障碍值和空回答详情。终态变化也会使现有展示缓存失效。

已知原因区分完成、取消、意外中断、失败、策略阻止和达到输出上限。未知扩展原因仍能证明轮次已经结束。缺少终态证据时，只有当前实时轮次可以显示运行中；历史截点显示历史前缀，不再活动且尚无结论的轮次显示状态未知。成功 fork 集合仍仅包含 completed，保留独立的[完成轮次尾部操作边界](../../implemented/bug-fix/2026-08-02-message-fork-actions-require-completed-turn-tail.zh.md)。

## 考虑过的替代方案

**将全部已结束轮次加入完成集合。** 这会让失败或中断轮次获得成功 fork 的资格。

**从最后一条助手消息或会话活动推断生命周期。** 消息中断是另一项事实，一个当前会话状态也无法描述全部历史轮次。原始日志已经包含所需终态证据。

## 验收标准

行为检查必须覆盖全部内置原因、一个扩展原因、没有助手输出的轮次、增量与恢复投影的等价性、同截点历史安装以及不变的 fork 资格。真实候选导航必须与导入历史的终态事件一致，包括空回答的帮助信息。源码检查与合成测试不能证明候选验收或正式晋升。

## 风险

固定截点可能早于后续终态事件；用户返回更新截点前显示历史前缀是有意保留的语义。未知扩展原因使用通用已结束标签，不凭空推断成功或失败。
