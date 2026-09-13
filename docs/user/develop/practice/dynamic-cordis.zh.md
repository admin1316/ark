# 用 Cordis 工具扩展运行中的智能体

[English](dynamic-cordis.md) | 中文

本实战指南启用 [`@deepseek-ai/dsh-tool-cordis`](../../../../packages/extensions/tool-cordis/README.zh.md)。智能体可以检查当前 Cordis 进程，并在内存中挂载或卸载模型编写的插件。临时插件会在卸载或进程退出时消失，并可能影响同一进程中的其他会话。

## 运行

在已安装的[自定义 CLI profile](../../../../apps/cli/README.zh.md#profiles) 中配置 live Agent、模型凭据、`@deepseek-ai/dsh-cordis-host-runner` 与 `@deepseek-ai/dsh-tool-cordis`。将包声明为该 profile 的依赖，并在启动 profile 前通过其 `cordis.patch.yml` 挂载它们。浏览器专用示例 overlay 不是 Ark Native 启动命令。

[Cordis 工具参考](../../../../packages/extensions/tool-cordis/README.zh.md)定义工具参数、存续时间、清理行为与安全性约定。profile 启动后，让 Agent 检查已加载的 Cordis 服务，核实工具结果后再请求临时插件。
