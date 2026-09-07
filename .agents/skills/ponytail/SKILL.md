---
name: ponytail
description: 代码精简与根因重构。用于编写、修复、重构或审查代码时，先复用现有实现、标准库和原生平台能力，再写能完整解决问题的最小改动；不删减安全、数据保护、错误处理、无障碍和用户明确要求。
user-invocable: true
---

# Ponytail · 代码精简与根因重构

这是 Ark 中处理代码任务的精简模式。目标不是代码高尔夫，而是在读懂真实链路后，用最少的新状态、最少的新文件和最少的新依赖解决根因。

## 模式路由

`/ponytail` 默认执行 full 模式；同一条请求可追加一个参数：

| 参数 | 行为 |
| --- | --- |
| `lite` | 完成用户要求，并用一句话指出更精简方案。 |
| `full` | 默认；严格执行下方决策顺序。 |
| `ultra` | 删除优先，只保留明确需要且有证据的实现。 |
| `review` | 读取 `modules/review/instructions.md`，审查当前 diff，不直接修改。 |
| `audit` | 读取 `modules/audit/instructions.md`，审查整个仓库，不直接修改。 |
| `debt` | 读取 `modules/debt/instructions.md`，收集精简债务标记。 |
| `gain` | 读取 `modules/gain/instructions.md`，显示可核验的上游 benchmark。 |
| `help` | 读取 `modules/help/instructions.md`。 |

Ark 不安装跨宿主 hooks，也不在后台持久化模式；每次显式调用只影响当前代码任务。

## 决策顺序

修改前按顺序判断，并在第一个足够完整的方案停止：

1. 这段新能力是否真的需要存在；纯推测需求不实现。
2. 代码库是否已有同一权威 owner、helper、type 或原生组件；有则复用。
3. 标准库或系统框架是否已经提供；优先采用。
4. 当前已安装依赖是否足够；不要为几行代码增加新依赖。
5. 最后才新增完成当前需求所必需的最小实现。

## Ark 约束

- Bug 必须修在所有调用者汇聚的权威层，不给每个按钮或页面重复打补丁。
- 删除重复状态、重复投影、死代码和无效包装，保留单一 owner。
- 不创建只有一个实现的协议、工厂或“以后可能用”的配置层。
- 不用缩短代码为理由牺牲：路径边界、原子写入、CAS 冲突、进程归属、生命周期、错误处理、无障碍、真实行为验收。
- 非平凡分支至少保留一个最小可运行 contract；完成仍需 targeted test、FULL_GATE 和 Native candidate 行为验证。
- 发现现有 dirty/untracked 代码时只修改当前授权范围，不清理、不覆盖、不重置。

## 输出

先给出可运行改动，再简短说明：复用了什么、删掉了什么、还剩什么可测条件。用户明确要求审计或详细报告时，报告不受简短输出限制。

## 来源

Adapted for Ark from Dietrich Gebert's Ponytail project, MIT License:
https://github.com/DietrichGebert/ponytail

Copyright (c) 2026 Dietrich Gebert. The upstream MIT license applies to adapted portions.
