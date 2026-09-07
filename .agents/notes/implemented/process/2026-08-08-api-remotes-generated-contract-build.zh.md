# Agent Note: API Remotes 生成约定的有序构建

Status: implemented

[English](2026-08-08-api-remotes-generated-contract-build.md) | 中文

## 问题

Host 的 `@Remote` 方法需要先由 Typert 生成 `/remote` 声明和运行时贡献，`client/api-remotes/src/client/index.ts` 才能通过类型检查并打包这些贡献。若根构建先把 Host 与 Client 两张 Project Reference 图一起交给 tsc，Client 会在生成产物存在之前编译；若增加独立 contracts 预处理，又会让 generator 脱离正常 Host 图重复编译，并允许陈旧产物掩盖错误依赖。

该顺序依赖不能改变仓库的普通 package 规则。正常 package 只属于一个 TypeScript face：Host package 登记在 `tsconfig.host.json`，Client package 登记在 `tsconfig.client.json`。一个 Client plugin 同时具有 Node loader 入口与 browser 入口，只是打包产物形态，不是拆分 TypeScript project 的理由。

## 决策

根构建先完成 Host tsc 和 Host tsdown，由 Host tsdown 运行 Typert 并生成 Remote Client 约定；随后完成 Client tsc、Client tsdown 和 Web 构建：

~~~text
tsc -b tsconfig.host.json
tsdown --env.DSH_BUILD_FACE host
tsc -b tsconfig.client.json
tsdown --env.DSH_BUILD_FACE client
Vite Web build
~~~

`build:lib:host` 负责前两步，`build:lib:client` 负责中间两步，`build:web` 最后运行。`typecheck` 也必须先执行完整 Host lib 阶段，因为 Client tsc 需要 Host tsdown 生成的声明；它不需要运行 Client tsdown 或 Web build。

每个 tsc 阶段都是唯一的 TypeScript 编译器路径，负责向 `lib/types` 发射 JavaScript、声明和增量状态。tsdown 只读取这些 JavaScript 并生成发布 bundle，不读取源码，也不生成声明。

## Package ownership

有序构建不需要拆分 package。Host 身份与转发事件策略位于一个普通 Host project，生成贡献装配位于一个普通 Client project：

~~~text
packages/api/remotes/
├─ tsconfig.json
└─ src/
   ├─ index.ts
   ├─ agent-lookup.ts
   └─ invariant.ts

packages/client/api-remotes/
├─ tsconfig.json
└─ src/
   ├─ index.ts
   ├─ invariant.ts
   └─ client/index.ts
~~~

Host aggregate 与 `host/apiproxy` 引用 `api/remotes`；Client aggregate 与浏览器消费方引用 `client/api-remotes`。两个 project 分别向自己的 `lib/types` 发射，Client project 只为 type-only 转发事件选择依赖 Host 包。

每个 package 仍只属于一个 aggregate。Host 阶段会先生成 `/remote` 输出，Client 阶段随后编译独立浏览器装配；该顺序不要求两个实现共处一个 package。

## Typert 与 tsdown

Host tsdown 在普通根配置中启用 `typertPlugin({ mode: 'workspace', faces: ['host'] })`。generator 只以 `tsconfig.host.json` 为 program 种子，生成 `typert.host.*` 以及 Host 约定投影出的 `typert.remote-client.*`；Client tsdown 不启动 Typert，也不分析 Client aggregate。

TypeScript compiler face 与 Typert 运行时产物 face 是两层概念。每个 aggregate 的直接 Project Reference 决定 analyzer 读取哪个 compiler face，运行时模型则跟随 package subpath 贡献。Host 分析因此只看到 Host 策略包，后续 Client 阶段只看到浏览器装配。

Host 与 Client 两次 tsdown 都接收 `vendor/*`、`packages/*/*` 和 `apps/cli` 这组完整 workspace。根配置不扫描 `lib/types/client/index.js`，不维护 package 分类表，也不使用 tsdown filter；包内配置根据 `DSH_BUILD_FACE` 返回本阶段入口。

普通 Client plugin 在 Host pass 返回空配置，在 Client pass 同时生成 Node loader 入口与 browser bundle。`client-api-remotes` 走这条普通路径；`api-remotes` 走普通 Host library 路径。

## 考虑过的替代方案

**保留独立 contracts 预处理。** 这会在正常 Host Project Reference 图之外额外编译 generator，并让残留生成物掩盖 Client 过早进入 Host 图的问题。

**一次执行根 `tsc -b tsconfig.json` 后再运行 tsdown。** Client tsc 在 Host tsdown 之前发生，无法从干净工作树获得 `/remote` 声明。

**拆分所有包含 `src/client/index.ts` 的 package。** Node 与 browser 双入口是普通 Client plugin 的打包约定，不形成编译顺序依赖；普遍拆分只会增加 references 和增量状态的维护成本。

**扫描 Client 编译产物或维护两份 workspace 清单。** 产物扫描会让 package 是否参与构建取决于残留文件，手工清单和 package 名过滤则会随目录调整产生漂移。完整 workspace 加包内 face 选择已经提供确定行为。

**在 Client pass 再运行 Typert。** Remote Client 是 Host 约定的投影，没有独立 Client 反射源；第二个 Typert program 只会重复工作并增加两侧声明混入同一分析的风险。

## 后果

干净构建成为顺序正确性的权威验证：没有任何既存 `/remote` 产物时，Host tsc 必须先成功，Host tsdown 必须生成约定，随后 Client tsc、Client tsdown 与 Web build 必须成功。任何阶段都不得把产物写进 `src`。

[TypeScript 构建配置 Note](2026-06-17-ts-build-config.zh.md)确定的 tsc-first 职责保持不变，但其单次全图 tsc 后再打包的命令形态由本文的有序阶段取代。[双 aggregate solution Note](2026-07-22-tsconfig-solution-root-two-aggregates.zh.md)确定的普通 package 单 aggregate 规则保持不变，且没有 package 特例。

Client 的独立构建不是干净工作树上的自足入口；仓库命令、CI 和发布流程必须先运行 Host lib 阶段。每个 package 仍按所属运行环境选择一个 aggregate。
