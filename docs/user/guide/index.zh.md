# 运行 headless 任务

[English](index.md) | 中文

headless profile 会在启动命令所在目录中运行一次任务，打印 assistant 的最终回复后退出。它不会打开浏览器，也不会监听任何网络端口。

## 配置凭据

在启动它的 shell 中导出 [DeepSeek API 密钥](https://platform.deepseek.com/)：

```sh
export DEEPSEEK_API_KEY=sk-your-key-here
```

[模型配置指南](./providers.zh.md)介绍其他提供方、自定义 OpenAI 兼容端点与持久设置。

## 选择工作区

进入一个隔离的项目目录。启动器会把该目录作为任务的 workspace：

```sh
cd /absolute/path/to/workspace
```

## 运行任务

运行：

```sh
npx @deepseek-ai/dsh --profile headless "Summarize this repository and identify its main packages."
```

该 profile 会创建一个持久会话，并在全部工作结算后返回。其配置的工具可能修改 workspace，因此在了解当前权限策略前，应当使用可丢弃的 checkout。

## 继续使用

- [配置模型](./providers.zh.md)
- [使用 Python SDK](./python-sdk.zh.md)
- [使用 profile 与插件管理](../../../apps/cli/README.zh.md)
- [开发插件](../develop/basic/index.zh.md)
