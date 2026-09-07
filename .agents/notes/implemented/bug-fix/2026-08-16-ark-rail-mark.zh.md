# Agent Note: Ark 收起侧边栏品牌标记

Status: implemented

[English](2026-08-16-ark-rail-mark.md) | 中文

## Problem

收起侧边栏后，rail 栏仍显示 DeepSeek 鲸鱼（`FishLogo`）：hero 壳与 wordmark 已支持品牌切换，但 rail 的静止标记是硬编码的，收起侧边栏后产品左上角仍残留 DeepSeek 图形。

## Decision

`SidebarRoot` 读取 hero 壳使用的同一 `data-dsh-product-brand` 文档属性，在 Ark 产品下 rail 渲染 Ark 印章位图（`/ark-seal.png`，128px 红色"九章天幕"篆书印章）而非鲸鱼；DeepSeek 构建保持鲸鱼逐字节不变。印章以 `<img>` 形式复用与鱼相同的 `railFish` 类（24px，随面板图标悬停隐藏），与 hero 壳既有的 `/ark-seal.png` 用法一致。wordmark 的隐藏 Jiuzhang 分支机制（`apps/web/index.html` 内联样式表）保持不变，因为 rail 切换是组件级分支，而非样式表选择器覆盖。

## Alternatives considered

**在 ui-primitives 新增线性 SVG 印章图元（圆角方块 + 九）。** 曾实现并在同一变更中弃用：产品负责人要求 rail 使用真实应用图标，线性近似在发布前被移除。组件级 `<img>` 分支复用既有印章位图，而非另造第二个标记。

**像 wordmark 一样用样式表选择双渲染。** 拒绝：wordmark 机制通过 `apps/web/index.html` 内联 CSS 隐藏单个 svg 的所有非 Jiuzhang 子元素；在 rail 复制它需要在另外两个槽位再建双分支树并加第三条样式规则，而组件级分支只需一次属性读取。

## Consequences

Ark 产品下收起侧边栏显示红色印章；DeepSeek Harness 构建仍渲染鲸鱼。rail 切换由 `sidebar-root.client.spec.tsx` 覆盖（默认产品保留鱼，ark 产品切换印章 `<img>`）。
