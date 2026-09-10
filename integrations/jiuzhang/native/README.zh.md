# Ark macOS 原生应用

[English](README.md) | 中文

Ark 的原生 macOS 应用。AppKit 管理进程与窗口生命周期，SwiftUI 绘制全部可见控件；在系统分配的 `127.0.0.1` 端口上监听的 bearer 鉴权 API-only 进程提供会话、模型、工作区和知识数据。应用不加载 HTML、CSS、JavaScript、PWA 或 WKWebView 界面。

- 唯一面向用户的产物、应用名、菜单与窗口名为 `Ark.app` / `Ark`。
- 原生客户端每次启动生成一个令牌，以 bearer 凭据访问 loopback API；后台不提供浏览器界面。
- 进程使用产品数据目录，默认权限模式为只读，并禁用遥测。
- 本机构建使用 ad-hoc 签名；自包含构建为内嵌 Node 单独应用 V8 JIT entitlements，并在签名后执行真实 Node smoke。

聊天的处理详情展示已记录的调用配置与响应回执。请求型号与提供方报告型号分别显示；缺失或不支持的响应元数据保持未知。回执不能独立认证中转平台的底层型号，不暴露凭据，也不注入新的模型可见上下文。首响应计时对应首个流事件，不保证正文已经出现。吞吐率以提供方报告的输出 Token 数（可能包含思考）除以已完成模型流耗时之和，排除工具执行与重试等待。缺少计时依据时不显示吞吐率，而不借用其他调用的时间区间。

## 构建

```sh
zsh build-app.sh /path/to/output
```

在输出目录产出 `Ark.app`。图标源为 `Resources/AppIcon.png`（1024 × 1024 的 Ark 印章母版；构建校验精确尺寸，并在临时构建目录内生成 ICNS）。

构建细节、版本号与两种布局见[工程说明](../docs/engineering.md)。
