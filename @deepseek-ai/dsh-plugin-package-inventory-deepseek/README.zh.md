# @deepseek-ai/dsh-plugin-package-inventory-deepseek

[English](README.md) | 中文

向官方 DeepSeek 请求报告活跃 Loader 插件准确包名与版本的扩展。它读取实时根 Loader tree 与目标会话已挂载的 Agent preset，排除结构 group、禁用 entry、非 active fiber，以及没有 package manifest 的 loose module，再生成顺序确定、去重后的 `dsh_plugin_packages` 列表。

## 配置

```yaml
- name: '@deepseek-ai/dsh-plugin-package-inventory-deepseek'
  config:
    enabled: false
```

`enabled` 默认为 `true`。设为 `false` 时会在注册前直接返回，因此不会准备或发送 inventory 字段。该字段只含包名与版本，不包含文件系统路径、插件配置、凭据或模块源码。

## 模型体验

### 活跃插件包清单

#### 模型看到什么

不会增加提示内容或工具 schema。启用后，官方 DeepSeek 端点会收到一个带版本的顶层 `dsh_plugin_packages` 包清单。

#### Token 影响

按照 Harness 的计量约定，不增加模型输入 token。

#### KV Cache 影响

提示前缀不变。请求体之外的元数据是否参与缓存身份，由提供方决定。

## 已知限制与暂缓事项

- 包身份在进程生命周期内缓存；不支持进程内替换包版本。
- 配置为 `deepseek-official` 的兼容网关会收到相同字段，因为端点信任属于该 route 的部署配置。
