# @deepseek-ai/dsh-deepseek-llm-api-extensions

English | [中文](README.zh.md)

Effect-scoped registry for independent top-level fields on official DeepSeek requests. A contributor owns one declaration-merged field, prepares its detached JSON value before dispatch, and may provide an acceptance callback that the DeepSeek adapter commits only after an HTTP 2xx response.

Preparation runs against the exact serialized base request. The registry structured-clones and recursively freezes every contributed value, rejects duplicate field owners, stops waiting after cancellation, and makes the joint acceptance transaction idempotent. All acceptance callbacks settle before one failure or `AggregateError` is reported.

## Model Experience

### Provider request extensions

#### What the model sees

The registry itself contributes nothing. Mounted providers may add provider-specific top-level JSON fields such as `dsh_plugin_packages`; they do not become prompt messages or tool schemas unless the provider separately defines that behavior.

#### Token effect

None from the registry. A provider-defined field is outside the harness prompt-token accounting unless the remote API documents otherwise.

#### KV Cache effect

The registry preserves the serialized prompt body. Provider-defined metadata may affect a remote cache only according to that provider's API contract.

## Known Limitations and Deferred Work

- Only the official DeepSeek adapter consumes this registry.
- Acceptance proves HTTP 2xx delivery, not downstream retention beyond the provider endpoint.
