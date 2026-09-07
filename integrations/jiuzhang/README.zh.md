# Ark

[English](README.md) | 中文

本目录承载 Ark 产品 profile、启动器对、原生 macOS 应用、运行时闭包策略与契约测试。

## 产品边界

- **Agent preset**：Ark 默认使用随产品交付的 `standard` preset，并通过原生设置提供 preset 选择与编写。每个会话获得其所选 preset 拥有的工具与 prompt。
- **诚实边界**：Ark 只依据你在当前会话中明确提供的信息工作。它不会声称已经采集、学习、训练或访问你未提供的数据；没有证据时，会明确说明不知道。
- **数据本地化**：设置、凭据、附件与 JSONL 会话记录存放在 `~/Library/Application Support/Ark/Harness`（可用 `JIUZHANG_DSH_HOME` 指定其他位置）。默认启动会将现存的 `~/Library/Application Support/九章天幕行业大脑/Harness` home 一次性复制到新目录；目标文件冲突时拒绝启动，并保留源目录用于回滚。
- **安全默认**：启动器默认权限模式为只读并禁用遥测。你可以在设置中主动提高权限或切换默认预设；已保存的选择在启动时会被保留。

## 运行

### macOS 应用

打开 `Ark.app` 即可（打包方式见[工程说明](docs/engineering.md)）。

### 从源码运行

```sh
node integrations/jiuzhang/src/start.mjs --port 3080
```

启动器会先对 Ark 自有的 `jiuzhang` profile 执行带回滚的协调，再启动专用 Native API 入口。用户设置与托管 profile 相互分离。

## 配置模型

打开 Ark 设置 → 模型，为兼容提供方添加凭据。Ark 不携带 API key，也不会把应用启动当作已经验证的模型对话。

## 反馈

Ark 处于内部测试阶段。请直接向产品团队反馈问题与建议。

## 维护者

构建、验证、打包与布局细节见[工程说明](docs/engineering.md)。
