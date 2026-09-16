---
description: "本组包含使用仓库真实运行时、但不进入正式发布的原型与内部专用 Cordis 插件。"
kind: "package-group"
---

# experimental/：私有实验性包

[English](README.md) | 中文

本组包含使用仓库真实运行时、但不进入正式发布的原型与内部专用 Cordis 插件。组内包均为私有包，不承诺稳定性或支持，但仍须满足与发布包相同的工程、安全、文档、生命周期、测试和快照要求。

[子树规则](AGENTS.md)规定依赖隔离、发布排除与 promotion。

保留的原型包括 [Agent Team](agent-team/README.zh.md)、其[工具](tool-agent-team/README.zh.md)和 [profile](agent-team-profile/README.zh.md)，以及 [Host Inspector](inspector/README.zh.md)。各包 README 定义各自约定；[运行时扩展参考](../../docs/subsystems/extensions.zh.md)说明共享的检查与生命周期概念。
