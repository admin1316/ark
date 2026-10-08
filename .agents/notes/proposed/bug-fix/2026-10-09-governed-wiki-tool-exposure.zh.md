# Agent Note: 只宣告已组合的受治理 Wiki 工具目录

Status: proposed

[English](2026-10-09-governed-wiki-tool-exposure.md) | 中文

## 问题

Ark 可以在没有 trusted verifier 的情况下加载 Knowledge Wiki 服务。面向模型的消费方仍宣告全部七个工具，并指示模型使用受治理的读取和候选验证。真实候选任务因此会为缺少 authority 而被服务拒绝的工具消耗请求。禁用整个消费方又会移除独立的持久摄取路径。

## 提案

[工具消费方](../../../../packages/host/knowledge-wiki-tools/README.zh.md#configuration)接受可选的严格布尔值 `exposeGovernedTools`，默认为 `true`，保留现有组合的行为。`false` 省略五个受治理的读取工具和候选验证，注册原有摄取消费方，并只宣告摄取。`true` 保留工具目录和全部服务执行检查。工具目录暴露始终不能提供 verifier authority、签名准入、successful-use 信用或 trial 授权。

[Ark profile](../../../../integrations/jiuzhang/profile/cordis.patch.yml)依据与知识服务相同的启动器自有 `ARK_KNOWLEDGE_VERIFIER_CONFIG` 字符串选择暴露状态，将缺失值和仅含空白的值视为未提供。非空但无效的配置保留服务的加载失败。启动器、模型路由、权限、会话格式和验证门槛保持不变。

本提案补充[受治理知识决策](../../implemented/architecture/2026-10-07-knowledge-governance-and-rust-evidence.zh.md)，不替代其 authority 或学习要求。

## 考虑过的替代方案

**禁用整个工具插件。** 即使持久队列 owner 仍可用，该方案也会移除来源摄取。

**允许未认证的读取。** 该方案为掩盖工具目录缺陷而削弱知识服务的来源和范围检查。

**新增通用注册表就绪 API。** 已观察到的部署只有一个明确的启动器自有选择；扩展核心注册表会增加跨包约定，却不能解决 authority 问题。

## 验收标准

缺省配置和显式 `true` 保留七个工具的顺序及现有治理拒绝。`false` 只暴露摄取，保留其原有队列调用及输出，并省略读取和验证提示词。非布尔输入在注册前失败。卸载会移除工具和提示词。真实 YAML 加载和可运行的无密钥组装 transcript（文本记录）覆盖 false 部署，现有治理 transcript 和拒绝测试保持不变。重新构建的隔离 Native 候选必须展示修正后的模型请求，并完成同模型任务，之后才能考虑晋级。

## 风险

工具目录选择在插件加载时捕获；部署配置改变后需要重新加载。非空验证器字符串表示配置存在，不能证明 authority 有效或知识可被准入。显式 `true` 仍可能暴露会拒绝某项操作的工具。本改动不实现学习激活、修复复用或性能提升。
