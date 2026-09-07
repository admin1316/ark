# Ark 产品目标（受版本控制）

本文件是 Ark 产品的目标声明，优先级高于任何历史产品描述。工作区副本见 `PERSISTENT_PROJECT_GOAL.md`，两者不一致时以本文件为准。

## 产品

- **Ark 是一个全新的本地优先 AI 助手**（产品名 Ark，短品牌名 九章天幕）。
- 会话、设置、凭据与附件保存在用户本机；模型推理由用户配置的提供方执行（可选本地或云端模型）。
- 出厂默认：纯对话预设（Ark preset，仅 persona）+ 只读权限；用户可主动更改，改动可回滚。

## 工程

- 产品层位于本目录（预设、profile、启动器、macOS 包装、契约测试）。
- 工程细节见 [engineering.md](engineering.md)；私有回滚备份在 GitHub 私有仓库 `admin1316/ark`。
- 改动必须通过 `pnpm run test:jiuzhang`、`pnpm audit --prod`、翻译配对与 agent note 校验。

## 边界（不得带入）

- 旧「九章天幕行业大脑」只作为数据迁移来源存在，不是当前产品定义。
- 不得把旧知识图谱、小红书（XHS）内容目标、旧品牌文案带入 Ark 的产品验收。
