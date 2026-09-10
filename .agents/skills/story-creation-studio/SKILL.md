---
name: story-creation-studio
description: 故事创作工作室。用于中文长篇或商业短篇的市场研究、拆稿、构思、世界观、人物、大纲、章节写作、续写、重写、导入旧稿、审稿、去模板化，以及从原文生成证据化角色卡、关系网、声音与三视图资产。Use when 用户要创作或修订小说、分析故事机制、导入母本、检查文风或建立角色资产；不负责导演分镜、影视执行稿或最终画面生成。
---

# 故事创作工作室

这是故事源头的唯一入口。先判断任务模式，再只读取一个主模块及必要参考；不要同时加载整套资料，也不要把不同方法拼成互相冲突的流程。

## 路由

| 任务 | 主模块 |
| --- | --- |
| 长篇题材、榜单、平台和对标研究 | `modules/inkos-long-market-research/instructions.md` |
| 长篇拆稿、文风与机制分析 | `modules/inkos-long-story-analysis/instructions.md` |
| 长篇构思、连载、章节写作 | `modules/inkos-long-writing/instructions.md`；需要完整阶段制时补读 `modules/chinese-novelist/instructions.md` |
| 商业短篇市场与样本研究 | `modules/inkos-short-market-research/instructions.md` |
| 商业短篇拆稿、反转与情绪链 | `modules/inkos-short-story-analysis/instructions.md` |
| 12–18 章短篇创作、整篇审改与包装 | `modules/inkos-short-writing/instructions.md` |
| 导入旧稿、重建设定、续写工程 | `modules/inkos-story-import/instructions.md` |
| 审稿、协作修订 | `modules/inkos-story-review/instructions.md` |
| 去空泛、去模板化、保留作者声音 | `modules/inkos-story-deslop/instructions.md` |
| 人物小传、角色卡、关系网、音色、锚点、三视图 | `modules/novel-characters/instructions.md` |

## 联合流程

用户要求“创作故事并建立角色资产”时：先锁定故事事实与人物身份，再由角色模块从确认稿生成资产。共享人物 ID、别名、符号锁、伏笔和时间线，不建立第二套设定。

## 共同规则

- 上下文充分时直接工作；缺少会改变作品方向的关键选择时才提问。
- 研究结论要区分证据、推断和创作决策；不得伪造榜单、原文或已完成的工具结果。
- 分析参考作品时提炼可迁移机制，不复制其受保护表达。
- 长任务保持单一工程状态，持续更新角色、伏笔、章节和版本台账。
- 下游导演与影视制作交给 `$cinematic-production-studio`；画格、封面和电影关键帧交给 `$visual-production-studio`。

