# Agent Note: 生成物索引门禁

Status: implemented

[English](2026-09-17-generated-artifact-index-gate.md) | 中文

## 问题

仓库把生成物移出版本控制：`packages/*/*/` 与 `apps/*/` 下的宿主 `lib/` 目录、TypeScript 增量 `*.tsbuildinfo`、`.tmp-swift-module-cache-*/` 下的 Swift 模块缓存，以及根目录的工作区初始化副本 `purpose.md` 与 `schema.md`。`.gitignore` 能阻止误加，却阻止不了 `git add -f`，而没有检查过被跟踪路径集合，于是一次强制加入就能把这些已移出的文件带回一个其它门禁都会放行的提交。

工作树检查回答不了这个问题。正常宿主构建本来就会把这些文件留在磁盘上，所以磁盘存在并不等于被跟踪；真正的问题是 Git 索引里有什么。

## 决策

`scripts/verify-generated-tracking.ts` 只检查 Git 索引路径。它用 `git ls-files --cached -z` 列出索引，按 NUL 切分以保留空格与非 ASCII 名称，再按形状分类：`packages/*/*/lib/` 与 `apps/*/lib/` 的确切段位、`.tsbuildinfo` 后缀、首段 `.tmp-swift-module-cache-` 前缀，以及两个根初始化文件。每条违规都打印路径与归属理由，命令以 `1` 退出。

保留的构建输入靠构造而不是例外名单留在范围之外：`vendor/` 下随源码保留的 `lib/` 目录、`.agents/` 下只是名为 `lib` 的手写模块、tsconfig 及其它构建定义、以及原生与测试输入，都不匹配已移出的形状。

检查失败即失败。Git 无法读取的仓库、未合并的索引（`git ls-files --unmerged`）、或格式异常的列表都以非零退出并给出诊断；只有完整且已解析的扫描才能报告零违规。

门禁运行在其它仓库门禁所在的入口：`scripts/run-gates.ts` 中 `ci-static`、`ci-primary`、`ci-linux-primary`、`ci-windows-observational` 图里的 `generated-tracking`，本地 `hygiene` 与 `check-all` 聚合，以及 lefthook `pre-commit` 任务。钩子扫描整个索引而不是只看暂存路径，因为索引本身已包含暂存状态，而单一全索引定义让提交时与 CI 的答案完全一致。

同一索引检查拒绝属于本机的分发输入：任意深度的真实 `.env` 变体及 `.credentials.yaml` 备份、`.sessions`、`.llm-wiki` 和 `wiki` 目录，以及根目录 profiles、用户预设与技能、logs、cache、提供商状态、`.ark-*` 恢复及导入状态、Harness、Knowledge、Default Workspace、Document References、Workbench Drafts、`.dsh`、会话、存储、附件、终端状态和设置文件。根目录身份标识、运行时补丁及生成的设置参考文件也属于本机；嵌套源码 profile 夹具和示例补丁仍允许跟踪。具名环境示例与录制的快照夹具仍属于有效输入。这是路径检查，不是基于内容的密钥检测。

[源码隐私检查](../../../../.github/workflows/source-privacy.yml) 在拉取请求与 main 推送时，用固定摘要校验的 Gitleaks 扫描已获取的 Git 历史。PR 和 main 工作流复用同一检查；PR 的 `all checks passed` 必须等待该检查成功，失败、取消或跳过都会阻止总检查通过。[配置](../../../../.gitleaks.toml) 保留默认规则，只对 Git blob 元数据、精确的测试字面量以及原始提交中的上游公开遥测标识作限定豁免。输出经过脱敏。媒体技能要求显式提供遥测接收密钥，不再自带该标识；未配置的安装不发送媒体遥测。本机用户数据和离线恢复归档不在源码检查范围内；CI 不删除它们，也不重写历史。

## 测试

`scripts/verify-generated-tracking.spec.ts` 在操作系统临时目录创建一次性仓库，覆盖：普通源码通过；仅存在于磁盘的被忽略构建输出通过；对已移出产物执行 `git add -f` 失败并给出路径与理由；从索引移除但保留磁盘文件后通过；vendor 与 `.agents` 的 `lib/` 目录、tsconfig、原生与 Python 输入通过；相似名称路径（`library/`、`libx/`、层级少一层的包、`notes.tsbuildinfo.bak`、非根 `schema.md`、`src/lib.ts`）通过；已移出目录内的空格与非 ASCII 名称失败；未合并索引失败；Git 无法读取的目录失败而不是通过。

CLI 还证明了非仓库场景（`--root` 指向普通目录）以非零退出，而不是报告空索引。

未覆盖：基于内容或语义的识别（形状全新的生成物在规则为其命名前不在范围内），以及 Windows 路径写法差异。

## 考虑过的替代方案

**检查工作树中的已移出路径。** 否决：宿主构建写出的正是这些路径，于是正常构建会让门禁失败，而在一台没有构建的机器上强制加入反而通过——与仓库需要的性质正好相反。

**禁止包含 `lib` 的路径或形似二进制的后缀。** 否决：`vendor/cordis/lib/` 是随源码保留的 vendored 记录，`.agents/**/lib/` 是手写源码，原生与测试输入各有自己的保留形状；子串禁令需要庞大的例外表，而且仍会漏掉换了名字的 `*.tsbuildinfo`。

**像 `expected-filenames.yml` 那样新开独立工作流。** 对本决策否决：该检查不需要按路径过滤的触发条件，成本低且覆盖全仓，接入现有门禁调度器加 pre-commit 钩子即可同时获得 CI 与提交时覆盖，无需第二套质量框架。

**钩子只检查暂存路径。** 否决：一次全索引扫描同时服务提交与 CI，并让被检查路径集合只有一个定义。

**把 Git 错误当成零违规。** 否决：这会把无法读取的状态变成绿色门禁。

## 后果

已移出产物无法通过 `git add -f` 进入提交而不使提交失败，CI 对被检出提交同样失败。类别清单显式且基于形状，因此全新的生成物布局不会被悄悄禁止：新增一类需要修改规则清单与其测试，门禁刻意不做猜测。代价是每次运行一次索引列举与少量提交开销。门禁只覆盖是否被跟踪：构建出的包是否有效仍由 `publint` 与 `ci-artifacts` 车道回答，而历史上已经包含产物的提交不会被本检查改写。
