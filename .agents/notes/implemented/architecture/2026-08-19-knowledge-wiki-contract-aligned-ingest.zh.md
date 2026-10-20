# Agent Note: Knowledge-wiki 契约对齐的摄取管线与持久化队列

Status: implemented

[English](2026-08-19-knowledge-wiki-contract-aligned-ingest.md) | 中文

## Problem

`dsh-knowledge-wiki` 曾以无状态桥的形式代理 LLM Wiki 桌面 API；引擎迁入进程内后，四个缺口使 harness 无法接管桌面应用留下的语料：

- **缓存中毒**：`scanSources` 在摄取**之前**就把内容 hash 写入 `.llm-wiki/ingest-cache.json`，失败的摄取（key 失效、模型错误）被当成已完成永久缓存，永不重试。且 Remote 摄取方法把错误吞进 `warnings`，`drainQueue` 永远看不到失败，生产环境 error 分支形同虚设。
- **与存量 79 个 sources/ 页面格式不兼容**：无摘要页 slug 推导（基于完整 identity 的 FNV-1a base36）、无 `sources` 字段规范化、无 sanitize/日期戳、无 index/log/summary 兜底、无页面 merge、无评审提取。
- **队列无持久化与退避**：队列纯内存（Ark 重启丢任务），失败任务在坏 key 下每 60 秒 crash-loop。
- **桥接死面**：`preprocess_file` 分支、`baseUrl`/`token` 参数，以及 1100 行无人引用的 `src/graph/` + `local-search.ts`（存活的 `graph.ts` 自带 Louvain 实现）。

## Decision

[显式路由与持久输入](../bug-fix/2026-10-20-ark-explicit-routing-and-durable-input.zh.md)拥有独立服务连接、项目接收身份和严格源提取。[研究证据与永久拒绝](../bug-fix/2026-10-20-knowledge-research-evidence-and-permanent-rejections.zh.md)拥有引用发布及内容/策略相关的重试抑制。更广泛的持久队列、仅成功后写入的导入 hash 和规范页面写入理由继续由本笔记管理。

本包现在是自包含引擎。关键机制：

- **扫描只入队，缓存后写。** `scanSources` 比对 hash 后把变更文件以 `pending` 入队；`markIngested`（重读文件算 sha256）仅在摄取成功后执行。`drainQueue` 把「零产出且带 warnings」视为失败信号——这正是 Remote 摄取方法在 LLM 错误时返回的形态——坏 key 会把任务标为 `error` 并记 `failedAt`，而不是污染缓存。
- **持久化队列 + 冷却。** `ingest-queue.json` 保存活动任务及有界终态历史；服务 init 时 `restoreQueue` 恢复。暂时或未分类失败进入 60 分钟冷却（`FAILED_RETRY_MS`）；60 秒定时器独立于扫描执行 drain，重启后可恢复任务得以继续。永久提取处理状态遵循所链接的研究证据决策。
- **契约对齐的写盘管线。** 新模块按源 identity 推导摘要页 slug（`{structuralLength}-{readable}` 段以 `--` 连接，尾部 FNV-1a 32bit base36，上限 120 字符——以存量页名 `--1js7z6u`、`--n2u7v5` 验证一致），sanitize 生成内容（外层围栏、`frontmatter:` 前缀、缺失开 fence、frontmatter 内 wikilink 列表），日期戳到摄取日，规范化 `sources` 字段（剥 `raw/sources/` 前缀、过滤非法引用、去重、强制含本源 identity），并与既有页面 merge（仅本源独占时整页替换，否则保守并集 `sources`）。确定性兜底——index 条目、log 条目、源摘要页、评审项——与模型输出形态无关地照常执行。
- **Prompt 契约。** 阶段二 prompt 钉死今日日期、精确摘要页路径、项目 schema 与严格的 frontmatter 规则，使模型输出落到存量语料格式上。

## Alternatives considered

- **跨 Remote 边界抛错** —— 让 `ingestSource` 重新抛出 LLM 错误以触发 `drainQueue` 的 catch 分支。否决：Remote 方法的 `{ written, warnings }` 契约是先于队列存在的 UI 面，错误以 warnings 形态返回；零产出启发式保留契约的同时在 drain 处修复缓存中毒。
- **文件系统 watcher 替代轮询** —— 作为部署风险否决：60 秒扫描进程稳定、重启安全，且与 app 时代行为一致；队列恢复路径使轮询无丢失。
- **保留 `src/graph/` + `local-search.ts`** —— 否决：存活的 `graph.ts` 自带 Louvain 实现，`search.ts` 从未引用 local-search；这 1100 行与 `graphology`/`js-yaml`/`zod` 依赖无人引用。

## Consequences

- **所得**：失败的摄取（坏 key、模型错误）以 `error` 任务呈现，带 60 分钟冷却、一行 console 日志且不写成功摄取 hash；队列跨重启存活；新页面落到存量语料格式（以存量页名 `--1js7z6u`/`--n2u7v5` 验证）；包测试覆盖管线与队列。
- **代价**：`scanSources` 不再同步 drain，新文件要等到下一个 60 秒定时器 tick 才开始摄取（此前扫描即排水）；零产出且带 warnings 一律视为失败，因此真正无变化的 merge（空 sources frontmatter）进入冷却而非立即完成。
- **部署**：源码与安装运行时共同验证；`.llm-wiki/ingest-cache.json` 将成功 hash 与显式取消及失败处理状态共同保留。项目接收与连接设置遵循上文链接的显式路由决策。Ark 原生客户端消费进程内 Host 引擎，不依赖独立的 LLM Wiki 桌面应用。
