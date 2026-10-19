# Agent Note: 共享原生 JSON 整数校验

Status: implemented

[English](2026-10-11-shared-native-json-integer-validation.md) | 中文

## 问题

历史 RPC 解析、实时事件信封、原生补齐和模型容量解析各自维护同一套有限值、整数和 JavaScript 安全范围判定。设置快照和更新重复解码命名空间，并把未经检查的修订号转为 `Int`，可能截断小数或因越界而崩溃。上下文和领域解码器重复了另一套上限不同的非负原生整数判定。

## 决策

[`JSONValue.jsonSafeInteger(minimum:)`](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellCore/ArkAPIClient.swift)统一维护该判定。历史、事件泵、语义历史、子智能体分页和 UI 调用者仍在各自入口校验。默认最小值为零；订阅和来源截面调用者显式允许 `-1` 哨兵值，模型容量的最小值为一。这些调用者保留有限值、整数、JavaScript 安全范围和原生 `Int` 范围限制。

[设置解码器](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellCore/ArkSettingsAPI.swift)把修订号校验为非负 JavaScript 安全整数，与[设置权威层](../../../../packages/settings/settings/src/index.ts)一致。快照读取跳过无效命名空间；设置更新拒绝无效响应。两条路径共用同一个命名空间解码器，保留 wire 字段和各自不同的失败策略。

`JSONValue.nonnegativeIntegerValue`统一维护上下文和领域解码器使用的原生判定：有限值、整数、非负且严格小于 `Int.max`。要求正数的上下文字段额外拒绝零。两种判定保留各自不同的范围限制。

## 已考虑的替代方案

保留独立判定会继续带来维护漂移。从某个入口删除检查会削弱该输入边界。把共享判定放在 JSON 值类型上，使 Core 和 UI 都能复用，而无须让数字校验依赖 API 客户端。

## 后果

每种数字规则各有一个纯实现。调用者保留各自的错误路径和顺序检查。[数字契约检查](../../../../integrations/jiuzhang/native/Tests/JiuzhangShellCoreTests/ArkChatPresentationContractChecks.swift)覆盖合法边界值、哨兵值、非数值、非有限值、小数和不同的上限。[设置 wire 契约检查](../../../../integrations/jiuzhang/native/Tests/JiuzhangShellCoreTests/ArkProviderRecoveryContractChecks.swift)实际调用 describe 和 mutate：合法修订号保留完整命名空间元数据，小数、负数、非安全整数、溢出值和非数字分别遵循调用者的失败策略。无效设置修订号不会被静默截断，也不会进入不安全的整数转换。
