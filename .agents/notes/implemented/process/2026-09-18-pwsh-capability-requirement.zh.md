# Agent Note: 将 PowerShell 能力设为 coverage 车道的显式要求

Status: implemented

[English](2026-09-18-pwsh-capability-requirement.md) | 中文

## 问题

完整 coverage 车道对它所插桩的每个包都强制逐文件 100% 覆盖，其中包含 `packages/shell/pwsh-local` 与 `packages/shell/pwsh-sandbox`。这些套件通过 pwsh 可用性探测自我准入，探测失败即跳过；而 [coverage-exclude.ts](../../../../scripts/coverage-exclude.ts) 中的覆盖豁免列表又运行了自己那份相同的探测。在 [CI run 35360633929](https://github.com/admin1316/ark/actions/runs/35360633929) 的 attempt 1 中，两者结论相反：套件跳过（`pwsh-sandbox` 19 项中 13 项跳过、`pwsh-local` 36 项中 27 项跳过），豁免列表却仍认为 pwsh 可用，于是该车道以"文件覆盖率不足"报错——而这些文件的测试根本没有运行。

作业日志记录了 runner 镜像、平台与跳过数量，却没有记录探测所用的可执行文件、退出码、stderr 或超时；两次 attempt 运行在相同镜像版本上。因此首次跳过的确切原因属于证据边界：它既可能来自 fork 出的套件进程内 PATH 查找失败，也可能来自 coverage 负载下的进程创建失败，或工具本身不可用，而没有任何现存产物能区分这三者。后续设计必须让这种区分可观测，而不是靠猜测。

## 决策

[packages/shell/pwsh-local/src/capability.ts](../../../../packages/shell/pwsh-local/src/capability.ts) 为整个仓库拥有唯一探测。它解析可执行文件（依次为显式参数、预检导出的绝对路径、共享解析器），运行一条有界的、免配置、免网络的合成命令，并报告类型化的原因：`OK`、`NOT_FOUND`、`NOT_EXECUTABLE`、`TIMEOUT`、`PROBE_FAILED` 或 `VERSION_MISMATCH`，同时给出可执行文件、版本、架构与细节。所有 pwsh 门控套件改为调用它的门控，不再各自保留一份 `spawnSync` 副本；覆盖豁免列表调用同一门控，因此套件与豁免列表再也不会互相矛盾。

门控保留开发机上的跳过语义：工具不可用时返回 false，可选套件照旧跳过。完整 coverage 车道设置 `DSH_REQUIRE_PWSH=1`，此时门控抛出异常并携带可执行文件、原因与细节。必需套件因此会明确失败，而不是报告一次绿色跳过；配置加载失败也将取代"某个包被静默豁免"。

[scripts/ci-pwsh-preflight.ts](../../../../scripts/ci-pwsh-preflight.ts) 是 coverage 作业的前置步骤。它打印一行机器可读的能力信息，导出绝对可执行文件（同时写入 `GITHUB_ENV`），使 fork 出的套件不会以不同方式重新解析；它还证明一次会回显令牌的执行往返，这正是套件实际使用的能力。当工具缺失或不可用时，它把固定版本的官方发行物安装到作业临时工具目录：linux-x64 或 linux-arm64 的 PowerShell 7.6.6，来自厂商 release，解包前按公布的 SHA-256 校验；不修改全局 PATH、不使用 `sudo`、不使用 `curl | sh`。能力仍不可用时该步骤以具体原因失败，`ci.yml` 把它排在 coverage 消费者之前。

## 备选方案

**依赖 runner 镜像自带 pwsh。** 镜像确实自带，而这正是故障不可见的原因：任何原因导致探测失败都会变成跳过，coverage 报错只给出一个百分比而不是能力事实。预检现在明确陈述它所依赖的事实。

**删除跳过让套件强制运行。** 没有探测时套件会在任意 fixture 代码中失败，把失败移到更难读的位置，并破坏开发机上合法的跳过语义。

**失败后反复重跑 coverage 直到变绿。** attempt 2 确实通过，但手工重跑不是可复现性保证，它把同样的静默跳过留给下一次。

**用浮动 latest 或包管理器安装 pwsh。** 两者都让车道依赖当天网络提供的内容；固定厂商资产加公布摘要让工具链可复现、可评审。

**让套件信任预检回执而不再探测。** 回执只是关于早先进程的声明；执行往返重新证明当前进程确实能执行即将被测的工具。

## 后果

开发机保留可选套件的跳过，而完整 coverage 车道要么在其消费者之前证明能力成立，要么带着可执行文件、原因与细节失败，因此下一次出现是可诊断的而非靠推断。缺少可用 pwsh 的 runner 镜像可从固定官方发行物自愈；主版本低于 7 的工具会报告为 `VERSION_MISMATCH` 而不是被使用。

首次 attempt 的历史原因保持为有边界的未知，并按此记录，而不是被改写成"环境问题已修复"。升级固定的 PowerShell 版本意味着同时更新其 URL 与公布的 SHA-256；预检只覆盖 linux-x64 与 linux-arm64，其他平台必须自带该工具。
