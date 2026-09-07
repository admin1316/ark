# @deepseek-ai/dsh-host-directory-picker

[English](README.md) | 中文

宿主工作区目录选择是一项能力 seam。抽象的 `DirectoryPicker` 服务（`ctx.directoryPicker`）是其 Service Definition，原生后端（`-native`）在宿主屏幕上打开操作系统选择器。消费方按 `DirectoryPickerCapabilities` 可辨识映射分支；未知能力隐藏操作而不是失败。能力对象在服务生命周期内保持稳定。

原生选择器失败保持为带类型的错误，并由 Host API 边界映射。设计依据、与 `ctx.fs` 的切分、策略裁决见 [目录选择能力 seam Agent Note](../../../.agents/notes/implemented/architecture/2026-07-28-directory-picker-capability-seam.zh.md)。

## 模型体验

无。该 seam 服务于 GUI 宿主的目录选择；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **不支持多根目录**——浏览约定每次列举只公开一条祖先链；按部署限定可浏览根（以及在盘符根的上一级枚举 Windows 各盘符根目录）等到出现需要它的消费方再做，见 DirectoryPicker Agent Note。
