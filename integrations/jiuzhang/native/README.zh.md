# Ark macOS 原生应用

[English](README.md) | 中文

Ark 的原生 macOS 应用。AppKit 管理进程与窗口生命周期，SwiftUI 绘制全部可见控件；在系统分配的 `127.0.0.1` 端口上监听的 bearer 鉴权 API-only 进程提供会话、模型、工作区和知识数据。应用不加载 HTML、CSS、JavaScript、PWA 或 WKWebView 界面。

- 唯一面向用户的产物、应用名、菜单与窗口名为 `Ark.app` / `Ark`。
- 原生客户端每次启动生成一个令牌，以 bearer 凭据访问 loopback API；后台不提供浏览器界面。
- 进程使用产品数据目录，默认权限模式为只读，并禁用遥测。
- 本机构建使用 ad-hoc 签名；自包含构建为内嵌 Node 单独应用 V8 JIT entitlements，并在签名后执行真实 Node smoke。

## 构建

```sh
zsh build-app.sh /path/to/output
```

在输出目录产出 `Ark.app`。图标源为 `Resources/AppIcon.png`（1024 × 1024 的 Ark 印章母版；构建校验精确尺寸，并在临时构建目录内生成 ICNS）。

构建细节、版本号与两种布局见[工程说明](../docs/engineering.md)。
