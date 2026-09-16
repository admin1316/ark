# Agent Note: 插件拥有的设置公开边界

Status: implemented

[English](2026-08-12-plugin-owned-settings-surface.md) | 中文

## 问题

在 Settings 注册与 Remote 消费方之间增加命名空间白名单，会让第三方配置依赖插件属主之外的修改。独立列表可能偏离存活注册表，而在 Settings 服务中声明页面信息，又会让单个消费方支配共享能力约定。

## 决策

**注册使命名空间可被描述。**[`SettingsStore.remoteDescribe()`](../../../../packages/settings/settings/src/index.ts) 通过 `describe({ redactSecrets: true })` 返回所有存活注册的命名空间，不查询第二份产品命名空间列表。未知命名空间与被拒绝的修改保留 Settings 属主的失败语义。注册不绕过 schema 校验、提供方可写性、版本检查、激活或字段级机密投影。

**展示由消费方负责。**Settings 注册不携带浏览器插槽、页面名称或表单卡片声明。Ark 的 [`ArkPluginSettingsAPI`](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellCore/ArkPluginSettingsAPI.swift) 从共享描述符解码受支持的原生插件面板。公开命名空间不代表 Ark 承诺为其提供可视编辑器。原生消费方负责受支持的控件、暂存与版本隔离；服务负责值与修改。

[通用 Web UI 退役决策](../simplification/2026-08-29-retire-generic-web-ui.zh.md) 移除了动态浏览器卡片与插槽实现，但没有推翻单次注册的公开规则。原生设置面板不是恢复的 `dsh.client` 插件，外部插件不能向 Ark 安装浏览器卡片。

## 信任边界

命名空间白名单确实能阻止整层 resolved、base 与 user 值公开；仅含元数据的插件清单从来不是等价的保密边界。保留的设计将实际边界放在 [`Host Connection`](../../../../packages/host/connection/src/index.ts) 的特权 Settings 路由与 Settings 脱敏器中。原生配置流量必须满足载体的 loopback 与请求来源校验。能够编辑用户拥有的文档，不等于允许在线路上披露机密值。

每个返回层与 schema 默认值都经过保守的[机密投影](../../../../packages/settings/settings/src/redact.ts)。[Native Settings 所有权决策](../bug-fix/2026-09-09-native-settings-ownership-and-redaction.zh.md) 负责 union/intersection 遍历、默认值脱敏、畸形机密容器拒绝与不支持的机密 schema 拒绝。未标记字段不会自动成为机密；插件作者仍负责正确的 schema role。

## 考虑过的替代方案

**在 `settings.register()` 上声明页面。**这会把展示名称、标题与位置混入多个消费方使用的服务；同一命名空间不应要求浏览器形状的服务约定。

**独立的公开目录。**插件可能注册命名空间却忘记第二份目录。一个事实需要两次注册，也没有可靠信号区分意外遗漏与故意隐藏。

**没有消费方的命名空间拒绝列表。**当前没有消费方需要它；字段级机密 role 是受支持的保密机制。未来部署级披露策略需要明确的消费方与威胁模型。

**为每个命名空间自动生成通用表单。**描述符不是完整的交互约定。Ark 使用明确受支持的原生控件；仅有 schema 元数据不能承诺安全暂存、机密替换或易懂的恢复流程。

**第二份 UI 声明注册表或无序卡片列表。**两者都重复消费方实际支持的控件，并可能偏离为重复或空白展示。原生 Settings 消费方不需要它们。

## 影响

新的 Host 命名空间无需修改专用传输源码即可参与共享 Settings API。其原生编辑体验仍是独立的消费方决策。即使没有可视面板，API 也保留脱敏与修改所有权。未来动态原生扩展 UI 需要自己的组合与交互验收；已退役的浏览器卡片测试不能证明该能力。

## 验证

Settings 包的脱敏与 Native Remote 测试覆盖公开命名空间、版本及受保护值；[`ArkSettingsContractChecks`](../../../../integrations/jiuzhang/native/Tests/JiuzhangShellCoreTests/ArkSettingsContractChecks.swift) 覆盖原生约定。源码与约定检查不能替代真实 App 交互或发布验收。
