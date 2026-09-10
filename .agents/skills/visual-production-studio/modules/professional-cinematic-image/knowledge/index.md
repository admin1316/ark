# professional-cinematic-image Knowledge Index（深档索引层）

> 深档不默认加载；先看用途→章节→只读对应小节。metadata（loading: on-demand）已标注。

## references/emotion-visual-table.md（248 行 · 按需加载）

- 用途：emotion-visual-table — ## 一、情绪 → 视觉决策表（Quill 原表，原样保留）；## 二、新增使用场景行（在原表基础上增添，补暖色 / 明亮 / 日常 / 产品 / 治愈 / 欢乐 / 怀旧 / 千禧）；## 三、摄影要素 → 情绪 反查速查表
- 调用：任务匹配emotion-visual-table主题时读取
- 读取：只读对应小节，不读全文

## README.md（110 行 · 按需加载）

- 用途：README — ## 这是什么？（用一句话说明白）；## 🧓 怎么安装？（三步，照着做就行）；## 怎么用？（说人话的例子）；## 里面有什么；## ⭐ 求个 Star（收藏）；## 关于作者
- 调用：任务匹配README主题时读取
- 读取：只读对应小节，不读全文

## 加载策略

- 热路径（每次）：SKILL.md + 技法模块（≤80 行）
- 按需路径：本索引对应深档的小节
- 禁止：一次读取深档全文（除非用户明确要求）