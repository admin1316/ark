# Agent Note: P0 批次 C——demo 环境轨、匿名 ID 权限、envelope 与遥测脱敏

Status: implemented

[English](2026-08-16-p0-batch-c-demo-env-anonid-telemetry.md) | 中文

## Problem

企业审计剩余的启动路径与导出路径缺陷。其一，ACP 与 JSON-RPC demo 入口通过未过滤的 `loadEnv` 轨加载 `.env`：不可信项目目录中的 `.env` 可设置 `DSH_HOME`（重定向整个 harness home）或注入 `NODE_OPTIONS`/`LD_PRELOAD` 类启动变量，放大 node-pty 覆盖面。其二，匿名用户 ID 以默认 umask 权限持久化（文件 `0o644`/目录 `0o755`），把稳定机器身份暴露给本机其他用户，违反仓库 `0o600`/`0o700` 惯例。其三，两条导出路径明文泄漏凭据：fetch carrier 的 `subscribeEnvelopes()` 观察 tap 把包含 `apiKey` 载荷字段的出站请求 envelope 原样交给观察者；FULL 模式会话遥测把 `structuredClone(event.data)` 原样导出且不携带任何脱敏规则，用户输入、工具参数与会话正文原样发往 OTLP collector。

## Decision

**Demo 入口切换到分层环境轨。** `dsh-acp-demo` 与 `dsh-jsonrpc-agent` 改调 `loadLayeredEnv`（项目 `.env` + harness home `.env`，任何值生效前先拒绝 bootstrap 名）替代 `loadEnv`；未过滤的 helper 保留导出以兼容 API，但仓库内已无消费者。

**匿名用户 ID 仅所有者可读。** `getOrCreateAnonymousUserId` 以 `0o700` 创建 home、以 `0o600` 创建 ID 文件（独占创建与覆盖两条路径都是）。回归断言两种 mode。

**envelope 观察 tap 脱敏 secret 载荷字段。** `AbstractApiClient.onEnvelope` 在推入观察缓冲前放入分离副本，其中 `apiKey`/`accessToken`/`refreshToken` 载荷字段若为字符串值则替换为 `[redacted]`；线上请求体不受影响。回归断言观察者看到标记、handler 收到真实 key。

**会话遥测内置凭据键掩码。** coordinator 的 `redact()` 在 `session-telemetry/record` waterfall 之前应用 `maskCredentialKeysInRecord`：body 或 attributes 中任何键名匹配 `/(api[_-]?key|token|secret|password|passwd|authorization|auth[_-]?header|credential)/i` 的字段，在导出副本上替换为 `[redacted]`（按字段名匹配，普通会话文本保持可读）。部署挂载的监听器仍在内置默认之上堆叠。JSDoc、README 与遥测复兴 Agent Note 均从「不携带任何规则」更新为内置默认语义。

## Alternatives considered

**仅在 OTLP exporter 脱敏。** 否决：coordinator 是唯一捕获汇聚点，waterfall 契约本就声明脱敏只作用于导出副本；在 waterfall 前掩码可覆盖所有下游消费者。

**深度解析 JSON 字符串载荷字段（如 `tool/call` arguments）。** 否决：字符串内容属于会话文本而非结构化字段；按字段名匹配是文档化契约，部署规则可堆叠更严格的掩码。

**demo 保留 `loadEnv` 并文档化风险。** 否决：产品 CLI 已拒绝 bootstrap 名；demo 轨保持不过滤会重现审计标记的注入面，且被 node-pty 覆盖通道放大。

## Consequences

demo 的 `.env` 现在可能拒绝产品 CLI 早已拒绝的名字；依赖 `.env` 设置 `DSH_*` 的部署必须改为导出这些变量。遥测 FULL 模式导出不再与会话日志逐字节一致——形似凭据的字段默认被掩码，需要原始副本的部署必须挂载恢复规则。匿名 ID 文件权限变更对同一用户不可见，并阻止其他本地用户读取。
