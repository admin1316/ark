# Agent Note: bwrap 命名空间隔离配置

Status: implemented

[English](2026-08-16-bwrap-namespace-isolation-config.md) | 中文

## Problem

企业审计指出沙箱三档只约束文件效果：bwrap 约束的子进程共享宿主 PID 与网络命名空间，可向同 UID 宿主进程发信号并可访问网络。该 seam 的文档化契约是仅文件效果，且部分受约束命令依赖网络访问，因此无条件开启隔离会破坏现有部署。

## Decision

`dsh-sandbox-local` 新增可选 `isolate` 配置（`{ network?: boolean, pid?: boolean }`，默认关闭）。启用时 bwrap profile 在工作区挂载之前追加 `--unshare-net`／`--unshare-pid`；landlock、seatbelt 与 windows-acl 三档忽略该选项。默认行为保持文档化的文件效果契约；需要命名空间隔离的部署显式开启。Profile 测试断言每种标志组合的精确 argv，README（中英）已文档化该选项。

## Alternatives considered

**无条件开启隔离。** 否决：seam 契约是仅文件效果，受约束命令依赖网络访问，且 landlock/seatbelt 无法表达同等隔离——按平台静默改变行为会违反共享策略承诺。

**为每一档实现网络/PID 隔离。** 否决：landlock 无命名空间机制、seatbelt 仅 macOS、windows-acl 完全没有；bwrap-only 选项覆盖审计信号/PID 关切所在的 Linux 部署。

## Consequences

设置 `isolate: { network: true, pid: true }` 的部署获得命名空间隔离的 bwrap 子进程，并须接受受约束命令失去网络访问与跨进程可见性。默认行为不变。
