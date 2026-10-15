---
description: "供 dsh 可执行应用复用的 profile 生命周期。"
kind: "package-library"
---

# `@deepseek-ai/dsh-profile-runner`

[English](README.md) | 中文

## 概述

供 dsh 可执行应用复用的 profile 生命周期。`runProfile()` 根据调用方显式提供的 `installAnchor` 组合 bundle 层、profile 与 home patch、命令行 overlay、遥测策略、失败即停启动和有界退出。通用应用默认保留 patch 热监视；受管应用设置 `watchLiveConfig: false`。

可选参数 `RunProfileOptions.shutdownOnParentDisconnect` 默认关闭。在 Node IPC 子进程中启用它的应用，会在 profile 准备前及插件树启动期间观察父连接断开。断开会中止启动，加入既有的五秒 shutdown owner，并在 dispose 后请求进程退出；失败或超时保留非零结果。该监听由进程持有，在正常插件树 dispose 后仍保留，以便后续父进程丢失时结束剩余句柄。IPC channel 不保持引用，使正常完成仍可自然退出；显式信号先移除监听，再使用既有的信号升级路径。没有 IPC 的直接调用不安装此监听。

本包也是 Native-safe 的 `standard`、`code`、`minimal` 三套系统 preset 的唯一发布真源。应用可通过 `additionalSystemPresetRoots` 增加独立系统根；通用 CLI 用该入口装入 CLI-only 的 `cordis` preset，不复制共享资产。

## 目录

- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="model-experience"></a>
## 模型体验

### 所选系统 preset

#### 模型看到的内容

runner 不增加面向模型的内容。应用所选的 `standard`、`code` 或 `minimal` preset 负责会话的 prompt section 与工具，包括该 preset 挂载的插件贡献的文字。

#### Token 影响

这是间接且取决于 preset 的影响：请求大小由所选 preset 的 prompt 和工具描述决定。

#### KV Cache 影响

runner 保留所选 preset 的请求前缀；更换 profile、preset 或挂载的插件配置可能使该前缀的复用失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 实时 patch 监视属于进程级能力，仅面向通用 CLI 应用；受管产品必须显式关闭。
- 额外系统根必须使用唯一 preset id，因为两个系统 owner 不能定义同一个随附 preset。

<a id="dev-note"></a>
### 开发备注

无。
