# Ark 候选 P5 观测回执（2026-09-13 11:2x）

候选：`~/ark-test/candidate/Ark.app` = 3.1.99 / 2026091405 / source `cc2e35e5`，回滚件 `~/ark-test/candidate/rtollback-20260913111043/Ark.app`。
进程：GUI pid 99473、后端 launcher pid 99477、runner pid 99506（TCP 127.0.0.1:59007 LISTEN）。

## 已实测

| 指标 | 结果 | 方法 |
|---|---|---|
| 启动瞬态 CPU | 峰值 82.3%，随后 16% → 5.9% → 5.7% 回落 | `ps -o pcpu=` 每 5s 采样 30s |
| 启动瞬态 RSS | GUI 128 → 271MB，随后回落至 220MB | 同上 |
| **GUI 稳态 CPU** | **1.3–2.2%（均值约 1.7%）** | `top -l 20 -s 1` 逐秒 20 次 |
| **runner 稳态 CPU** | **0.4–0.8%（均值约 0.6%）** | 同上 |
| **两者合计稳态 CPU** | **约 2.0–2.9%**（门槛 ≤2%，**略超**） | 同上 |
| GUI 稳态 RSS | 355 MB / 9 线程 | `top` |
| runner 稳态 RSS | 462 MB / 14 线程 | `top` |
| 后端认证 | 无 token → 401 `{"error":"missing or invalid API token"}`；正确 token → `/api/health` **200 {"status":"ok"}** | `curl` + runner 环境里的 `DSH_API_TOKEN` |
| 未知路由 | 404 `not found`（路由器按预期工作） | `curl` |
| 凭证隔离 | `ARK_KEYCHAIN_SERVICE=ark.candidate.credentials.6e7cc748…` | runner 环境 |
| 数据隔离 | 写 `~/ark-test/current-home`，正式版 `~/ark/Ark.app` 未动（仍 3.1.0/202609121430/8fcec77a） | 文件与 plist 对比 |

## 观察到但不判定为缺陷

- **Metal 编译器 XPC 断连**：11:14:49 连续 2 条 `MTLCompiler: Connection attempt 1/10 failed with XPC_ERROR_CONNECTION_INVALID … compiler service may have crashed, been jetsammed`。定位在 GUI 的 Metal 编译服务（系统侧），非候选自身崩溃；候选进程随后继续存活。建议下次前台交互时复看是否复现。
- **窗口不可见**：RunningBoard 状态 `running-active-NotVisible`（agent 上下文启动，窗口未在前台）。因此以下指标**本轮无法测**。

## 本轮无法测（需前台真实交互，属"未验收"而非"通过"）

1. 输入响应 P95 ≤100ms
2. 滚动帧间隔 P95 ≤33ms
3. 主线程 >1s 停顿
4. 空闲 60s 合计 CPU ≤2% 的**严格判定**（当前合计约 2.0–2.9%，采样窗口仅 20s 且程序在后台）
5. 长历史会话加载/跳转、流式期间阅读旧历史、中文输入、终端往返、Workbench 外链
6. 60 分钟混合观察

## 结论

候选**可运行、可认证、隔离正确、稳态 CPU 已接近门槛**（合计约 2–2.9% vs ≤2%）；但**交互与 60 分钟验收仍未完成**，不能标记 P5 通过。正式版未被触碰。
