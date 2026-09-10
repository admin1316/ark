# extensions/：agent（智能体）修改自身运行时

[English](README.md) | 中文

agent 修改自身运行时：检查已加载的插件与服务接口、定义并运行模型编写的动态包（dynamic package）并再次撤下，外加受限 repository Plugin 运行时。交付产品中的本子系统是 Host-only；历史浏览器半已退役。设计居所：[工具集 Agent Note](../../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.zh.md)。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`tool-cordis/`](tool-cordis/README.zh.md) | `cordis_inspect`／`cordis_define`／`cordis_run`／`cordis_stop`／`cordis_undefine` 工具：读取当前进程运行时，并在一个自有分组 fiber 下管理内存中的动态包 | 注册到 `ctx.tools` |
| [`cordis-host-runner/`](cordis-host-runner/README.zh.md) | 定义注册表、host 半的 `node:vm` 沙箱，以及 request-run 往返 | 提供 `ctx.dynamicCordisRunner` |
