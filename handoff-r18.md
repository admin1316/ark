# R18 候选构建交接（给官方管线/父级/claude）

## 为什么又是 100% CPU
运行中的 App = current-test-app-r17-staging（R17 二进制，无 R18 修复）。
长会话恢复后 R17 已知病灶（每消息 Section+嵌套 ForEach+source-backed 长 String 哈希身份：
rebuilt LazySubviewPlacements 循环）必然复发。当前实例采样（2026-09-03）已再次出现
LazySubviewPlacements 热帧 = 同一根因。

## R18 修复（源码级完成并验证）
- 补丁：/tmp/ark-r18/r18-fix.patch（244 行，3 文件）
- 修改后完整源树：/tmp/ark-r18/integrations（含修复 + 契约测试更新，.build 除外）
- 验证：swift build PASS；JiuzhangShellContractTests 40/40 组 0 失败；
  swiftc -parse PASS；三方子代理红队 + claude 红队（P0/P1 全部闭环）
- **R18 源快照：/tmp/ark-r18/current-source-r18-snapshot.tar.gz**
  SHA-256 6ea352656b571d3b83a6cd217f54ce50a915205a035740b8037cb6558f132781
  （3.1MB，integrations 源；含修复，不含 .build/orig/patch）

## 下一步（官方管线）
1. 用 R18 源快照替换 R17 冻结源（SHA 6ea3526…）
2. 官方打包：runtime pack（复用 current-runtime-pack）→ 构建唯一自包含候选
   （build-app.sh 流程 + deep strict codesign + provenance）
3. required Gate 52/52 → 候选 staging（next 槽位）
4. 用户授权 → install-e2e → LIVE 真实触发（10轮/2.6M-token 恢复，20×10s UI CPU 采样；
   R18 预期 <10%，无 Section/LazySubviewPlacements 热栈）→ 正常退出+5s回收
5. 台账记录：R18 修复生效与否以 LIVE 采样为准（不以外推宣称）

## 约束
- 构建/打包/安装/LIVE 均可能重启 App：由用户或其授权方执行；Ark 侧零重启动。
