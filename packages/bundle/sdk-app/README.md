# `@deepseek-ai/dsh-sdk-app`

English | [中文](README.zh.md)

SDK profile startup bundle for stdio JSON-RPC applications. The `sdk-app-startup` plugin parses the configured `dsh --profile <profile>` invocation, publishes `sdkAppStartup` after a successful parse, and binds stdin EOF to the launcher's bounded shutdown. The companion `sdk-jsonrpc-server` row waits for that latch and owns JSON-RPC transport; this package does not create a second session or transport implementation.

The shipped patch uses the `sdk` profile and keeps stdout reserved for JSON-RPC. Help exits without starting the transport, while a normal invocation stays alive until the SDK client closes stdin.

## Model Experience

### SDK persona

#### What the model sees

The bundle contributes one system-prompt persona line with the selected `model` and working directory `cwd` substitutions.

##### SDK persona text

```markdown
You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.
```

#### Token effect

The persona adds a small system-prompt prefix; its exact token count depends on the substituted model name and working directory.

#### KV Cache effect

The persona is prefix-stable for one process, but changing `model` or `cwd` changes the system-prompt prefix and can prevent reuse of that prefix.

## Known Limitations and Deferred Work

- Help is intentionally transport-free; an embedding client must invoke the configured profile rather than use the help path when it expects JSON-RPC frames.
- The process lifetime follows stdin EOF, so an embedding supervisor must keep stdin open for the session and let the companion `sdk-jsonrpc-server` own frame serialization.
