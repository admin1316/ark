# Agent Note：发送首条 prompt 前验证 Workspace 绑定

[English](2026-10-10-native-first-prompt-workspace-binding.md) | 中文

## 问题

在新对话 composer 中选定 Workspace，并不能证明 Host 会在该 Workspace 下创建 Session。如果返回的 Session 使用了其他工作目录，或 Workspace registry 并不拥有它，那么首条 prompt 就可能在错误项目中执行。

## 决策

发送首条 prompt 前，native client 会提交所选 `workspaceId`、刷新权威 Workspace 和 Session 列表，并检查该 Session 是否属于所选 Workspace、规范化后的 `cwd` 是否与 Workspace 路径一致。显式创建空 Session 时，导航前也会执行同一检查。若不一致则失败关闭：prompt 不发送，草稿和所选 Workspace 保留在界面上，composer 显示可执行的错误说明。由于 Host 已返回一个绑定错误的 Session，恢复草稿时会丢弃其创建 identity，使重试请求一个不同的 Session。

该检查验证 Host 所有权和工作目录元数据；它不会把文件读取限制在 Workspace 内。只读模式仍按既有策略限制写入操作。

## 验证

Native AppModel contract fixture 覆盖首条提交的 wire request、返回了错误 `cwd` 的 Session、正确注册的 Session、草稿保留、阻止 prompt 派发，以及重试前更换创建 identity。Jiuzhang Node 测试通过 97/97 项；native contract 可执行文件通过全部 53/53 个 contract group。

## 考虑过的替代方案

**只信任请求中的 `workspaceId`，不检查返回的 Session。** 请求可以正确，但持久化的 Session 元数据或 Workspace 成员关系仍可能出错，首个任务依旧会在项目范围外执行。

**先发送 prompt，再在 Host 刷新后报告不匹配。** 客户端发现问题前，模型可能已经读取或修改项目文件，因此派发后报告无法阻止越界操作。

**确认绑定失败后继续复用原创建 identity。** Host 已经用该 identity 创建了空 Session；重试时可能撞上原来那个绑定错误的 Session，而不是新建一个归属所选 Workspace 的 Session。

## 结果

新对话提交会多等待一次导航刷新后再派发。Host 返回的 Workspace 所有权或 `cwd` 不一致时，Ark 会保留用户草稿，并在重试前使用新的 Session identity。通过元数据检查不代表只读工具无法读取 Workspace 以外的文件；该保证需要单独设计文件系统边界并进行验收测试。
