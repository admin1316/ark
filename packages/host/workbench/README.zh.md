# @deepseek-ai/dsh-host-workbench

[English](README.md) | 中文

Ark 无内嵌网页 Workbench 阅读器的仅限 Host Typert Remote owner。`WorkbenchRemoteService` 只注册 `workbench/webRead`；Files 树与文件读取保留在既有的原生 descriptor 约束 owner 中，Git 由原生 Review 负责。Host 方法接收一个严格的 `request` 对象，以及由 Gateway 注入的 `AbortSignal`。

本包直接拥有文件系统与 Git 原语。它会在任何文件系统访问前校验严格斜杠 Remote 请求，规范化 root 与子路径，保持 root 边界和有界读取策略，并抛出一个带类型的 Typert 失败，使 Gateway 只生成一层 `RemoteResult`。

## 迁移边界

本包现在是四个 Workbench 操作的权威 owner。父级集成需要让临时兼容表面委托给此 owner、重新生成严格 Remote 产物，再删除那条已退役表面及其路由。Native 组合和运行时闭包删除仍由父任务负责。

## 安全与行为

- root 必须先是本包严格 schema 接受的非空路径，再由权威 owner 验证为现有的绝对目录。
- 请求路径会在该 root 下规范化；逃逸的符号链接以 `workbench-error` 和 `outside-root` 原因失败。
- 文件读取有大小上限并区分二进制；目录列表不会跟随子符号链接。
- Git 状态和差异只在请求 root 正好是仓库顶层时运行；差异读取不修改仓库，且 `staged` 必须显式提供。
- 调用方的 `AbortSignal` 原样传递；`cancelled` 与 `workbench-error` 失败只在严格 Remote 边界生成一次。

## 模型体验

### Native Workbench 读取面

#### 模型看到的内容

无。`workbench/webRead` 是仅限 Host 的浏览器阅读器，不注册提示词、工具、消息、文件系统 owner、模型提供方或模型请求。

#### Token 影响

不直接影响 token；本包不会组装模型输入。

#### KV Cache 影响

Workbench 读取不会修改模型输入，因此不独立影响模型内容缓存。

## 已知限制与暂缓工作

- 父级集成仍需重定向并删除临时兼容表面、更新 Gateway 描述符并刷新运行时 receipt。
- 本实现线不把包挂入 Native bundle，也不修改中央 Gateway 路由表。
