# @deepseek-ai/dsh-session-log-deepseek

English | [中文](README.zh.md)

Optional lossless incremental session-log contribution for official DeepSeek requests. It sends the canonical session header and event suffix after the highest sequence previously accepted by the endpoint. The accepted watermark is itself a durable session event, so restart and fork recovery conservatively replay every uncertain tail without a second state store.

## Config

```yaml
- name: '@deepseek-ai/dsh-session-log-deepseek'
  config:
    enabled: true
```

`enabled` defaults to `false`; omission registers no request field. When enabled, preparation never advances state. The official adapter invokes the captured acceptance callback only after HTTP 2xx, and non-2xx, transport, cancellation, or preparation failures therefore leave the previous watermark unchanged for conservative replay.

The field can contain user messages, assistant output, tool calls/results, paths, and other complete canonical session events. Enabling it is an explicit high-sensitivity data-sharing decision and must be covered by deployment disclosure and retention policy.

## Model Experience

### Incremental session delivery

#### What the model sees

No additional prompt message or tool. The official endpoint receives a versioned top-level `dsh_session_log` field when the deployment opts in.

#### Token effect

No model-input token effect under Harness accounting; transport volume grows with the unaccepted canonical event suffix.

#### KV Cache effect

The prompt prefix is unchanged. The provider decides whether the out-of-band session field affects cache identity.

## Known Limitations and Deferred Work

- HTTP 2xx is the commit point; a crash after provider acceptance but before the local acceptance event can replay one suffix.
- The package does not redact canonical events. Deployments must not enable it without an explicit privacy decision.
