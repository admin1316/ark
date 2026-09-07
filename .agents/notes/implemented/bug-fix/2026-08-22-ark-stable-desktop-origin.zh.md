# Agent Note: Ark 稳定桌面 origin

Status: implemented

[English](2026-08-22-ark-stable-desktop-origin.md) | 中文

## Problem

通用 Web 产品需要稳定的 loopback origin，因为 WebKit 会按 HTTP origin 隔离 local storage。OS 分配的端口会在 backend 重启后改变，使已保留的会话选择、草稿、workspace 视图、trajectory 与插件布局看起来像被重置。

## Decision

通用 Web 产品将 `http://127.0.0.1:3080` 作为稳定 origin。它只绑定 loopback、校验 readiness URL、以启动 token 保护 API、阻止非 loopback 子资源、拒绝离开 ready origin 的导航，并显式报告端口冲突。

Ark 不使用浏览器持有的产品表面。其 AppKit/SwiftUI client 从 `dsh native-api:` readiness 行读取 bearer-authenticated API URL，并以端口 `0` 启动；会话选择、草稿、workspace、trajectory 与布局由 Native/Host 持有的持久化保存。

## Alternatives considered

- **让通用 Web 产品使用 OS 分配的端口。** 重启会改变 origin，继而改变 WebKit 的 storage partition，使已持久化的记录看起来缺失。
- **让 Ark 使用稳定的浏览器 origin。** Ark 没有可见的 WebKit 表面，固定端口还可能被 stale process 或无关本地服务占用。

## Consequences

通用 Web 产品保留稳定 origin 并显式拒绝冲突。Ark 避免 `3080` 启动冲突；除非未来设计明确重新引入浏览器持有的产品表面及其验收要求，否则不会恢复基于浏览器 origin 的持久化。
