---
description: "供工具、带作用域的回答者和原生 Host UI 提供方使用的问答服务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-user-questions

[English](README.md) | 中文

## 概述

用户交互 Service Definition。它定义 `ctx.userQuestions`，供面向模型的工具或权限插件在需要暂停工作并询问人类决定时使用。当消费方必须暂停操作并等待用户回答时，请使用它。

## 目录

- [服务：`UserQuestionService`（ctx 键：`userQuestions`）](#service-userquestionservice-ctx-key-userquestions)
- [职责](#role)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="service-userquestionservice-ctx-key-userquestions"></a>
## 服务：`UserQuestionService`（ctx 键：`userQuestions`）

### 公开 API

- `ctx.userQuestions.ask(request): Promise<AskUserQuestionAnswer>` 派发回答者 waterfall，并等待第一个接受请求的回答。
- `ctx.userQuestions.registerProvider(provider): () => void` 注册监听器委托后使用的唯一 Host UI 回答提供方。重复注册以 `DUPLICATE_PROVIDER` 拒绝；释放调用方 fiber 或调用返回的 disposer 会撤销该提供方。Ark 原生事件服务负责其待答请求与取消。

### 关键类型

- `AskUserQuestionRequest`：`{ questions: [{ id, question, detail?, header?, options?, multiSelect?, intent? }], agent?, signal? }`；`detail` 提供辅助文本，提供方会将其随问题一起渲染，而不会将其变成选项标签。如提供 `agent`，它必须与注册表中的存活运行时根 agent（智能体）是同一对象。
- `AskUserQuestionOption`：`{ label, description? }`。
- `AskUserQuestionIntent`：`{ kind: 'plan-review', approve }`；即下文的带标签呈现意图。
- `AskUserQuestionAnswer`：`{ answers: [{ id, selected, custom? }] }`。
- `UserQuestionError`：`HarnessError` 的子类，包含 `EMPTY_QUESTIONS`、`BAD_INTENT`、`NO_PROVIDER`、`ASK_ABORTED`、`CALLER_NOT_LIVE` 和 `DELEGATED_CALLER` 等代码。

对于单选题，`custom` 会覆盖选中的选项，且 `selected` 为空。对于多选题，`custom` 可以补充 `selected` 中的标签。UI 可以把跳过的条目保留为 `{ id, selected: [] }`，既维持现有回答形态，也保留该批次中的其他回答。

请求包含 agent 时，`ask()` 会通过当前 `AgentRegistry` 验证该 agent 与注册表中的存活实例是同一对象，并且只允许运行时根调用。持久谱系不构成权限依据：带有历史委托深度的会话恢复为新的运行时根后可以提问；归属于另一个 agent 的存活子级即使持久化记录的委托深度为零也会被拒绝。带作用域的回答者仅接收匹配的请求。不含 agent 的请求交给未限定作用域的监听器和 Host 回答提供方；`NO_PROVIDER` 表示两者均未接受它。

### 呈现意图

`intent` 声明某个问题本身就是一种已知决策，因此认识该标签的 UI 可以照此呈现——`plan-review` 表示 `detail` 是一份待审阅的计划，`dsh-plan-mode` 会在 `exit_plan_mode` 的问题上设置它。意图只改变呈现：遵循它的 UI 回答的仍是通用 UI 会发送的那些选项标签，不认识该标签的 UI 渲染通用选项列表，因此调用方两种情况下读到的回答字段相同。`approve` 指名表示批准的标签，而不依赖选项顺序。有两项断言无法通过类型表达，`ask()` 会以 `BAD_INTENT` 拒绝它们：`approve` 未命中该问题自身的任一选项，以及意图落在没有 `detail` 的问题上——而 `detail` 正是它自称在审阅的东西。

<a id="role"></a>
## 职责

这是 Service Definition 包。`@deepseek-ai/dsh-tool-ask-user` 等 Consumer 依赖此服务；Ark 原生事件服务注册 Host UI 回答提供方。本地插件可以在该提供方之前组合带作用域的回答者。工具调用等待回答，再恢复正常的 agent loop（智能体循环）。

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-tool-ask-user`：它会将成功回答保留为紧凑 JSON，或返回以下失败之一：`Error: ask_user_question was aborted before the user answered`、`Error: ask_user_question requires at least one question`、`Error: human interaction requires the exact live calling agent when an agent is supplied`、`Error: human interaction is unavailable while the calling agent is owned by another live agent; include the unresolved question or decision in the child agent's final result`、`Error: no user-questions answerer accepted the request` 或 `Error: <message>`。等待人类回答不会增加 token。

#### KV Cache 影响

不会直接使 KV Cache 失效；请求前缀的任何变更均由上述消费方负责。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **提供方负责请求生命周期**：UI 提供方必须撤销已取消的请求，并在卸载时结算待答请求；撤销注册仅阻止新请求进入该提供方。
- **词汇仅包含问题表单形态**：可供选择的选项加可选的自定义文本；更丰富的交互形态（文件选择器、diff 预览确认）尚无 seam 词汇。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
