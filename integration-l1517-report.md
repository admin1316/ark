# L15/L16/L17 (legacy ApiProxy 迁移) 整合就绪报告

日期：R18 轮次第4轮。评估人：Ark lead（只读+隔离克隆验证）。

## 一、迁移成果（gateway-integration 分支 codex/gateway-migration-b2）
- 8 个提交（8a66860 → 9618199），40+ 文件：host/native-events(新包)、session-remote-operations/session-export.ts、
  workbench/workbench-host.ts、settings config handoff、Swift ArkEventPump/ArkInteractionAPI/ArkSettingsAPI、
  host/connection（rpc+websocket-downlink+transport-independence 测试）
- 语义覆盖：事件载体(L16)、会话导出(L17)、设置/Workbench 路由(L15/G5) 职责已从 ApiProxy 移出

## 二、关键发现：基线漂移（机械重放不可行）
- 分支基线 3702c933（8-31）；当前主仓 HEAD 5573e189 + B0 脏工作树（9-02）
- 隔离克隆重放实验：11 个冲突文件；
  - 主仓 HEAD 已无 packages/host/workbench/{src,types,tests,README}、ArkSettingsAPI.swift、
    ArkSettingsContractChecks.swift（后续重构取代，替代 owner 需逐文件对账）
  - 迁移对旧路径的修改全部过期；仅"新增包/新文件"仍有效（native-events、session-export、
    workbench-host.ts、transport-independence 测试）
- 澄清：workbench-host.ts 非重复实现（主仓不存在旧版本）；无"重复实现"证据

## 三、建议步骤（父级复核流程）
1. 意图级重放：仅摘取分支中的**新增**文件/包（native-events、session-export、workbench-host.ts、
   transport-independence 测试），对照当前主树对应 owner（workbench/settings 现在的实现）
2. 旧路径修改（workbench/src/index.ts 等）废弃，不携带
3. 逐 lane 独立复核（互斥 write scope）+ 定向测试（host/connection、native-events、
   session-remote-operations、workbench + Swift contract）
4. legacy apiproxy 包本体 + 59 dot RPC 载体仍待后续（G2/G3/G4 网关线）；L15-17 只是职责迁移，
   不得宣称"归零完成"

## 四、证据
- 重复放实验：/tmp/ark-int（已恢复 clean）
- 分支：/private/tmp/ark-native-remediation-20260830-074522/gateway-integration codex/gateway-migration-b2
