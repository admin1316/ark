---
description: "面向用户与维护者的 pi-ai 多提供方适配器说明：通过 pi-ai 目录与手工声明网关路由 harness LLM 服务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-pi-ai

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-llm-pi-ai` 是 harness LLM 服务基于 pi-ai 的多提供方适配器：一个插件实例拥有一份提供方路由字典，每条路由都通过 [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) 服务。点名已安装 pi-ai 提供方的路由会继承其端点、协议格式与模型目录作为默认值；pi-ai 不提供的路由可以直接声明，因此 OpenAI 兼容网关或自托管服务器只是配置，而非代码变更。profile 与凭据通过可选 settings 与凭据 seam 按请求解析，因此编辑用户设置文档即可改变下一个请求，无需重启。提供登录的提供方可以通过 harness 授权 seam 登录，存储的登录——OAuth grant，或在 pi-ai 自己的登录提示里键入的密钥——为其路由完成认证，并在存储的跨进程锁下自行刷新。插件可以零路由休眠挂载，一旦 settings 分节提供 profile 便立即激活它们。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当组合需要通过 pi-ai 的提供方目录、或通过 pi-ai 已安装目录未描述的网关路由模型请求时挂载本插件。`providers` 字典就是整个配置面：每个键都是请求用 `GenerateOptions.provider` 选择的提供方路由名。

### 何时选择

当同一组合服务多个提供方、某条路由需要 pi-ai 目录默认值并修正少数字段、或必须通过自有端点与协议到达手工声明网关时，选择本适配器。当部署不需要其他提供方时，选择 `dsh-llm-deepseek` 直连 DeepSeek 路由。两个适配器可以同时挂载，因为它们的路由名不冲突；注册其他适配器已拥有的路由会导致插件加载失败。

### 配置提供方路由

`bailian-cn` 和 `bailian-intl` 预置使用阿里云普通按量 API 和明确的凭据引用，与 Token Plan 凭据相互独立。初始参考目录包含 Qwen3.8 Flash 和 Max，保留已安装规范模型的推理与图片元数据。仍可覆盖端点与模型。[官方端点说明](https://help.aliyun.com/en/model-studio/base-url)规定了密钥所对应的端点；预置不会推测账号地域，也不会复制另一条路由的密钥。精确连接验证使用现有的有界最小生成探测，可能消耗 Token。仅保存凭据不构成认证成功的证明。

每个 profile 都可以设置 `retryPolicy`；省略时使用 normal mode、最多重试五次。`apiKeyEnv` 是按请求经 harness 凭据 seam 解析的凭据引用，因此配置文件绝不包含密钥；解析为空的引用会让请求以 `MISSING_CREDENTIAL` 失败。省略它会让路由保持已配置但无密钥（configured-but-keyless）状态，对已安装目录路由而言即交由 pi-ai 提供方原生的环境发现。

```yaml
- name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      openai:
        apiKeyEnv: OPENAI_API_KEY
        baseURL: https://proxy.example.com:8443
        reasoning: high
        requestImagePixelBudget: 4194304 # total pixels; 2048 by 2048 default
        requestImageMaxBytes: 1048576    # raw bytes before base64 expansion
        maxRequestImageBytes: 20971520   # accumulated base64 payload
        retryPolicy:
          mode: normal
          maxRetries: 3
      anthropic:
        apiKeyEnv: ANTHROPIC_API_KEY
        models:
          - id: claude-sonnet-4-5
            contextWindow: 200000
      acme-gateway:
        displayName: Acme Gateway
        apiKeyEnv: ACME_GATEWAY_API_KEY
        api: openai-completions
        baseURL: https://gateway.acme.example/v1
        compat:
          thinkingFormat: deepseek
        models:
          - id: acme-think
            name: Acme Think
            contextWindow: 262144
            reasoningEfforts:
              off:
              high: high
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKeyEnv` | 无 | 按请求解析的凭据引用；省略时交由 pi-ai 环境发现 |
| `credentialHeaders` | 无 | 标头名称到凭据引用的映射，每次请求解析，设置中不保存凭据值 |
| `headers` | 无 | 公开请求字段；非空凭据字段必须使用 `credentialHeaders` |
| `displayName` | 提供方名 | 选择器界面显示的标签 |
| `api` | 目录协议 | 协议格式；仅目录不提供的路由需要 |
| `baseURL` | 目录端点 | 路由上所有模型的端点 |
| `models` | 已安装目录 | 整体替换路由目录；每个条目从已安装模型取默认值 |
| `modelOverrides` | 无 | 重塑个别已安装目录模型，而不替换其余模型 |
| `compat` | 目录检测 | 无法识别端点的协议兼容开关 |
| `defaultContextWindow` | `262,144` | 未描述模型的容量回退 |
| `defaultMaxTokens` | `32,768` | 未描述模型的输出上限回退 |
| `requestImagePixelBudget` | `4,194,304` | 每张确定性请求图片的总像素预算 |
| `requestImageMaxBytes` | `1 MiB` | 每张请求图片在 base64 扩展前的编码字节目标 |
| `maxRequestImageBytes` | `20 MiB` | 带最旧优先卸载的 base64 图片载荷总上限 |
| `retryPolicy` | normal，5 次重试 | 由 `dsh-llm-retry` 执行的提供方自有重试策略 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-llm-pi-ai)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 登录提供方

pi-ai 提供登录的提供方可以通过 harness 授权 seam 登录：流程提供 OAuth 或交互式密钥提示（密钥键入 pi-ai 自己的登录提示，而非设置表单），得到的凭据存储在 harness 凭据存储的 `llm-pi-ai/<provider id>` 记录中。存储的登录在其路由的 `apiKeyEnv` 覆盖之下完成认证，并在存储的跨进程锁下自行刷新；退出登录即删除存储记录。落在记录文法之外——小写连字符标识符——的手工声明路由键无法登录，因为对它的记录写入会以 `LlmError('UNSTORABLE_PROVIDER_ID')` 拒绝；这类路由改用 `apiKeyEnv` 或提供方 ambient 设置认证。

### 解析模型目录

profile 的 `models` 列表会替换而非扩展路由的已安装目录；每个条目从同 id 已安装模型取未设置字段的默认值。`modelOverrides` 重塑个别已安装目录模型，不替换其余模型。新写入会拒绝与 `models` 列表并存、位于手工声明路由或点名缺失目录模型的覆盖项。已存储配置中的目录失效保留修复诊断，不移除独立有效的模型或 Settings 入口。

### 带推理与协议兼容运行

`reasoningEfforts` 声明模型可选择的 thinking 等级：每个键都是选择器提供的等级，其值是该等级过线的拼写，因此 `max: ultra` 可以为拥有自有词汇的网关重命名等级。省略该字段时保留已安装目录条目的能力；`false` 声明非推理模型。对于 pi-ai 无法识别的端点，`compat` 开关重塑请求——哪个角色携带系统提示词、哪个字段限制输出、thinking 等级如何传递——可逐路由、逐模型配置。条目与已安装目录都没有尺寸的模型，会采用路由的 `defaultContextWindow` 与 `defaultMaxTokens` 回退值。

### 运行时更改配置

profile 通过可选 settings seam 每次操作重新读取：base 与用户设置按提供方合并，成功编辑在下一个请求生效，无需重启。新增或改变且无法服务的 profile 会在持久化前被拒绝。未改变的目录失效 profile 不阻塞独立提供方的编辑，但明文凭据仍会阻塞写入，直到显式迁移。原生 Settings 显示保留的目录诊断。标量失败会保留 namespace 最后有效值。路由集合与重试策略变化采用原子重新注册；冲突路由会让此前路由继续服务。

私有端点可声明推理预算字段拼写、vLLM 优先级及输出 token 参数支持。Anthropic 逐轮推理强度要求自适应思考。版本 2 的适配器回放封装在后续轮次保留提供方的精确推理强度，不迁移会话日志。目录管理的能力与回退模型元数据保持完整。

### 从端点发现模型

插件会回答"该提供方可以提供哪些模型？"，供配置界面正在编辑或起草的路由使用。已知路由在没有端点覆盖时使用内置目录；显式端点会通过网络查询（`openai-completions` 与 `openai-responses` 形状）。LLM 管理层将一次性凭据绑定到该精确端点和协议，并拒绝重定向。发现操作不会借用已存储路由的密钥。无效容量值会被省略，而非转换为不安全整数。响应只是供显式采纳的候选元数据，不会持久修改目录。

### 失败与恢复

非空明文凭据标头会使 profile 保持非活动状态，并且仅在提供方目录的 `migrationRequired` 中暴露字段名称。设置读取分别隐藏已解析层、base 层和用户层中的这些值；含秘密的容器格式非法时安全拒绝。包含此类值的写入会被拒绝，不修改磁盘。应改用 `credentialHeaders` 引用；显式空 `Authorization` 仍是受支持的非秘密协议覆盖。标头名称不区分大小写，重复名称会被拒绝，包括公开标头与凭据标头之间的冲突。使用非常规名称的凭据标头也必须通过 `credentialHeaders` 声明；公开字段不是秘密探测机制。

实时配置 schema 未声明的每个字段都会被隐藏并拒绝写入，不依赖字段名称。已声明的字典键、模板值和模型能力字段保持完整。格式非法的已声明值、凭据引用、循环结构和非 JSON 对象会被拒绝，不回显其值。profile 内的处理要求通过相对 `paths` 暴露，`inheritedPaths` 标识部署层拥有的字段。原生设置要求明确同意并重新输入密钥，才会通过现有提供方事务移除用户层字段。部署层字段和不完整迁移元数据会阻止该操作，而非猜测清理方式。

对于使用显式凭据的 OpenAI 兼容路由，验证会获取精确模型元数据，不跟随重定向，限制响应体为 64 KiB，然后移除全部凭据字段并重复请求。只有对照请求返回 401 或 403 才成立 `metadata-auth`；公开元数据仅表示可达性。其他协议以及没有显式凭据的路由交由 LLM 服务执行有时限的生成握手。[验证决策](../../../.agents/notes/implemented/bug-fix/2026-09-09-provider-verification-and-header-ownership.zh.md)记录管理归属与限制。

pi-ai 不提供的路由需要 `api`、`baseURL` 与非空 `models` 列表；无法服务的 profile 会在写入处被拒绝，并点名路由与模型。失败携带稳定 code：无法使用的凭据以 `INVALID_CREDENTIAL` 失败并点名路由与引用，`apiKeyEnv` 引用解析为空的路由以 `MISSING_CREDENTIAL` 失败，未配置模型以 `UNKNOWN_MODEL` 失败，终止性提供方失败则区分 `QUOTA` 与暂时性 `RATE_LIMIT`。`GenerateOptions.stop` 以 `UNSUPPORTED_OPTION` 被拒绝，因为 pi-ai 的通用流式 UI 无法跨提供方保证它。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释适配器背后的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

适配器建立在不可变快照与按操作解析之上。每个操作都会在第一次 `await` 前捕获整个快照——profile 加一个持有每条路由所构建 `Provider` 的 `createModels()` 集合——配置变更会构建新集合而非修改使用中的集合，因此在一个配置下开始的请求绝不会在另一个配置下结束。路由自己的凭据引用经 harness seam 解析，并以请求 `apiKey` 选项传入，pi-ai 将其视为优先级最高的 auth 覆盖——这正是快速失败（fail-loud）引用语义的所在。该覆盖未覆盖的一切都经集合自身的 auth 到达 pi-ai：凭据存储持有登录写入、刷新轮换的记录（以 `llm-pi-ai/<provider id>` 寻址），auth context 回答提供方解析时提出的 ambient 问题。两者跨快照保持稳定，因此配置变更重建集合时不会忘记谁已登录。

固定版本的 pi-ai Responses 解析器把创建与终态响应中非空的服务端 `model` 字段保存在 `responseModel` 中，终态元数据优先。现有回放封装独立于请求模型别名保留该字段与响应 ID；缺失字段保持缺失。这些是提供方报告，不是对网关底层模型的独立认证。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：profile 解析、settings 接线、目录与路由注册 |
| [`src/auth.ts`](src/auth.ts) | 覆盖 harness 凭据平面的凭据存储与 ambient auth context |
| [`src/login.ts`](src/login.ts) | 面向提供登录的已安装提供方的授权流程 |
| [`src/config.ts`](src/config.ts) | Profile schema、解析与可服务性校验 |
| [`src/headers.ts`](src/headers.ts) | 标头准入与隐藏秘密的设置投影 |
| [`src/verification.ts`](src/verification.ts) | 有界精确模型元数据与认证对照检查 |
| [`src/catalog.ts`](src/catalog.ts) | 已安装目录集成与漂移门禁 |
| [`src/provider.ts`](src/provider.ts) | 受支持协议表与提供方构建 |
| [`src/context.ts`](src/context.ts) | Harness 到 pi-ai 的上下文转换、图片处理、回放恢复 |
| [`src/stream.ts`](src/stream.ts) | 把 pi-ai 事件转换为 harness `StreamChunk` 值 |
| [`src/replay.ts`](src/replay.ts) | 带版本的 `ReplayEnvelope` 存储与校验 |
| [`src/discovery.ts`](src/discovery.ts) | 面向配置界面的端点询问 |

### 注册与目录

插件会在可配置提供方目录中声明它能认证的每个已安装目录提供方，并加入当前 profile 声明的每条路由，因此配置界面可以在任何路由存在之前提供完整目录。每个条目都携带 `declared`——pi-ai 是否在该键下不提供任何内容——因为只有适配器能区分手工声明路由与收窄目录路由。路由注册具有原子性：与其他适配器冲突的候选集合会让此前路由继续服务。零路由的裸挂载即休眠姿态：settings 分节提供 profile 前不注册任何内容，分节清空时路由随之消失。

### 回放与词汇

成功 assistant 响应会存储带版本的、无损 JSON 回放状态，与产生它们的提供方和模型放在一起——响应级事实加每个流式块一条逐块条目。请求时，`LlmRuntime` 仅当同一适配器实例拥有两条路由时才传递回放状态；适配器校验它并恢复原生响应 id 与提供方签名，无法使用的状态会降级为提供方无关内容而不是让请求失败。pi-ai 工具调用参数是解析后的对象，因此适配器解析输入并重新字符串化输出，以符合 harness 原始 JSON 约定；pi-ai 流内错误事件映射为终止 `finish` 分片。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从服务约定逐步进入孪生适配器与共享类型。

- [dsh-llm 服务](../llm/README.zh.md)——本适配器注册其上的提供方无关服务。
- [llm-deepseek 适配器](../llm-deepseek/README.zh.md)——`deepseek-official` 路由的 DeepSeek 直连孪生。
- [LLM 流式子系统](../../../docs/subsystems/llm-streaming.zh.md)——`StreamChunk` 协议与适配器约定。
- [llm-retry](../llm-retry/README.zh.md)——应用每个 profile `retryPolicy` 的重试执行器。
- [孪生 LLM 适配器](../../../.agents/notes/implemented/architecture/2026-06-13-twin-llm-adapters.zh.md)——为什么 DeepSeek 路由交付两个结构不同的适配器。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-llm-pi-ai)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 经 pi-ai 的提供方请求

#### 模型看到什么

所选目录模型会收到 `GenerateOptions.system`、历史、工具与 pi-ai 通用流式 API 支持的采样字段。每张保留图片前都会有文本，注明其完整附件 id 与实际请求尺寸。当前执行文件系统可以映射附件提供方的宿主对象时，该文本还会携带只读规范化对象路径，并警告规范化或请求投影可能缩放或重新编码上传内容。当累计 base64 图片载荷超过路由的 `maxRequestImageBytes` 时，每张卸载图片都会在替换文本中保留自己的身份与当前已解析访问方式。卸载的规范化附件不会读取或变换。提供方原生回放元数据只在适配器针对历史内容校验通过后恢复。

#### Token 影响

提供方分词决定精确输入。保留图片会添加稳定的附件与尺寸描述符；卸载占位符会替代省略图片的视觉 token。回放元数据可能让原生 API 复用提供方侧状态。

#### KV Cache 影响

转换保持逻辑请求顺序，图片句柄与卸载占位符则会添加模型可见文本。即使附件身份与请求字节保持稳定，执行世界路径变化也会改写历史句柄，并可能从该图片起阻止复用。更换适配器实例、提供方、模型或其他上游 token 具有相同的后缀影响。越过图片上限会把较早图片替换为占位文本，因此复用在该消息处结束，直到被卸载前缀稳定。

### 提供方响应

#### 模型看到什么

pi-ai 事件变成 harness 的推理、文本、工具调用、用量与 finish 分片。适配器把解析后的工具参数以原始 JSON 字符串传给 harness。

#### Token 影响

生成内容只在 loop 记录后才影响后续输入。提供方未单独报告推理 token 时，pi-ai 会把推理 token 并入输出用量，并原样保留其精确 `totalTokens` 值。

#### KV Cache 影响

已记录的响应内容会追加到下一个请求，不会使其更早可复用前缀失效。未记录的传输元数据与用量计量不影响缓存标识。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明适配器在哪里停止、由未来工作接续。它们是当前包约束，不是通用 pi-ai 对比或任务积压。

- **`maxRequestImageBytes` 只计算 base64 图片载荷**——文本、工具、描述符与 JSON 结构在该上限之外，因此它必须留有余量地低于网关请求体上限。卸载是确定性请求投影，不会记录为会话事件。
- **登录只存在于发起它的进程中**——授权尝试不持久，因此登录中途刷新页面会放弃它，用户需要重新开始。退出登录是对已存储记录执行 `deleteRecord`，只在本地忘记它，不会告知签发方。
- **提供方原生发现经本插件的 ambient context 回答**——不点名凭据的路由交由目录提供方自身解析，它会询问环境值（`AZURE_OPENAI_API_KEY`、`AWS_PROFILE` 及各提供方自有集合）与本地凭据文件。两个问题都在这里得到回答：凭据 seam 先于进程环境被查询，文件存在性则针对宿主进程的文件系统以 `~` 展开后检查。它做不到的是*读取*凭据文件内容——自行解析 `~/.aws/credentials` 的提供方会直接读取，不经该 seam。
- **设置可以新增或覆盖路由，不能移除组合路由**——用户层覆盖组合 base，因此删除 `cordis.yml` 提供的提供方属于组合变更。
- **分层合并对字典键没有删除**——base 声明的 `reasoningEfforts` 等级、`modelOverrides` 条目或 `compat` 字段可以被用户层覆盖，但不能被移除。
- **公开标头名称不能证明值也是公开的**——疑似凭据的名称会被隐藏，并在写入时拒绝，但任意提供方专用秘密必须通过 `credentialHeaders` 显式声明。
- **路由目录不会自行刷新**——目录就是 `settings.yaml` 的内容；这里没有任何机制向提供方查询它提供的模型。
- **每条路由一种协议格式**——混合协议目录路由无法承载另一协议格式的模型；把提供方拆到两个路由键是变通办法。
- **模态声明不受校验**——声明 `image` 而其网关不支持的模型会在提示词准入后被提供方拒绝。持久图片仍留在历史中，同一误声明模型可能再次失败；切换到纯文本模型仍然可行，因为共享 LLM 运行时会针对该请求把图片引用投影为稳定文本。
- **未认证路由取决于其协议**——不点名凭据的路由解析为已配置但无密钥，但 pi-ai 的 OpenAI 兼容实现仍要求 API 密钥或 `Authorization` 标头，因此无密钥本地服务器需要由 `apiKeyEnv` 或 `credentialHeaders` 引用的占位值。
- **不支持 `GenerateOptions.stop`**——pi-ai 的通用流式选项无法跨提供方保证停止序列行为。
- **历史中的 `system` 消息使用 pi-ai 通用上下文转换**——提供方专属放置遵循 pi-ai，而非 harness 自有的协议覆盖。
- **提供方 HTTP 状态不可用**——pi-ai 错误事件不跨提供方暴露稳定 HTTP 状态。
- **重试策略由提供方自有，而非 SDK 重试**——pi-ai SDK 重试保持禁用，因此持久 agent 步骤与 `llm/retry` 事件拥有每个可见尝试，直接 `ctx.llm.stream()` 调用仍是单次尝试。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 提供的协议集合刻意比 pi-ai 的完整 API 集合更窄：Bedrock、Vertex、Azure 与 Codex 通过 profile 无法以密钥、端点与标头完整描述的流程认证；目录路由仍可经自有提供方到达它们，只有显式覆盖会被拒绝。Codex 可经授权流程的 OAuth grant 登录。
- `compat` 开关集合由漂移门禁钉在 pi-ai 的 compat 类型上；上游升级若新增字段、为更多协议赋予 compat 类型或扩大值联合，会在有人分类前让构建失败。

</details>
