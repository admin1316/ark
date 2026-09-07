# Agent Note: 将 Agent Teams 晋级为 Subagent 产品角色

Status: implemented

[English](2026-08-30-agent-teams-product-promotion.md) | 中文

## 问题

原生 standard 与 code preset 已暴露 Team 协作能力，但其领域包和模型工具包仍是私有 experimental 依赖。已发布的 profile runner 或 Python runtime closure 不能真实携带这些私有包名，因此发布图与已配置能力可能分离。

## 决策

`@deepseek-ai/dsh-agent-team` 位于 `packages/subagent/agent-team`，负责持久 `ctx.agentTeams` roster、mailbox 与 task DAG。`@deepseek-ai/dsh-tool-agent-team` 位于 `packages/subagent/tool-agent-team`，负责按作用域的 Team policy 与面向模型的工具。它们是唯一的 Team 实现。

profile runner、Python runtime closure、原生 preset、示例组合、TypeScript path map、Host aggregate、工具目录生成器与发布族断言都使用这些正式名称和路径。dsh 发布族从 Subagent 分组发现两个包，其 manifest 使用共享发布版本和公开发布元数据。

不保留 experimental 名称的兼容包。预发布兼容策略允许原子重命名，而保留别名会形成第二个 Team identity，并掩盖不完整 runtime closure。先前的[孵化决策](../../archived/architecture/2026-08-18-experimental-agent-teams-packages.md)保留私有包阶段的历史记录。

## 考虑过的替代方案

### 在运行时保留私有 experimental 包

该方案不可取，因为已发布的包与 Python runtime 不能依赖私有 experimental 成员，否则发布图无法解析。

### 增加兼容包装包或白名单

该方案不可取，因为它会保留第二个包 identity，并让 workspace constraints 无法发现同一闭包缺陷。

### 将 Team 行为合并进 Subagent service 或 tool-subagent

该方案不可取，因为持久 Team 领域及其按作用域模型工具 consumer 有独立的 owner 和生命周期义务。合并会复制或模糊既有的 service/provider/consumer 边界。

## 后果

Agent Teams 现在承担 Subagent 产品角色的发布、版本、文档、invariant 与发布载荷义务。现有配置必须使用正式名称；只要 profile 声明 Team，发布闭包就包含持久领域包和按作用域工具包。显式委派策略与隔离 Agent realm 保持不变。

## 验证

定向 Team unit 与真实组合测试、workspace constraints、冻结安装、package invariants、runtime closure 与 dsh release packing 验证正式包对及其消费者。
