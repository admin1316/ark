# `@deepseek-ai/dsh-profile-runner`

[English](README.md) | 中文

供 dsh 可执行应用复用的 profile 生命周期。`runProfile()` 根据调用方显式提供的 `installAnchor` 组合 bundle 层、profile 与 home patch、命令行 overlay、遥测策略、失败即停启动和有界退出。通用应用默认保留 patch 热监视；受管应用设置 `watchLiveConfig: false`。

本包也是 Native-safe 的 `standard`、`code`、`minimal` 三套系统 preset 的唯一发布真源。应用可通过 `additionalSystemPresetRoots` 增加独立系统根；通用 CLI 用该入口装入 CLI-only 的 `cordis` preset，不复制共享资产。

## 模型体验

### 所选系统 preset

#### 模型看到的内容

runner 不增加面向模型的内容。应用所选的 `standard`、`code` 或 `minimal` preset 负责会话的 prompt section 与工具，包括该 preset 挂载的插件贡献的文字。

#### Token 影响

这是间接且取决于 preset 的影响：请求大小由所选 preset 的 prompt 和工具描述决定。

#### KV Cache 影响

runner 保留所选 preset 的请求前缀；更换 profile、preset 或挂载的插件配置可能使该前缀的复用失效。

## 已知限制与延期工作

- 实时 patch 监视属于进程级能力，仅面向通用 CLI 应用；受管产品必须显式关闭。
- 额外系统根必须使用唯一 preset id，因为两个系统 owner 不能定义同一个随附 preset。
