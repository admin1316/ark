---
description: "补充 provider 所有 settings 与凭据 Remote 方法的 Host 桌面操作。"
kind: "package-reference"
---
# Settings Controller

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-api-settings-controller` 只提供 settings namespace 的 Host 桌面操作：打开 settings 文档、查询 Agent preset 目录打开能力及打开该目录。通用 settings 与 credentials Remote 由各自 core provider 唯一持有，浏览器与 Native 复用同一份协议。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

请把本包作为 Loader entry 挂载到需要 Host 桌面操作的 profile 中。它只注册 `canOpenAgentPresetDirectory`、`openSettingsDocument` 与 `openAgentPresetDirectory`；不会再挂载凭据控制器或声明重复的读取、写入端点。`openSettingsDocument` 委托 core provider 的 `remoteOpenDocument`，复用绝对路径归属、取消信号及错误脱敏检查。

`settings.describe/update/replace/mutate` 归 `@deepseek-ai/dsh-settings` 所有，受领域事务保护的 namespace 不能通过通用 Remote 写入。`credentials.describe/set/unset` 归 `@deepseek-ai/dsh-credentials` 所有；describe 返回 `{ credentials: { [ref]: metadata } }`，最多 64 项，整批名字验证通过后才访问 provider。无效名字与超限批次返回 `input-invalid`，空值及 provider 拒绝返回 `credential-rejected`；错误不会反射 provider 的敏感诊断。缺少 core Service 的诊断由 Gateway 提供；本包独有操作仍保留可操作的缺 provider 错误。

`settings.openSettingsDocument()` 准备 provider 持有的文档，并用原生文本编辑器意图将其打开。`settings.canOpenAgentPresetDirectory()` 在 preset 页面显示时报告原生打开能力。`settings.openAgentPresetDirectory(id)` 只解析用户创作的 preset，并在原生打开不可用时返回目录路径；两个打开方法都不接受浏览器提供的文件系统目标。

-----

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `nativeOpen` | 平台探测 | Agent preset 目录能否交给原生桌面打开器 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-api-settings-controller)是所有受支持字段及其 JSDoc 的完整来源。

-----

<a id="model-experience"></a>
## 模型体验

无，因为 settings 与凭据配置属于浏览器和 Host 状态，并且不注册提示词、工具或会话事件。

#### KV Cache 影响

无直接影响；读取或写入这些配置值不会改变已经在途的模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 凭据批量策略归 core credential provider 所有，不由此桌面操作包配置。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
