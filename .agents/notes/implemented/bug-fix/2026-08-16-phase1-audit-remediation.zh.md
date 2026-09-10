# Agent Note: Phase 1 审计整改批次

Status: implemented

[English](2026-08-16-phase1-audit-remediation.md) | 中文

## Problem

v2 企业审计（2026-08-16，只读）将一项 P1 安全暴露与两个红门禁列为 Phase 1 之首：Web 服务器从不校验 Host 头（DNS rebinding 页面可解析到 127.0.0.1 并读取 JS 可见的 token cookie 驱动整个 `/api` 面）、`pnpm run duplication` 因仓库仅有的两处克隆失败、`hygiene` 链首个环节短路其余十个环节。一项 P1 性能项（同步 SQLite 日志扫描阻塞事件循环）完成该批次。

## Decision

四项修复，各自在其表面之外保持行为不变：

1. **Webserver rebinding 围栏 + HttpOnly cookie**（`packages/host/webserver`）：绑定回环时，每个请求与 upgrade 拒绝非回环字面量（`127.0.0.1`/`localhost`/`[::1]`）的 Host 头；全接口绑定（显式 token 暴露，归浏览器信任围栏）放行。植入的 `dsh_api_token` cookie 增加 `HttpOnly`——SPA 从不读取，rebinding 页面无法外泄。frontend-static spec 的 80 字符 body 前缀加宽至 200，使其 SPA fallback 断言能看到被不断增长的 cookie 脚本遮住的尾部——审计暴露的潜在测试缺陷。
2. **重复门禁**（`cordis-host-runner/src/queries.ts`）：`inventoryRows`/`snapshotRows`/`referenceFor`/`inspectPluginFor` 内联了同一包行映射与版本指针存在折叠——仓库仅有的 jscpd 克隆。提取 `packageRows`/`versionFields`/`activeRunOf`；门禁转绿（0 克隆）。
3. **hygiene 链**（`scripts/rescope-vendor.ts`）：`docs/subsystems/extensions.{md,zh.md}` 的生成 `cordis-surface` 段渲染 `cordis/*` 事件 key——由 `gen-cordis-catalog.ts`（本身已被跳过）产出的运行时契约标识符——被残留检查误读为 vendored 包引用。两个文件加入 `GENERIC_SKIPS` 的 `cordis` 名；11 环节全链恢复通过。
4. **SQLite 扫描让步**（`session-persistence-sqlite`）：`scanRows`（`readPrefix`/`loadStoredFrom` 共用）在 `DatabaseSync` 连接上同步解析每一事件行。现为 async，并在 JSON 解析遍每 500ms 经 `scheduler.yield()` 让步——与 JSONL 后端解码已用的同一间隔——长会话加载与事件循环协作而非停摆进程。

## Alternatives considered

**仅按配置地址白名单 Host。** 拒绝：`localhost` 与 `[::1]` 是同一回环绑定的合法访问拼写，拒绝它们会为无安全收益而破坏既有访问模式。

**SQLite 用 worker 线程解析。** 本批次拒绝：`DatabaseSync` 不能跨线程，序列化行需整份日志拷贝，而让步方案以单行语义面消除进程停摆。若分析显示解析成本仍显著，worker 卸载仍是 Phase 4 选项。

## Consequences

回环绑定下 DNS rebinding 无法再经外来 Host 触及 harness；token cookie 对页面 JS 不可见。duplication 与 hygiene 门禁转绿（审计已修）、frontend-static 套件恢复通过、长 SQLite 日志协作式加载。四项变更均由既有套件覆盖（webserver 7、sqlite 102、host-runner 91、frontend-static 3；typecheck/lint 干净；test:gui 3853 通过，仅余一个既有环境性失败）。
