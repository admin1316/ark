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
pnpm run test:jiuzhang                       # profile、启动器与原生应用契约
pnpm run verify-translation-pairing          # 双语文档配对
pnpm run verify-agent-note-format            # agent note 格式
```

集成测试已接入 CI consumers 门，需要先通过 `pnpm run build` 构建 Ark 入口。原生契约会构建并执行 Swift contract binary，验证 API-only bundle，并拒绝应用可执行文件包含 WebKit。

## macOS 原生应用

```sh
# 源码 / 独立运行时布局（开发用）：
zsh integrations/jiuzhang/native/build-app.sh /path/to/output

# 自包含发行版：把选定的 Node 二进制与独立运行时嵌入应用包，
# Info.plist 记录包内相对路径。
JIUZHANG_SELF_CONTAINED=1 JIUZHANG_RUNTIME_ROOT=/path/to/runtime \
  zsh integrations/jiuzhang/native/build-app.sh /path/to/output
```

在输出目录产出 `Ark.app`：原生 AppKit + SwiftUI 可执行文件、ICNS 生成（需要 Pillow），以及记录 Node.js、启动器、CLI 与运行时根的 Info.plist。自包含构建为内嵌 Node 单独应用 `Resources/node.entitlements`，并在接受应用包前实际执行签名后的 Node。默认使用 ad-hoc 签名，也可通过 `JIUZHANG_SIGN_IDENTITY` 使用 Developer ID；`JIUZHANG_NOTARY_PROFILE` 还会提交 notarytool 并装订票据。自包含应用包按 `Bundle.main.bundleURL` 解析 `Contents/...` 相对路径，移动应用不会失效。应用包营销版本为 `3.1.0`（Info.plist 的 `CFBundleShortVersionString` 与 `CFBundleVersion`；native contract tests 同时断言两个字段，改版本时需一起更新）。源码/独立运行时布局仍依赖记录的外部路径，移动后必须重新构建。

## 品牌

原生视图直接拥有 Ark 品牌：应用与窗口名为 `Ark`，导航栏字标为“九章天幕 + ARK”，`Resources/AppIcon.png` 提供应用图标。浏览器构建身份与 PWA 元数据不再是 Ark 产品输入。

## 本地 API 鉴权

每次 Ark.app 启动生成一个新令牌，并以 `DSH_API_TOKEN` 传给子进程。原生 `URLSession` 客户端在每个 RPC 的 `Authorization: Bearer` 头中携带它。`@deepseek-ai/dsh-native-api-app` 把监听器固定为 loopback 与 `apiOnly: true`，不挂载前端或浏览器名录，并通过 `dsh-host-connection` 组合严格 `/api` RPC、`/api/respond`、`/api/session/export`、`/api/events/mux` 与 `/api/events/host`。结算后输出的 `dsh native-api:` 行是就绪信号。独立运行时闭包检查会在直接链接与 pnpm store 中拒绝 Web/headless 及已退休旧 API 包身份，并拒绝全部 `node_modules.*` 旁路目录树。该令牌是启动级鉴权，不是 macOS 进程身份认证。

## 生命周期恢复

Ark 不嵌入任何链接 WebKit 的更新框架。在实现完全原生的升级器之前，更新由应用外分发。后端意外退出会自动按递增退避重启（最多三次），之后才显示失败对话框。

## 凭据存储

凭据提供方新增 `keychain` 模式（仅 macOS）：密钥存放在登录钥匙串的专属 service 中（通过 `security` 命令行），继承环境变量与 `.env` 的优先级分层不变。jiuzhang profile 在 macOS 上默认把 credentials 行设为 `mode: keychain`，让钥匙串 ACL 绑定稳定的包签名；非 macOS 的开发/CI 组合保持文件模式。keychain 模式测试以 mock 的 `security` CLI 覆盖存储/读取/描述/删除。

## 安装态验收

`integrations/jiuzhang/tests/install-e2e.mjs` 以安装后的形态启动产品（内嵌 Node + 启动器、隔离 home），验证 API-only 就绪、无令牌 401、令牌放行 RPC 与预置本地模型提供方。安装态还检查 Ark 可执行文件不链接 WebKit，且辅助功能树包含原生控件而不是 Web 区域。可将测试指向独立运行时（`JIUZHANG_RUNTIME_ROOT`）或组装完成的 `Ark.app`（`ARK_APP_PATH`）。

候选退出验收：候选应用的 launcher 与 backend 都是候选 UI 进程拥有的后代。先从 `dsh native-api:` 就绪行记录实际端口；退出候选 UI 后，确认 UI、launcher、backend 与该精确监听器全部消失，才可接受本次运行。launcher 会在 4 秒后强制终止不响应的 backend；UI 则等待 7 秒才强制终止 launcher，避免 supervisor 在子进程期限结算前先被移除。
