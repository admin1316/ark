# Agent Note: Ark 产品身份

Status: implemented

[English](2026-08-15-ark-product-identity.md) | 中文

## 问题

产品界面仍残留上游归属（「基于 DeepSeek Harness 的 Ark」、字标里的 "DEEPSEEK HARNESS"、上游欢迎声明、带「九章天幕行业大脑」后缀的产品名），机器标识符也沿用旧产品目录名。产品应当只以 Ark 的身份出现。

## 决策

**用户可见的产品面只显示 Ark。** Web 标题、安装清单、字标（九章天幕 + ARK）、欢迎声明、上手引导、人设与预设描述不再提及框架。欢迎声明与上手引导变为品牌感知：客户端文案在运行时解析构建期写入的 `data-dsh-product-brand` 属性，默认 DeepSeek Harness 构建的文案保持逐字节不变（欢迎声明版本号已 bump，使新文案展示一次）。

**产品名延伸到机器标识符。** 默认产品数据 home 从 `~/Library/Application Support/九章天幕行业大脑/Harness` 迁至 `~/Library/Application Support/Ark/Harness`（启动器、Swift 壳契约、文档与 agent note 同步更新）；macOS 应用包可执行文件更名为 `Ark`。一次性 `migrateLegacyProductData` 把现存的旧 home 复制到新位置（权限、时间戳、会话、设置、凭据、附件、符号链接），在复制前拒绝内容冲突的目标项，保留源目录作为回滚副本，成功后写入标记使后续修改不再与之比对。`JIUZHANG_DSH_HOME` 覆盖路径保持隔离。Bundle ID 与旧应用名回归守卫保持不变。

**文档改为产品视角，工程细节独立成篇。** 根 README、贡献指南与集成层 README 呈现产品本身；构建、验证、打包、基线与布局细节移入 `integrations/jiuzhang/docs/engineering.md`。MIT 许可证与第三方声明原样保留（许可义务）。

## 曾考虑的替代方案

**只改显示名。** 否决：旧 home 路径会在下次启动时让全部已装状态（会话、设置、凭据）失联。

**用 rename 而非 copy 搬迁旧 home。** 否决：copy 保留源目录作回滚副本、不销毁数据；rename 不可逆。

## 后果

Ark 端到端只呈现自己的身份，框架基线仍记录在工程说明中供维护者查阅。全新安装与迁移安装都落在 Ark home；运行中的 GUI 在刷新后即加载新文案（插件包 no-cache）。在旧 home 已不存在的机器上，一次性迁移为空操作。
