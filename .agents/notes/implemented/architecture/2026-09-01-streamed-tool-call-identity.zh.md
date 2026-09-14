# Agent Note：流式工具调用身份不被空续传分片抹除

Status: implemented

[English](2026-09-01-streamed-tool-call-identity.md) | 中文

## 问题

DeepSeek SSE 翻译器对每个携带该字段的工具调用分片都直接赋值 `id` 与 `name`，因此续传分片把其中任一字段重复发送为空串时，会抹掉该调用首个分片已建立的身份。组装出的块带着空名字进入循环，工具注册表以 `unknown tool ""` 拒绝它。把这些字段填成 `null` 的网关会造成同样的抹除，而 `WireToolCallDelta` 把两者都声明为 `string | undefined`，让实际观察到的 `null` 落在编译器视野之外。

空身份还会活过本轮。`appendToolCall` 与 `appendToolResult` 原样写入块的 id 且没有任何写入路径校验它，而 `adoptSessionEvent` 拒绝 `callId` 为空的 `tool/result`。记录过一次这种调用的会话可写但不再可读：持久化协调器把该拒绝包装成 `SessionPersistenceCorruptionError`。

## 决定

`acceptIdentity` 对工具调用的 `id` 与 `name` 只接受非空字符串；`undefined`、`null`、`''` 以及任何非字符串都保留已建立的值。`WireToolCallDelta` 把 `id`、`function.name` 与 `function.arguments` 放宽到允许 `null`，使网关实际发送的值进入类型系统，运行时守卫因此是承重的而非臆测的。

流到达 `[DONE]` 时仍缺少 `id` 或 `name` 的工具调用不会被闭合。翻译器先报告待发的用量，再以携带新增 `MALFORMED_TOOL_CALL` code 的错误 finish 结束响应，并且完全不发出 `block-end`。`closeBlock` 返回缺失的是哪个字段，而不是替换成空串，因此没有任何路径能组装出无身份的工具调用。

`MALFORMED_TOOL_CALL` 加入默认可重试 code 集。该失败必须以错误 `finish` 而非抛出的 `LlmError` 抵达：agent 循环从 `BlockAssembler.finish` 派生 `agent/request-error`——`dsh-llm-retry` 唯一监听的扩展点——并把流抛出的任何东西直接重抛出本轮。抛出的失败无论策略如何都会终结本轮且不重试。

## 考虑过的替代方案

**跨分片拼接 `id` 与 `name`。** 否决：它们是身份而非累积。面对发送 `null` 的网关，拼接产生 `Globnull`；面对重复发送非空值的网关，产生重复的名字。

**流中途拒绝冲突的非空身份。** 推迟：分片发送长工具名的网关会因此被拒，而 `[DONE]` 处的检查已经能让不可用的调用到不了循环。

**放宽会话读取端对空 `callId` 的拒绝。** 否决：空 `callId` 无法在下一次请求中与提供方配对，接受它只是把失败推进模型请求。该拒绝是持久化边界的闸门；缺陷在生产方。

**在调用的首个分片不带 `id` 时立即拒绝。** 否决："仅首个分片"是对远端编码器的声明，晚一个分片才发送 `id` 的网关会被无谓拒绝，而 `[DONE]` 处的检查覆盖了早检查能覆盖的全部情况。

## 后果

重复发送空或 null 身份的续传分片不产生作用，调用因此保有其首个分片建立的身份。始终不给出调用身份的提供方现在的代价是一次重试，而不是一个 `unknown tool ""` 结果加一个无法重新打开的会话。已经记录了空 `callId` 的会话仍不可读；恢复它们不在本次改动范围内。

## 测试

`translate.spec.ts` 覆盖空与 null 续传分片、重复的相同身份、空续传下并行调用各自保有身份，以及 `id` 或 `name` 始终未抵达时的拒绝——包括失败前先报告用量、且其前没有 `block-end`。原先记录空身份输出的两个用例现在断言拒绝。`retry-policy.spec.ts` 钉住新的默认可重试集。
