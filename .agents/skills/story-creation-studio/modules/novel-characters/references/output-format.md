# 模块: output-format（novel-characters 子模块，按需加载）

### Step 9 — 输出

用户要求微表情、哭戏、真人表演层或情绪连续性时，先完整读取 [真人微表情与连续表演合同](../../_shared/micro-expression-performance-contract.md)，并额外交付 `<书名>-performance-bible.md`。该文件按角色记录：中性基线、视线习惯、情绪遮掩、恐惧/悲伤/喜悦/愤怒/惊惧/复杂内心的阶段链、泪水与呼吸连续性、声音变化和禁用表演；还要给出“同一情绪在不同对象、场景和目标下如何变化”的场景化样例，供逐镜引用，禁止把同一词库模板复制到所有镜头。**不要给既有 cast JSON 增加未定义字段**；表演圣经与角色 JSON 分开，避免破坏校验 schema。

```bash
cd <输出目录>
node {baseDir}/scripts/novel-characters.mjs render <cast.json> --md   > <书名>-cast.md
node {baseDir}/scripts/novel-characters.mjs render <cast.json> --html > report.html
```

`render` 会自动去 `images/<slug>-turnaround.png` 找图，找到就嵌进 report.html。所以**先出图再 render**。

report.html 的样式约定见 `{baseDir}/references/report-style.md`——要改样式先读它，别把它改回通用卡片墙。

最终落地：

```
<输出目录>/
├── <书名>-cast.json
├── <书名>-cast.md
├── report.html          ← 双击就能开
└── images/*.png         ← 有 codex 才有
```

