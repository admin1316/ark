# Agent Note: 九章天幕产品 profile

Status: implemented

[English](2026-08-14-jiuzhang-product-profile.md) | 中文

## 问题

九章天幕需要以 DeepSeek Harness 为起点，但不应恢复已删除的 Ark 实现，也不应把 Harness fork 成第二棵应用目录树。共用普通 Harness home 会把产品状态与无关会话混在一起；选择已附带的编程 preset 则会重新引入空产品基线之外的模型工具与职责。桌面包装层还必须明确说明，它包含完整运行时，还是只负责启动 checkout。

## 决策

**九章天幕是覆盖在一个固定上游基线之上的集成层。** 引入的运行时是上游 commit `47f943859bef60e4160492346772ded9b24f765a` 对应的 DeepSeek Harness `0.1.0-rc.5`。`integrations/jiuzhang` 只持有产品 profile、Agent Preset、安装器、启动器、测试与面向用户的集成文档；Harness 框架与包图不会被 fork。一个受测的构建时产品品牌选择器会提供九章天幕标题与字标，同时保持默认 DeepSeek Harness 构建不变。

**产品拥有专用 Harness home。** 默认位置是 `~/Library/Application Support/Ark/Harness`，也可用绝对路径的 `JIUZHANG_DSH_HOME` 做隔离验证。默认启动会把现存的 `~/Library/Application Support/九章天幕行业大脑/Harness` 目录树一次性复制到该 home，包括会话、设置、托管凭据、附件、权限、时间戳与符号链接。迁移会在复制前拒绝存在不同内容的目标项，保留源目录作为回滚副本，并在成功后写入目标标记，使后续修改不再与该副本比较。随后，安装只创建缺失的 profile 与 preset 文件，后续启动会保留用户修改。这项指定数据 home 迁移不导入任何早期 Ark 数据库、PDF、知识库、训练语料或学习状态。Harness 正常使用可在该专用 home 中创建新的设置、托管凭据、附件与 JSONL 会话记录。

**随产品提供的默认项是一个 complete 的纯 persona Agent Preset。** profile 组合官方 base 与 Web bundle，选择 `jiuzhang`；preset 只挂载 `@deepseek-ai/dsh-persona`，设置 `complete: true`，并禁用运行时上下文注入。Harness 运行所需的宿主插件可保持加载，但模型不会通过该 preset 获得 shell、文件系统、web、skill、subagent、workflow 或其他工具。持久用户设置可以主动选择另一套默认 Agent Preset；启动时会保留该选择。

**本地默认值尽量减少环境副作用。** 启动器把进程权限后备值设为 `read-only`；已保存的 Harness 设置仍可为后续 Web 会话选择权限 preset，而 complete Agent Preset 仍不向模型暴露工具。profile 配置行与环境变量同时禁用会话 telemetry。SQLite 会话搜索通过 `path: ':memory:'` 与 `openAt: never` 保持未打开，因此该 profile 不会创建搜索数据库。

**桌面包装层保持轻量。** 它可以从源码 checkout 或单独组装的独立运行时启动已构建 CLI。应用包会记录所选布局与兼容的 Node.js 可执行文件；移动任一已记录依赖后，启动会失败，直到重新构建包装层。包装层不会再嵌入一棵 Harness 源码树或 Node 运行时。

**模型就绪状态仍需独立验证。** 九章天幕不携带 API key。构建成功、本地 HTTP 响应或可见 Web UI 只能证明本地运行链路；真实模型对话需要配置受支持的提供方与凭据，并必须单独验证。

## 曾考虑的替代方案

**恢复早期 Ark 代码、数据库、PDF 或知识目录。** 不采用：产品从全新设计边界起步，这些资产会悄然重新引入已删除的范围与未经审查的状态。

**在九章天幕应用目录树下复制或重写 Harness 包。** 不采用：第二份实现会增加源码重量、复制上游行为，并让上游修复更难被吸收。

**复用普通 `~/.dsh` home。** 不采用：九章天幕的会话、设置、凭据与 profile 编辑会与其他 Harness 用途无法区分。

**只重命名默认 home，不提供启动迁移。** 不采用：已安装产品持有会话、设置与凭据引用时，改变机器标识会使这些状态失联，或诱发不安全的运行中移动。使用前复制、冲突拒绝并保留源目录可以提供回滚路径，避免静默替换。

**使用已附带的编程 preset，只依赖 `read-only`。** 不采用：文件系统权限模式不会移除模型可见工具，也不会移除它们的非文件系统副作用。complete 纯 persona preset 直接提供更小的能力集。

**在首个桌面版本中将完整仓库与 Node 运行时一起打包。** 不采用：这会在本地运行与模型链路完成验证之前，就把首次集成变成一个庞大的独立发行版。轻量启动器使依赖关系可见；自包含打包保持为独立事项。

## 后果

九章天幕可使用持续维护的 Harness Web 与会话基础设施，同时把随产品提供的默认模型能力限于纯对话，并与普通 Harness 用途隔离状态。数据 home 重命名会保留一份回滚副本，直到用户主动删除；发生冲突时，启动会停止，而不会擅自选择其中一个版本。源码 checkout 仍是开发输入；已安装的独立运行时可以让应用启动不再依赖源码，同时不复制框架源码。产品专用代码保持精简，不 fork 上游包。本集成不提供知识，也不声称实现自动学习；这些能力需要后续由证据治理的产品决策。无 key 测试可以证明组合、迁移、安装、保留、冲突拒绝、telemetry 设置与旧资产未导入；提供方支持的对话以及任何桌面打包声明都需要各自的运行证据。
