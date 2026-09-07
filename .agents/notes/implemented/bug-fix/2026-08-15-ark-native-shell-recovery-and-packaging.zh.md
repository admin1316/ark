# Agent Note：原生壳崩溃恢复与签名包打包

Status: implemented

[English](2026-08-15-ark-native-shell-recovery-and-packaging.md) | 中文

## 问题

五个缺陷让原生 Ark 应用的崩溃恢复与分发宣称落空。其一，`BackendProcess` 跨启动复用同一个 Foundation `Process`，而 `Process` 终止后不能再次 run——`AppDelegate` 在意外退出时调用的重启路径不是恢复，而是崩溃。其二，应用在退出后仍保留旧服务状态，即使重启成功，也不会重建客户端连接。其三，`build-app.sh` 在最终 `Info.plist` 修改（Sparkle 密钥与 feed）之前就签名；主程序链接了 `Sparkle.framework` 却未将其打入包内；直接把裸 `.app` 提交给 notarytool（其拒绝目录）；且 hardened runtime 完全阻止加载该框架。其四，构建与本地安装脚本接受正式产品路径，可能在候选验收或回滚准备前删除或替换 `/Applications/Ark.app`。其五，Ark 产品 profile 默认把凭据放在主目录文件中，尽管提供方自带 Keychain 模式。

## 决策

**每次启动拥有全新的 `Process` 与 `Pipe`。** `BackendProcess` 位于 `JiuzhangShellCore`（可在契约测试中直接测试），每次 `start` 创建新的进程与管道，在旧进程被回收前拒绝第二次启动（`BackendProcessError.alreadyRunning`），并经由各自的 termination handler 报告每次退出。`AppDelegate` 在未请求退出时移除旧原生模型并恢复加载态，就绪行到达时重置重启预算，并按既有递增退避重启。契约测试用 SIGKILL 杀死子进程两次，验证退出被报告、重启产生新 PID、双重启动被拒绝、`stop` 正确回收。

**包先完整组装，再一次性签名。** `build-app.sh` 在签名前完成所有 `Info.plist` 修改（内嵌路径、`SUPublicEDKey`、`SUFeedURL`/禁用检查），嵌入 `Sparkle.framework`（SwiftPM 构件，Homebrew 兜底）并经由 `install_name_tool` 添加 `@executable_path/../Frameworks` rpath，然后才依次签名框架、内嵌 Node 与应用（`--deep`、hardened runtime、entitlements）——Developer ID 身份用 `--timestamp`，ad-hoc 用 `--timestamp=none`。`codesign --verify --deep --strict` 把关输出。公证提交 zip 归档（notarytool 拒绝裸 `.app` 目录），随后 staple 并验证。entitlements 增加 `com.apple.security.cs.disable-library-validation`——Sparkle 文档对 hardened-runtime 应用的要求，也让 ad-hoc 本地构建能加载框架。

**SwiftMath 字体查找只从精确锁定的源码进行适配。** 候选构建通过 `Package.resolved` 解析 SwiftMath，在修改任一文件前要求恰好一个 `MTFont` 资源锚点和两个 `MathFont` 资源锚点，并拒绝漂移、重复、缺失、部分适配或已适配的锚点。仅用于 release 的适配器从 `Bundle.main.resourceURL` 下解析 `SwiftMath_SwiftMath.bundle`；普通开发与约定测试可执行文件回退到 `Bundle.module`。构建退出时恢复锁定 checkout 的源码，把生成的 bundle 复制到 `Contents/Resources`，并将它作为最终应用包的一部分签名。

**构建与本地安装脚本只产出候选包。** `build-app.sh` 在依赖操作前校验并规范化输出路径，拒绝正式应用路径树、软链接目标、嵌套 `Ark.app` 路径与任何已有候选包，且不会删除旧应用包。自包含构建还会把 Native 客户端需要的 RPC route 与 runtime 顶层 `@deepseek-ai/dsh-host-apiproxy` 直链实际指向的包进行比对；缺少包构件或 Host route 会在签名前失败。`install-local.sh` 在私有临时目录或显式指定的桌面候选目录下创建唯一命名的候选包，`update-local.sh` 委托给同一 owner。`--system` 会失败并提示受控 promotion 要求。正式替换仍是独立操作，必须经过候选验收、唯一回滚与显式授权。

**Ark 凭据在 macOS 上默认使用钥匙串。** jiuzhang profile patch 通过 `!!js` 平台表达式设置 credentials 行的 `mode`：darwin 上为 `keychain`，其余平台为 `file`（Linux 开发/CI 组合继续使用文件后端）。profile 测试解析 loader 的 `!!js` 方言并断言平台选择结果。

## 备选方案

**重置 `Process` 对象属性后再次 `run`。** 否决：Foundation 对已终止进程的第二次 `run` 会抛错；包装器必须每次启动都创建新对象。

**替换进程请求同一端口时保留旧服务 URL。** 否决：已退出的 listener 不再拥有该 endpoint；客户端重新连接前，必须由新的已验证就绪事件确认替换服务。

**在 Sparkle plist 修改之后再签名。** 否决：修改 `Info.plist` 会使既有签名失效；唯一合法顺序是全部修改、一次签名、再验证。

**把 `.app` 直接提交 notarytool。** 否决：notarytool 要求 zip、dmg 或 pkg；审计已用真实工具复现该拒绝。

**把已适配的 SwiftMath checkout 当作幂等成功。** 否决：原始锚点缺失后，构建无法区分自身先前的改写、上游源码漂移或不完整的外部编辑。精确输入计数与退出时源码恢复既保留重复离线构建能力，也不削弱漂移检查。

**保留带确认参数的便捷 `--system` 安装器。** 否决：shell 确认不能证明候选行为、源码与 runtime 兼容性、回滚身份，也不能构成替换活动产品的授权。候选构建与正式 promotion 保持为两个独立操作。

## 影响

被杀死的后端会自动重启，原生客户端无需用户操作即可重新连接；只有重试预算耗尽后才出现失败对话框。自包含包通过 `codesign --verify --deep --strict` 且内嵌 Sparkle 与 SwiftMath 字体；带 Developer ID 的签名构建可以公证并 staple。SwiftMath 源码漂移会在编译前停止打包，而退出时恢复会让显式提供的已解析 scratch 树可重复使用。复用输出目录会失败，而不是替换其中的 `Ark.app`；便捷安装与更新入口止于已验证候选，维护者必须选择新目标并使用受控 promotion 流程。钥匙串模式在首次访问凭据时提示（ACL 绑定到 bundle 身份）并把机密移出主目录；没有签名身份的机器仍可产出可验证的 ad-hoc 构建。
