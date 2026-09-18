# Agent Note: 在 Issue 策略中适配 Issue Fields 能力

Status: implemented

[English](2026-09-18-issue-fields-capability-adaptation.md) | 中文

## 问题

Issue 策略会通过 `GET /repos/{owner}/{repo}/issues/{number}/issue-field-values` 读取每个被引用 Issue 的 Issue Field 值。Issue Fields 是组织范围的元数据。[Issue Fields changelog](https://github.blog/changelog/2026-07-02-issue-fields-are-now-generally-available/) 宣布其面向“所有 GitHub 组织”正式可用（5 月起处于公开预览）；[组织指南](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/managing-issue-fields-in-your-organization)指出字段“定义在组织层级，并作用于组织内的所有仓库”；[REST 写入端点](https://docs.github.com/en/rest/issues/issue-field-values)也把取值限定为“为仓库所属组织定义的组织级 Issue Fields”。由 User 拥有的仓库没有可用于定义字段的组织，因此该端点返回 `404`——对 `admin1316/ark` 的 `#28` 与 `#34` 的实测结果即为如此。

该响应带有 `X-Accepted-Oauth-Scopes: repo`。该响应头说明端点接受哪些 OAuth 作用域；它本身不能证明所出示的令牌已获授权，也不能证明资源可达；而且三类凭据的授权机制并不相同——OAuth 令牌按作用域、fine-grained 令牌按仓库权限、GitHub App 安装令牌按 App 权限。因此这次调用的授权情况记为 NOT_VERIFIED，而不是“已排除”。本轮没有读取、打印或扩大任何令牌值、作用域或权限；能力结论依据的是文档化的组织级约束与仓库元数据中的 `owner.type = User`。

策略却把该响应当作致命错误。任何引用了 Issue 的 PR 都会在抓取快照阶段、尚未评估任何政策规则之前，让必需检查失败，无论其引用与标签多么合规。反过来把同一个 `404` 当作成功，则会抹掉真正的 Priority 校验。两种做法都没有回答策略真正需要回答的问题：该仓库究竟能否承载 Issue Fields。

## 决策

由仓库元数据判定能力，并且只在文档化契约适用的地方查询字段端点。`issueFieldCapability(ownerType)` 把来自 `GET /repos/{owner}/{repo}` 的 `owner.type` 映射为四种状态之一，`issueFieldValues` 再按 Issue 补全这些状态。

- `SUPPORTED`——由 Organization 拥有的仓库，且其 `GET .../issue-field-values` 至少返回一个值。
- `EMPTY`——由 Organization 拥有的仓库，且端点返回空列表。Priority 为 `null`，但该字段本身可被设置，因此既有 Priority 规则照常执行。
- `UNSUPPORTED`——由 User 拥有的仓库。该端点不会被调用，Priority 不可读取，其余所有政策校验继续执行。
- `UNKNOWN_OR_ERROR`——其他任何 `owner.type`、由 Organization 拥有的仓库返回 `404`、非数组载荷，或任何 `401`、`403`、`410`、`429`、`5xx`、超时、传输故障。这些都会拒绝并使运行失败。

不可读取的值既不会产生 Priority 义务，也不会解除义务。当 PR 声明了 `p0`–`p3`、或有被解决 Issue 携带可读取的 Priority、或可信规则另行要求一致性时，义务即成立。若该义务待履行而任一所需值不可读取，`validatePullRequest` 返回 `BLOCKED_UNVERIFIED` 错误，CLI 非零退出，并且不会打印通过行；notice 不能替代该失败。

| 情形（针对解决型引用） | Priority 义务 | 结果 |
|---|---|---|
| 无——只有信息性 `Related to` 引用 | 无 | 其他检查照常；Priority 为 NOT_APPLICABLE |
| 不在强制范围——Draft、Bot/App 作者，或无评审请求且无评审 | 无 | 不执行政策 |
| 所有值可读；未声明 Priority 且无可读 Issue Priority | 无 | 按既有规则 PASS |
| 所有值可读；存在可读 Issue Priority 但未声明 Priority | 有 | FAIL `PR Priority 应为 <highest>` |
| 所有值可读；已声明 Priority 而某 Issue 未设置 | 有 | FAIL `有 Priority 的解决型 PR 要求每个被解决 Issue 都设置 Priority` |
| 所有值可读；声明的与 Issue 的 Priority 不一致 | 有 | FAIL `PR Priority 应为 <highest>` |
| 任一值不可读；未声明 Priority 且无可读 Issue Priority | 无 | NOT_APPLICABLE notice，退出码 0 |
| 任一值不可读；PR 声明了 Priority | 有 | BLOCKED_UNVERIFIED 错误，非零退出 |
| 任一值不可读；另一被解决 Issue 的 Priority 可读 | 有 | BLOCKED_UNVERIFIED 错误，非零退出 |
| 认证、权限、限流、服务端、网络、超时、非法载荷、缺失元数据，或组织仓库的未知 `404` | 不适用 | 在进入校验前即失败关闭 |

可读与不可读的值绝不会被混合成部分比较：只要有一个必需的不可读值，整个一致性结论即被阻断，而不是把它丢弃。`EMPTY` 与 `UNSUPPORTED` 保持区分，`UNKNOWN_OR_ERROR` 不会降级为 `UNSUPPORTED`，也绝不会凭空生成 Priority 或从 PR 标签复制 Priority。

每个请求都带有限定超时（`DSH_ISSUE_POLICY_TIMEOUT_MS`，默认 30 秒），因此停滞的端点会拒绝，而不是把检查挂死。该能力在进程内按仓库 slug 缓存，因此一次运行不会混淆多个仓库；代码中也不含静态仓库身份：同一份代码同时服务于 `admin1316/ark`、某个 fork，以及由 Organization 拥有的仓库。

## 验证

[Issue 管理测试](../../../../.github/issue-management/policy.test.mjs)通过伪造传输层锁定从 `pullRequestSnapshot` 到 `validatePullRequest` 的调用链：由 User 拥有的仓库绝不调用仅限组织的端点，同时 kind、area、引用、旧版标签以及“把 PR 当作 Issue 引用”的规则仍然生效；由 User 拥有且声明了 Priority 的解决型 PR 返回 `BLOCKED_UNVERIFIED`；无义务的解决型 PR 返回 NOT_APPLICABLE notice 且退出码为 0；由 Organization 拥有的仓库保留全部 Priority 规则，包括多个 Issue 时的最高优先级；部分可读的集合绝不会被部分比较；`401`、`403`、`404`、`410`、`429`、`500`、无效 JSON、传输故障、超时、非数组载荷、缺失 `owner.type` 以及元数据读取失败全部拒绝；同一进程内的两个仓库各自保留能力状态；强制校验边界仍受 Draft 与评审状态约束；真实 CLI 对 PASS 退出 0、对 FAIL 与 BLOCKED_UNVERIFIED 非零退出，并通过回环服务器验证。`pnpm run test:issue-management` 在 `ci-static` 中运行该文件。

[工作流契约测试](../../../../scripts/ci-workflow.spec.ts)锁定 [issue-policy.yml](../../../../.github/workflows/issue-policy.yml)的 `ready_for_review` 触发器；本分支未改动任何工作流文件，因此可信的默认分支检出、固定版本的动作与最小权限继续有效——这正是该变更进入默认分支之前，可信检查仍运行旧实现的原因。

组织路径行为依据官方契约与受控调用链测试验证。本轮没有进行真实的组织仓库调用：当前可用凭据未能取得合适的组织样本（`GET /user/orgs` 返回空列表）。这只说明本轮没有取得合适样本；它既不能证明不存在可访问的组织资源，也不能作为平台支持与否的证据，并且从不参与能力判定。ORGANIZATION_LIVE_VALIDATION = NOT_RUN。

## 考虑过的替代方案

**把 `404` 当作“没有 Issue Fields”。** 这是最小的补丁，也能消除误报失败，但它会把每一种能力、权限与路由故障都变成静默通过，并让真正拥有字段的仓库失去 Priority 校验。

**根据 `404` 本身判定能力。** 该端点的文档化 `404` 是通用响应，无法区分个人仓库、能力损坏与被拒绝的请求。仓库元数据改为在调用之前回答这个问题。

**对已声明的 Priority 维持仅 notice 的处理。** 这正是本次收尾要消除的不一致：日志说 Priority 未校验，必需检查却报告通过。待履行的义务是失败，不是解释。

**从空读取或不可读读取反推“没有义务”。** 不可读的值属于未知；把它当作不存在一致性义务的证明，等于让能力缺失抹掉规则。义务由“已声明”与“可读”这两个触发条件定义。

**对个人仓库跳过整个 Issue 策略。** 引用、标签与生命周期职责在个人仓库同样适用；只有 Priority 依赖 Issue Fields。

**探测 `GET /orgs/{org}/issue-fields` 来消解 Organization 仓库的 `404`。** 工作流使用的 `GITHUB_TOKEN` 只带仓库范围权限，因此组织端点自身就可能因与该能力无关的原因返回 `404` 或 `403`，只是用一种模糊信号换掉另一种。

## 后果

由 User 拥有的仓库仍保有有意义的必需检查：引用、kind、area 与标签都会被校验，而声明了 Priority 的解决型 PR 现在以 `BLOCKED_UNVERIFIED` 失败关闭，而不是带着 notice 通过。没有 Priority 义务的解决型 PR 仍按与“Organization 仓库中某个 Issue 本来就没有 Priority”相同的规则保持 NOT_APPLICABLE。

拥有 Issue Fields 的 Organization 仓库行为与之前完全一致。若 Organization 仓库所属组织未启用 Issue Fields，或该端点不可用，检查将以失败关闭（fail closed）结束，因为那里无法校验 Priority；要重新审视该行为，需要仓库范围的能力信号，而不是再次解读状态码。

`validateIssue` 中的原生 Issue Type 校验保持不变。Issue type 在文档中由仓库所属组织继承，而由 User 拥有的仓库目前无法设置它；那个独立的缺口不在本次改动范围内。

Projects 状态路径（`projectContext`，会解析 `organization(login:)`）同样保持不变，并且在由 User 拥有的仓库上仍未解决；本 note 不声称个人仓库的 Issue 管理已被完整支持。
