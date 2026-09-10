# `@deepseek-ai/dsh-sdk-app`

[English](README.md) | 中文

面向 stdio JSON-RPC 应用的 SDK profile 启动 bundle。`sdk-app-startup` 插件解析配置的 `dsh --profile <profile>` 调用，解析成功后发布 `sdkAppStartup`，并把 stdin EOF 绑定到启动器的有界退出。配套的 `sdk-jsonrpc-server` 行等待这个启动闩锁并负责 JSON-RPC 传输；本包不会建立第二套会话或传输实现。

随附 patch 使用 `sdk` profile，并保证 stdout 只用于 JSON-RPC。帮助路径不会启动传输；正常调用会持续运行，直到 SDK 客户端关闭 stdin。

## 模型体验

### SDK persona

#### 模型看到的内容

bundle 贡献一行系统提示 persona，并替换其中选定的 `model` 与工作目录 `cwd`。

##### SDK persona 文本

```markdown
You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.
```

#### Token 影响

该 persona 增加一个较短的系统提示前缀；确切 token 数量取决于替换后的模型名称和工作目录。

#### KV Cache 影响

同一进程内该 persona 的前缀保持稳定，但更换 `model` 或 `cwd` 会改变系统提示前缀，并可能阻止复用该前缀。

## 已知限制与暂缓事项

- 帮助路径有意不启动传输；需要 JSON-RPC 帧的嵌入客户端必须调用配置的 profile，而不能使用帮助路径。
- 进程生命周期跟随 stdin EOF，因此嵌入式启动器必须在会话期间保持 stdin 打开，并让配套的 `sdk-jsonrpc-server` 负责帧序列化。
