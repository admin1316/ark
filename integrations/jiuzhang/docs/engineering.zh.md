# 工程说明

[English](engineering.md) | 中文

面向维护者的构建、验证与打包说明。产品信息见[产品 README](../README.zh.md)。

## 基线

产品层构建在一个固定的上游基线之上：commit `47f943859bef60e4160492346772ded9b24f765a`（版本 `0.1.0-rc.5`，MIT 许可）。集成直接使用该 checkout 构建出的 CLI，不 fork 其包图；升级与回滚通过 git 历史完成。第三方许可证见仓库的 [THIRD_PARTY_NOTICES.md](../../../THIRD_PARTY_NOTICES.md)。

## 布局

同一对启动器（`src/start.mjs` + `src/runtime.mjs`）同时服务两种布局，加载时按自身位置识别：

- **源码 checkout**：启动器位于 `integrations/jiuzhang/src/`，产品文件位于 `integrations/jiuzhang/profile`，Ark runner 构建于 `packages/boot/native-api-runner/lib/bin.js`，子进程工作目录为仓库根。
- **独立运行时**：启动器与 `runtime-closure.mjs` 位于运行时根目录，旁边是 `jiuzhang/` 产品文件目录与 `node_modules/@deepseek-ai/dsh-native-api-runner/lib/bin.js`，子进程工作目录为运行时根。macOS 应用以 `JiuzhangRuntimeRoot` 记录该目录。

## 安装行为

向默认 home 安装运行时配置之前，`migrateLegacyProductData` 会把现存的 `~/Library/Application Support/九章天幕行业大脑/Harness` 目录树复制到 `~/Library/Application Support/Ark/Harness`。它保留文件权限与时间戳、会话、设置、托管凭据、附件和符号链接；保留源目录；在复制成功后写入标记，使后续用户修改不再与回滚副本比较；当目标位置已有不同内容时，在复制前失败。`JIUZHANG_DSH_HOME` 覆盖路径保持隔离，不触发此次迁移。

`installRuntimeConfiguration` 只把三个 Ark 自有产品文件（`profile/package.json`、`profile/cordis.patch.yml`、`profile/pnpm-workspace.yaml`）协调到产品 home。它拒绝链接、共享或 group/world-writable 的所有权路径；把任何漂移内容寻址到经过验证的 owner-only 回滚；并且只原子替换已经比对的字节。用户设置位于此托管 profile 之外。源目录中的其他内容不会泄漏进产品 home（测试强制）。

## 构建与运行（源码布局）

```sh
pnpm install --frozen-lockfile
pnpm run build
node integrations/jiuzhang/src/start.mjs --port 0
```

启动器把进程权限后备值设为 `read-only` 并禁用遥测；已保存的用户设置仍然优先。profile 组合 `@deepseek-ai/dsh-base` 与 API-only 的 `@deepseek-ai/dsh-native-api-app`，禁用 OpenTelemetry 会话插件，并保持 SQLite 会话查询提供方关闭（`path: ':memory:'`、`openAt: never`）。

## 验证

```sh
pnpm run test:jiuzhang                       # profile, launcher, and native application contracts
pnpm run verify-translation-pairing          # bilingual doc pairs
pnpm run verify-agent-note-format            # agent note format
```

已登记的 Node 运行器要求先构建 Ark 入口（先运行 `pnpm run build`）。`node integrations/jiuzhang/tests/run.mjs --node-only` 执行适用于当前平台的 Node 测试；`--inventory-only` 拒绝缺失、重复或未登记的测试文件。默认运行器还会在 macOS 上构建并执行原生契约。产品控件保持原生；只有 Workbench 浏览器通过 WebKit 渲染外部 HTTP(S) 页面，不提供通向 Ark 凭据、工具或本地文件的桥接。

必需的 [CI 工作流](../../../.github/workflows/ci.yml)分别执行 Ark 可移植回归、Swift 原生契约和 macOS 打包／安装 smoke。可移植任务先构建 host 输出再运行测试；macOS smoke 构建并封存当前源码的运行时，使用临时数据组装一个隔离候选，再调用安装态测试。测试失败、任务跳过或取消都会使汇总结果失败。这些任务不证明人工原生交互通过，也不授权安装正式应用。

## 知识连接与恢复

`knowledge-wiki` 设置命名空间使用现有的修订号／CAS 服务，包含八个字段：

| 路由 | 字段 | 未配置时的行为 |
|---|---|---|
| 文本分析与研究 | `textProvider`, `textModel` | 显式选择已注册的 LLM（大语言模型）路由；启用时两个字段都必填。 |
| 图片说明 | `visionProvider`, `visionModel` | 两项都为空时保留本地媒体，并返回警告。 |
| 向量检索 | `embeddingProvider`, `embeddingBaseUrl`, `embeddingModel`, `embeddingCredential` | 全部为空时使用本地关键词检索；启用时要求完整路由和独立凭据引用。 |

原生设置 → 模型编辑这些选择；凭据值进入钥匙串，不进入路由设置。文本和图片调用复用已注册提供方，包括其端点和协议。每个多阶段操作在第一次请求前准备模型调用；凭据值轮换仍由提供方拥有。项目操作携带注册表给出的不透明 `projectContext`，因此界面切换不会重定向已经接收的操作。Host 重启后项目身份失效。[知识引擎](../../../packages/host/knowledge-wiki/README.zh.md)拥有格式限制、关键词回退、项目撤销和零来源研究行为。

普通提示词发送前，输入框会写入有界、仅属主可访问的草稿与附件日志，完成文件同步、原子发布和目录同步。Host 等待收件箱事件进入持久存储后才确认接收；调用身份和内容摘要使结果不明的重试去重，包括冷会话。确认仅清除匹配的草稿修订号与内容。新会话迁移在创建会话期间保留恢复记录。斜杠命令保持独立的执行约定，不会因提示词回执而获得通用副作用幂等性。

## 离线模型评测

[评测用例](../evals/cases.mjs)包含 24 个合成任务，覆盖编码、中文写作、资料分析和 fixture（测试前置数据）工具执行。[报告工具](../evals/report.mjs)为四个比较模型 slot 准备两轮记录；它不运行模型，也不访问网络或凭据。

```sh
node integrations/jiuzhang/evals/report.mjs template
node integrations/jiuzhang/evals/report.mjs summarize /absolute/path/to/metadata.json
```

模板将每次运行初始化为未执行。已完成记录要求源码／配置摘要、评分布尔值和数字观测。报告区分未达标、提供方错误、跳过和未运行；缺失的用量或费用保持未知。自由文本回答、错误原文、密钥和未知字段会被拒绝，且不回显其值。合成观测与实测调用分开标注。[Claude 研究记录](../evals/claude-research.json)链接官方文档，并明确标出未读报告；它不证明账号可用、适配器兼容或模型质量。付费比较要求单独批准预算。

## macOS 原生应用

```sh
# Source/standalone layout (development):
zsh integrations/jiuzhang/native/build-app.sh /path/to/output

# Self-contained distribution: embed the selected Node binary and the standalone
# runtime inside the bundle, recording bundle-relative paths in Info.plist.
JIUZHANG_SELF_CONTAINED=1 JIUZHANG_RUNTIME_ROOT=/path/to/runtime \
  JIUZHANG_PACK_RECEIPT=/path/to/pack-receipt.json \
  zsh integrations/jiuzhang/native/build-app.sh /path/to/output
```

在输出目录产出 `Ark.app`：原生 AppKit + SwiftUI 可执行文件、ICNS 生成（需要 Pillow），以及记录 Node.js、启动器、runner 与运行时根的 Info.plist。自包含构建要求使用 [pack-runtime](../src/pack-runtime.mjs) 产出的回执。构建为内嵌 Node 单独应用 `Resources/node.entitlements`，并在接受应用包前实际执行签名后的 Node。默认使用 ad-hoc 签名，也可通过 `JIUZHANG_SIGN_IDENTITY` 使用 Developer ID；`JIUZHANG_NOTARY_PROFILE` 还会提交 notarytool 并装订票据。自包含应用包按 `Bundle.main.bundleURL` 解析 `Contents/...` 相对路径，移动应用不会失效。[Info.plist](../native/Resources/Info.plist)拥有独立的营销版本和构建号；原生契约固定这两项。源码/独立运行时布局仍依赖记录的外部路径，移动后必须重新构建。

## 品牌

原生视图使用已认可的黑色 Ark 应用图标（`Resources/AppIcon.png`）与原生 `ARK` 字标；应用与窗口名为 `Ark`。保留此品牌，不得重新引入已退役的红色九章天幕图标。浏览器构建身份与 PWA 元数据不是 Ark 产品输入。

## 本地 API 鉴权

每次 Ark.app 启动生成一个新令牌，并以 `DSH_API_TOKEN` 传给子进程。原生 `URLSession` 客户端在每个 RPC 的 `Authorization: Bearer` 头中携带它。`@deepseek-ai/dsh-native-api-app` 把监听器固定为 loopback 与 `apiOnly: true`，不挂载前端或浏览器名录，并通过 `dsh-host-connection` 组合严格 `/api` RPC、`/api/respond`、`/api/session/export`、`/api/events/mux` 与 `/api/events/host`。结算后输出的 `dsh native-api:` 行是就绪信号。独立运行时闭包检查会在直接链接与 pnpm store 中拒绝 Web/headless 及已退休旧 API 包身份，并拒绝全部 `node_modules.*` 旁路目录树。该令牌是启动级鉴权，不是 macOS 进程身份认证。

## 生命周期恢复

Ark 不嵌入任何链接 WebKit 的更新框架。在实现完全原生的升级器之前，更新由应用外分发。每代后端启动默认最多等待 30 秒就绪；已签名的 `ArkBackendReadinessTimeoutSeconds` 元数据接受正的有限数作为部署覆盖值。就绪、退出、失败和关闭应用都会使定时器失效。超时仅停止并回收自己拥有的那代进程，再执行现有的三次退避重试；旧就绪事件和定时器回调不能影响替代进程。快速崩溃历史由稳定窗口重置，第一条就绪行不会立即清零。原生关闭流程取消并等待知识加载与轮询；已取消或过期项目的结果不能安装替代视图。

## 凭据存储

凭据提供方新增 `keychain` 模式（仅 macOS）：密钥存放在登录钥匙串的专属 service 中（通过 `security` 命令行），继承环境变量与 `.env` 的优先级分层不变。jiuzhang profile 在 macOS 上默认把 credentials 行设为 `mode: keychain`，让钥匙串 ACL 绑定稳定的包签名；非 macOS 的开发/CI 组合保持文件模式。keychain 模式测试以 mock 的 `security` CLI 覆盖存储/读取/描述/删除。

## 安装态验收

`integrations/jiuzhang/tests/install-e2e.mjs` 以安装后的形态启动产品（内嵌 Node + 启动器、隔离 home），验证 API-only 就绪、无令牌 401、令牌放行 RPC 与预置本地模型提供方。可将测试指向独立运行时（`JIUZHANG_RUNTIME_ROOT`）或组装完成的 `Ark.app`（`ARK_APP_PATH`）。原生控件、交互和同状态截图要求单独的候选验收；此 API smoke 本身不能证明它们通过。

候选退出验收：候选应用的 launcher 与 backend 都是候选 UI 进程拥有的后代。先从 `dsh native-api:` 就绪行记录实际端口；退出候选 UI 后，确认 UI、launcher、backend 与该精确监听器全部消失，才可接受本次运行。launcher 给子进程六秒，原生进程 owner 在 AppKit 的二十秒总退出期限内给 launcher 八秒。清理保留精确进程身份检查。正式替换要求候选验收通过并由用户明确确认；发行附件存放在 `admin1316/ark-releases`。
