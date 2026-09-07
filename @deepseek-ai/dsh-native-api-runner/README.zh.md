# `@deepseek-ai/dsh-native-api-runner`

[English](README.md) | 中文

Ark 受管 Native API sidecar 的专用可执行入口。`lib/bin.js` 只能启动 `jiuzhang` profile，只接收该 profile 的应用参数，不接受任意 overlay，并关闭 profile 实时监视。其安装 manifest 持有 `dsh-base`、`dsh-native-api-app`、共享 profile runner 与 Ark 专用知识工具；dependencies、optionalDependencies、peerDependencies 均不指向通用 `@deepseek-ai/dsh` CLI、Web/headless 产品或任何 `dsh-client-*` 包。

## 模型体验

### 受管 Native profile

#### 模型看到的内容

runner 不增加面向模型的文字或工具 schema。挂载的 `jiuzhang` profile 与共享 preset 负责提供 Agent 接收的 prompt section 和工具。

#### Token 影响

runner 本身不直接影响 token；模型请求内容由所选 profile 与 preset 决定。

#### KV Cache 影响

在挂载的 profile 或 preset 改变 Agent 的 prompt 前缀之前，本 runner 不独立影响模型内容缓存。

## 已知限制与延期工作

- runner 有意不提供插件管理、配置导出、Web alias 或任意 profile 选择命令。
- runtime 组装必须在打包 Ark.app 前为封闭安装图提供全部必需 peer。
