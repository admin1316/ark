# Agent Note: 在 Issue 策略中适配 Issue Fields 能力

Status: implemented

[English](2026-09-18-issue-fields-capability-adaptation.md) | 中文

## 问题

Issue 策略会通过 `GET /repos/{owner}/{repo}/issues/{number}/issue-field-values` 读取每个被引用 Issue 的 Issue Field 值。Issue Fields 是组织范围的元数据。[Issue Fields changelog](https://github.blog/changelog/2026-05-21-issue-fields-are-now-in-public-preview-for-all-organizations/) 宣布其面向“所有 GitHub 组织”提供；[组织指南](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/managing-issue-fields-in-your-organization)指出字段“定义在组织层级，并作用于组织内的所有仓库”；[REST 写入端点](https://docs.github.com/en/rest/issues/issue-field-values)也把取值限定为“为仓库所属组织定义的组织级 Issue Fields”。由 User 拥有的仓库没有可用于定义字段的组织，因此该端点返回 `404`——对 `admin1316/ark` 的 `#28` 与 `#34` 的实测结果即为如此，其中 `X-Accepted-Oauth-Scopes: repo` 排除了令牌作用域这一原因。

策略却把该响应当作致命错误。任何引用了 Issue 的 PR 都会在抓取快照阶段、尚未评估任何政策规则之前，让必需检查失败，无论其引用与标签多么合规。反过来把同一个 `404` 当作成功，则会抹掉真正的 Priority 校验。两种做法都没有回答策略真正需要回答的问题：该仓库究竟能否承载 Issue Fields。

## 决策

由仓库元数据判定能力，并且只在文档化契约适用的地方查询字段端点。`issueFieldCapability(ownerType)` 把来自 `GET /repos/{owner}/{repo}` 的 `owner.type` 映射为四种状态之一，`issueFieldValues` 再按 Issue 补全这些状态。

- `SUPPORTED`——由 Organization 拥有的仓库，且其 `GET .../issue-field-values` 至少返回一个值。
- `EMPTY`——由 Organization 拥有的仓库，且端点返回空列表。Priority 为 `null`，但该字段本身可被设置，因此既有 Priority 规则照常执行。
- `UNSUPPORTED`——由 User 拥有的仓库。该端点不会被调用，Priority 不可读取，其余所有政策校验继续执行。
- `UNKNOWN_OR_ERROR`——其他任何 `owner.type`、由 Organization 拥有的仓库返回 `404`、非数组载荷，或任何 `401`、`403`、`429`、`5xx`、超时、传输故障。这些都会拒绝并使运行失败。

只有在每个被解决 Issue 的能力都可读取时，才对解决型 PR 执行 Priority 一致性校验。当能力为 `UNSUPPORTED` 时跳过该比较，并由 `pullRequestPolicyNotices` 打印显式的 `::notice::`，列出相关 Issue，说明 Priority 未经校验且不构成 Priority 通过。运行日志还会打印观测到的能力状态，从而区分“没有值”与“无法读取值”。

该能力在进程内按仓库 slug 缓存，因此一次运行不会混淆多个仓库；代码中也不含静态仓库身份：同一份代码同时服务于 `admin1316/ark`、某个 fork，以及由 Organization 拥有的仓库。

## 验证

[Issue 管理测试](../../../../.github/issue-management/policy.test.mjs)通过伪造传输层锁定从 `pullRequestSnapshot` 到 `validatePullRequest` 的调用链：由 User 拥有的仓库绝不调用仅限组织的端点，同时 kind、area、引用、旧版标签以及“把 PR 当作 Issue 引用”的规则仍然生效；由 Organization 拥有的仓库仍解析 `Priority` 并校验被解决 Issue 中的最高 Priority；`EMPTY` 与 `UNSUPPORTED` 保持可区分；`404`、`403`、`429`、`500`、无效 JSON、传输故障、非数组载荷、缺失 `owner.type` 以及元数据读取失败全部拒绝；同一进程内的两个仓库各自保留能力状态；Draft 与进入评审前的边界保持不变。`pnpm run test:issue-management` 在 `ci-static` 中运行该文件。

[工作流契约测试](../../../../scripts/ci-workflow.spec.ts)继续锁定 [issue-policy.yml](../../../../.github/workflows/issue-policy.yml)：可信的默认分支检出、固定版本的动作以及最小权限均未改动，这正是该变更进入默认分支之前，可信检查仍运行旧实现的原因。

## 考虑过的替代方案

**把 `404` 当作“没有 Issue Fields”。** 这是最小的补丁，也能消除误报失败，但它会把每一种能力、权限与路由故障都变成静默通过，并让真正拥有字段的仓库失去 Priority 校验。

**根据 `404` 本身判定能力。** 该端点的文档化 `404` 是通用响应，无法区分个人仓库、能力损坏与被拒绝的请求。仓库元数据改为在调用之前回答这个问题。

**对个人仓库跳过整个 Issue 策略。** 引用、标签与生命周期职责在个人仓库同样适用；只有 Priority 依赖 Issue Fields。

**探测 `GET /orgs/{org}/issue-fields` 来消解 Organization 仓库的 `404`。** 工作流使用的 `GITHUB_TOKEN` 只带仓库范围权限，因此组织端点自身就可能因与该能力无关的原因返回 `404` 或 `403`，只是用一种模糊信号换掉另一种。

**硬编码仓库或增加按仓库开关。** 仓库身份已经按运行从 `GITHUB_REPOSITORY` 解析，静态开关只会把最初的错误假设搬进配置。

## 后果

由 User 拥有的仓库仍保有有意义的必需检查：引用、kind、area 与标签都会被校验，唯一在该环境不可能存在的规则会被报告为“未校验”，而不是静默满足或永久失败。拥有 Issue Fields 的 Organization 仓库行为与之前完全一致。

若 Organization 仓库所属组织未启用 Issue Fields，或该端点不可用，检查将以失败关闭（fail closed）结束。这是刻意为之，因为那里无法校验 Priority；失败信息会指出这一能力矛盾。要重新审视该行为，需要仓库范围的能力信号，而不是再次解读状态码。

`validateIssue` 中的原生 Issue Type 校验保持不变。Issue type 在文档中由仓库所属组织继承，而由 User 拥有的仓库目前无法设置它；那个独立的缺口不在本次改动范围内。
