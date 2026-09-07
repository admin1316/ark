# @deepseek-ai/dsh-session-log-deepseek

[English](README.md) | 中文

官方 DeepSeek 请求可选的无损增量会话日志贡献方。它从端点上次确认接受的最高序号之后开始，发送规范会话 header 与完整 event suffix。已接受 watermark 本身也是持久会话事件，因此重启和 fork 恢复无需第二个状态存储，就会保守重发所有不确定尾部。

## 配置

```yaml
- name: '@deepseek-ai/dsh-session-log-deepseek'
  config:
    enabled: true
```

`enabled` 默认为 `false`；省略配置时不会注册请求字段。启用后，准备过程不会推进状态。官方 adapter 只在 HTTP 2xx 后调用捕获的 acceptance 回调，因此非 2xx、传输失败、取消或准备失败都会保留旧 watermark，供后续保守重发。

该字段可能包含用户消息、助手输出、工具调用与结果、路径以及其他完整规范会话事件。启用它属于显式的高敏感数据共享决定，部署必须提供告知并定义保留策略。

## 模型体验

### 增量会话交付

#### 模型看到什么

不会增加提示消息或工具。部署明确选择启用后，官方端点会收到带版本的顶层 `dsh_session_log` 字段。

#### Token 影响

按照 Harness 计量约定，不增加模型输入 token；传输体积会随尚未接受的规范事件尾部增长。

#### KV Cache 影响

提示前缀不变。会话字段是否影响缓存身份，由提供方决定。

## 已知限制与暂缓事项

- HTTP 2xx 是提交点；提供方接受后、本地 acceptance event 写入前发生崩溃，可能重发一次尾部。
- 本包不会删改规范事件。部署未作出明确隐私决定前不得启用。
