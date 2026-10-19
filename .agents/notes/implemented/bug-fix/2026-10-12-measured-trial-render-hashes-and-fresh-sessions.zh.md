# Agent Note：实测试验的渲染证据与全新会话

Status: implemented

[English](2026-10-12-measured-trial-render-hashes-and-fresh-sessions.md) | 中文

## Problem

实测试验 reader 把原始知识页哈希和工具渲染结果哈希当成同一值。真实 Wiki 工具会渲染带标题的内容块，因此合法使用回执无法通过验证。reader 也允许不同预注册配对重复使用同一 session ID，并被记作多次观察。

## Decision

reader 区分现有的三个哈希域。提案目标哈希、使用回执 `contentHash` 和注入事件 `sourceContentHash` 绑定原始 Wiki 字节。注入事件 `contentHash`、`resultHash` 和回执 `renderedToolResultHash` 绑定序列化后的渲染结果。reader 要求所选注入事件与回执中的知识 ID、调用 ID、会话作用域、已验证页面状态、源哈希、渲染值、事件哈希及字节数一致。由于现有所选事件工件采用规范 JSON，reader 对解析后的渲染值进行规范化比较，同时继续对渲染工件执行精确原始字节 SHA-256 校验。

一次试验中的每个 baseline 和 candidate 使用都必须拥有唯一 session ID 和唯一 `useId`。调用 ID 和事件序号仍属于单个会话，可以在全新会话中重复。已认证的 owner capture 继续验证完整的检索、工具调用与结果以及后续 provider request 关系；实测试验 reader 不解析完整日志。

## Alternatives considered

- **把渲染哈希当作原始源哈希：** 拒绝，因为真实 Wiki 工具会将标题和内容块渲染成不同于源页面的字节。
- **要求调用 ID 或事件序号全局唯一：** 拒绝，因为这些标识属于单个会话，合法的全新对话可以重复使用它们。
- **增加新的日志解析器或格式字段：** 拒绝，因为现有已认证 capture 负责完整事件一致性，冻结回执格式已经包含所需哈希和会话 ID。

## Consequences

合法的 Wiki 渲染证据可以通过 reader，同时源页面身份仍绑定到提案中的精确字节。重新提交同一会话的观察并换用另一个配对 ID，或在配对/试验臂间重复使用 ID，都不能制造额外观察。这些检查不能证明 evaluator 或日志签名方的真实托管；生产信任配置和独立验证仍属于单独的部署门槛。

## Testing

实测试验夹具覆盖渲染哈希与源哈希分离、事件与渲染结果不匹配、重复会话与重复使用 ID 拒绝，以及不同全新会话复用本地调用 ID 和事件序号的有效配对。capture owner 测试使用隔离测试密钥，将真实 `captureKnowledgeUse` 和 `sealCapturedUse` 输出交给 reader 验证。
