# @deepseek-ai/dsh-deepseek-llm-api-extensions

[English](README.md) | 中文

官方 DeepSeek 请求顶层独立字段的 effect-scoped registry。贡献方独占一个通过声明合并定义的字段，在发送前准备脱离原对象的 JSON 值，并可提供 acceptance 回调；DeepSeek adapter 只会在 HTTP 2xx 响应后提交该回调。

准备过程读取已经序列化的基础请求。Registry 会 structured-clone 并递归冻结每个贡献值，拒绝重复字段 owner，在请求取消后停止等待，并保证联合 acceptance transaction 幂等。所有 acceptance 回调都会完成结算，再报告单个失败或 `AggregateError`。

## 模型体验

### 提供方请求扩展

#### 模型看到什么

Registry 自身不贡献内容。已挂载的提供方可增加 `dsh_plugin_packages` 等特定于提供方的顶层 JSON 字段；除非该提供方另有定义，否则这些字段不会成为提示消息或工具 schema。

#### Token 影响

Registry 本身不产生 token。提供方字段位于 Harness 的提示 token 计量之外，除非远端 API 另有说明。

#### KV Cache 影响

Registry 保持已经序列化的提示主体不变。提供方元数据是否影响远端缓存，只由该提供方的 API 约定决定。

## 已知限制与暂缓事项

- 目前只有官方 DeepSeek adapter 消费该 registry。
- Acceptance 只证明 HTTP 2xx 交付，不能证明提供方端点之后的长期保留。
