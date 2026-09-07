# novel-characters Knowledge Index（深档索引层）

> 深档不默认加载；先看用途→章节→只读对应小节。metadata（loading: on-demand）已标注。

## examples/渡口-cast.md（319 行 · 按需加载）

- 用途：渡口-cast — ## 沈知微（姑娘）；## 陆行远（陆）；## 老周（老伯）；## 胡二爷（胡）
- 调用：任务匹配渡口-cast主题时读取
- 读取：只读对应小节，不读全文

## references/turnaround.md（131 行 · 按需加载）

- 用途：turnaround — ## 情况 A：本 skill 正跑在 codex 里；## 情况 B：跑在 Claude Code 或其他环境里；## 画风一致性 ⚠️ 已知短板；## ⚠️ 变长参数会吞掉 prompt；## 背景：白底；## 必须显式指定目标路径
- 调用：任务匹配turnaround主题时读取
- 读取：只读对应小节，不读全文

## references/report-style.md（119 行 · 按需加载）

- 用途：report-style — ## 它是什么；## 三条不能破的规矩；## 配色；## 尺寸与栅格 ⚠️ 硬性；## 结构；## 每段提示词一个复制按钮
- 调用：任务匹配report-style主题时读取
- 读取：只读对应小节，不读全文

## README.en.md（117 行 · 按需加载）

- 用途：README.en — ## Use；## How it works；## Use the scripts directly；## Limits；## Files；## Self-test
- 调用：任务匹配README.en主题时读取
- 读取：只读对应小节，不读全文

## README.md（115 行 · 按需加载）

- 用途：README — ## 用；## 它是怎么工作的；## 命令行直接用；## 边界；## 文件；## 自测
- 调用：任务匹配README主题时读取
- 读取：只读对应小节，不读全文

## references/schema.md（96 行 · 按需加载）

- 用途：schema — ## 字段约束；## 校验
- 调用：任务匹配schema主题时读取
- 读取：只读对应小节，不读全文

## 加载策略

- 热路径（每次）：SKILL.md + 技法模块（≤80 行）
- 按需路径：本索引对应深档的小节
- 禁止：一次读取深档全文（除非用户明确要求）