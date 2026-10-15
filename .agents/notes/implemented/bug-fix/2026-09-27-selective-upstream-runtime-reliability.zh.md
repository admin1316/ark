# Agent Note: 选择性移植上游运行时可靠性修复

Status: implemented

[English](2026-09-27-selective-upstream-runtime-reliability.md) | 中文

## Problem

Ark 的原生消费方和持久化会话模型与当前上游 Harness 存在差异。整体替换运行时会把无关的会话、产品和隐私变更，与工具输出边界、压缩预算、子进程输出存储及崩溃持锁者的修复混在一起。这些缺陷也属于共享实现；另外添加界面刷新补丁无法修复它们。

## Decision

源码参考为上游 [dsh-v0.1.7-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2)，提交 `477b4f420553e8a52c2fbccc464d7561b239c443`。Ark 在现有负责模块中适配四项独立修复，保留包版本、原生界面、会话格式及默认关闭的会话日志上传。

- **字符上限：**[`dc07e5a50d`](https://github.com/deepseek-ai/deepseek-harness/commit/dc07e5a50dadcf03e3fb9e1b7c69bb2ba9550254) 及其审查修正 [`223ad4c373`](https://github.com/deepseek-ai/deepseek-harness/commit/223ad4c373945004f0ad64a498d7369a524ef360) 提供代理对边界规则。现有[输出保留库](../../../../packages/util/output-retention/README.zh.md) 负责持久 Bash、持久 PowerShell 和字符串编辑器共用的辅助函数。截断可额外省略一个 UTF-16 代码单元来保留完整代理对，但绝不超过配置上限。
- **压缩预算：**上游 [PR（Pull Request）4530](https://github.com/deepseek-ai/deepseek-harness/pull/4530) 提供输出预留机制。[压缩提供者](../../../../packages/compaction/compaction-basic/README.zh.md) 将压力阈值限制为上下文窗口减去有效请求输出上限，并按剩余预算计算比例形式的历史保留量。Ark 保留摘要上限及小窗口行为，不引入上游固定 64K 余量默认值。[路由策略决策](../architecture/2026-07-20-routed-model-context-and-compaction-policy.zh.md) 仍负责路由和可选组合。
- **子进程 spill 失败：**[`cfa84ed4e3`](https://github.com/deepseek-ai/deepseek-harness/commit/cfa84ed4e373a2cd8f0068c5169cffeb24e17789) 提供失败隔离。Ark 保留现有[收集器](../../../../packages/subprocess/subprocess-local/README.zh.md)，不引入上游进程绑定重构。打开或写入失败会禁用可选 spill、撤回其路径并报告一次，同时继续收集有界尾部。报告器异常也受到隔离。
- **已退出的持锁者：**[`7e7ba139fd`](https://github.com/deepseek-ai/deepseek-harness/commit/7e7ba139fd5191ec09e310f164661c90512a6289)、[`910711e6c1`](https://github.com/deepseek-ai/deepseek-harness/commit/910711e6c14c84984d5301a3a178368c9cde2533) 和 [`1bd3df926d`](https://github.com/deepseek-ai/deepseek-harness/commit/1bd3df926d20cb0a15777bca89011534155133b5) 提供最终兼容 PID 格式的恢复机制。[原子写辅助函数](../../../../packages/util/atomic-write/README.zh.md) 在接管声明保护下重新核对合法记录对应的持锁者确已退出。Ark 还在释放前核对持有的文件身份及记录，从而保留已被替换的锁。这更新了 [JSONL 加锁决策](2026-08-16-p0-d-jsonl-cross-process-lock.zh.md) 中的共享恢复部分；按会话管理修改操作的职责不变。

Ark 还仅在独占创建成功后才将临时输出路径视为自己拥有。spill 收集器和原子替换都会保留已存在的冲突目标；原子清理失败仍保留原始写入错误。这些归属保护属于本地加固，不代表上游发布已包含它们。

## Alternatives considered

**升级到完整上游发布。** 否决，因为上游较新的持久化投影、会话格式、应用界面及账户默认值属于独立迁移。Ark 导入的历史与该上游标签没有共同祖先；版本标记不能证明兼容性。

**在原生视图或各个设置消费方内重复修复。** 否决，因为受影响的调用方已经汇聚到保留的负责模块。字符辅助函数只增加内部工作区引用，没有外部依赖。

**引入固定 64K 压缩余量及新上传默认值。** 本轮否决：固定余量会改变小窗口策略，超大请求扩展修复主要涉及可选上传或扩展字段。两者都不能证明原生滚动或显示停更的根因。Ark 明确保留默认关闭的上传设置。

**按锁的年龄恢复或删除所有遗留接管声明。** 否决，因为时间不能证明持锁者已退出。不完整记录、存活或无法探测的持锁者，以及遗留接管声明都采取保守失败。恢复机制绝不操作 Git 索引锁。

## Consequences

这些变更减少特定的字符破坏、溢出、崩溃及遗留锁故障，不代表渲染更快、模型推理更强或所有长对话故障都已修复。子进程 spill 丢失意味着无法恢复保留尾部之外的完整输出。接管声明持有者退出仍可能遗留需要人工调查的声明；PID 复用会保守阻止接管，释放身份检查也无法对任意外部替换提供原子的比较后删除保证。

回归证据区分旧源码失败与修复后行为。真实终端组合、独立竞争进程和无需密钥的可运行会话快照覆盖受影响的执行路径。原生候选验收及发布回执与源码测试分开；移植本身不修改正式安装或用户数据。

输出保留、适配器默认值、路由策略和 JSONL 记录继续保持有效，因为其职责及否决方案依据仍适用。本记录只部分更新预算和恢复行为，不替代这些独立决策。
