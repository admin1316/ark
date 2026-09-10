---
name: chinese-novelist
description: 中文小说创作大师：分阶段完成题材定位、世界观、人物、大纲、章节写作、悬念设计和质量校验，适用于悬疑、言情、奇幻、科幻与历史等类型。创作期同步交付符号锁资产表（道具/锚点/光源编码）、钩子动力学登记（驱动/悬念/危机/情感四型）与伏笔台账（埋设/噪音/回收），为改编与分镜提供源头资产。用户要求写小说、创作长篇故事、分章节续写、设计章节钩子、登记符号锁/伏笔台账或检查小说结构时使用（Use when）。
---

# 中文小说创作大师

主文件只保留流程骨架与路由；写作技法按需读取对应模块（每个 ≤80 行，一次只读 1-2 个）。

## 三大黄金法则

1. **展示而非讲述** - 用动作和对话表现，不要直接陈述
2. **冲突驱动剧情** - 每章必须有冲突或转折
3. **悬念承上启下** - 每章结尾必须留下钩子

## 特性说明

- **中断续写**：自动检测未完成项目，从断点继续创作
- **自动校验**：创作完成后自动检查字数和质量，不合格自动修复
- **并行写作**（可选）：支持子Agent并行写作，通过 `02-写作计划.json` 协调状态

## 核心流程（进入每阶段先读对应流程文档）

1. **第0步 初始化**：读偏好、检测未完成项目、个性化欢迎 → `references/flows/phase0-initialization.md`
2. **第一阶段 三层递进问答**：核心定位（题材/主角/冲突）→ `phase1-layer1-core.md`；深度定制（世界观/视角/主题/读者/章节数）→ `phase1-layer2-customize.md`；标题生成 → `phase1-layer3-title.md`
3. **第二阶段 规划+确认**：建项目文件夹、生成大纲/人物档案/写作计划 JSON → `references/flows/phase2-planning.md`
4. **第2.5步 写作模式**：逐章串行 / 子Agent并行 / Agent Teams → `references/flows/phase3-writing.md`
5. **第三阶段 疯狂创作**：禁止向用户确认，按大纲逐章写完才汇报；每章前读 `01-大纲.md` 对应规划 → `references/flows/phase3-writing.md`
6. **第四阶段 自动校验修复**：检查章节完成度与字数，不合格自动重写（最多 3 轮）→ `references/flows/phase4-validation.md`

> **深档索引**：技能内 >80 行的深档（方法论/风格库/流程文档）不默认加载；需要时先查 `knowledge/index.md` 的用途→章节→只读对应小节，并按文件头 metadata（loading: on-demand）判断。
> **震惊工程**：产出必须过震惊点检查——画面/章节/方案里至少一个观众预期之外的元素（反常元素/情绪炸弹/隐喻层/唯一性指纹），标准见 `../_shared/shock-engineering.md`。先专业后震惊，顺序不能反。

## 技法路由（按任务读取，一次 1-2 个）

- **情绪/群像/空镜**（微表情写作+群体表演三级+文学空镜）→ `references/emotion-scene.md`
- **惊艳细节速查卡**（手的背叛/反方向第一动作/感官具体等）→ `references/detail-card.md`
- **动作/高潮场面**（空间地图/逻辑链/节奏呼吸/关键帧放大）→ `references/action-climax.md`
- **视角与信息控制**（POV 四型/信息差/切换纪律）→ `references/pov-info.md`
- **伏笔管理+符号锁钩子登记**（伏笔三问/三账）→ `references/foreshadow.md`
- **类型化爆款结构**（言情五阶/悬疑反转链/奇幻五段/历史双轨）→ `references/genre-templates.md`
- **中式怪谈/志怪法则**（恐惧六型/氛围三器/规则设计/被卷入者主角——怪谈专用，与爽文法则严格区分）→ `references/guaitan-horror.md`
- **怪谈的戏**（试探规则/信息拉锯对话/半句台词法/小步试探清单——只有氛围没有戏=空壳，本章补冲突）→ `references/guaitan-scenes.md`
- **怪谈名场面工程**（第一章必须有一个"合上书还想得起"的画面：物件悖逆/规则显形/瞬间反身/体温异常/声音缺席——先定名场面再写故事）→ `references/guaitan-showpiece.md`
- **克制文笔十二法**（重复短句/否定式/温度恐惧/物件凭空出现/对话留白/环境声层/身体直觉等——怪谈悬疑的质感来源，与怪谈法则配套）→ `references/restraint-prose.md`
- **中式怪谈写作硬规则**（恐怖来自规矩裂缝/禁忌五件套/警语贯穿/三起三落/前1000字打勾清单——联网研究）→ `references/guaitan-craft.md`
- **故事骨架硬规则**（欲望×阻碍×选择×代价/三幕式/救猫咪15拍/事件三判据/威胁四层/一章四拍——联网研究）→ `references/story-skeleton.md`
- **第一章开篇硬规则**（前3句反常/300字冲突/500字五动作/1000字一戏/四型钩子/挤牙膏——联网研究）→ `references/opening-chapter.md`
- **被卷入型主角写作**（力量差=恐怖燃料/动词式欲望/智慧边界/失忆三通道/恐惧行为化/试探规则——联网研究）→ `references/entrapped-protagonist.md`
- **顶级怪谈开篇拆解**（画皮/崂山道士/聂小倩/鬼吹灯/河神共性规律/中式vs日式/香火献祭落地建议——联网研究）→ `references/guaitan-openings.md`
- **十角度审核法**（叙事逻辑/怪谈法则/规则/文笔/钩子/人物/节奏/伏笔/对话/改编——成稿后逐角度审核，修复时保优点动问题逐条验）→ `references/review-ten-angles.md`
- **大纲节奏+角色弧光**（爽点分布/钩子链/弧光五问）→ `references/outline-arc.md`
- **顶流门面工程**（标题/简介/黄金章/平台适配）→ `references/facade.md`
- **世界构建**（三层结构/规则三性/设定冰山）→ `references/worldbuilding.md`
- **章节质量校验**（钩子/冲突/节奏/感官/人物声音/连贯性）→ `references/quality-check.md`
- **怪谈视觉化衔接（怪谈小说→生图提示词的桥梁）**：视觉母题=恐惧的具象化符号（灯/钟/花瓣/酒），每章写清“本帧必须/本帧禁入”（防跨章节道具污染）；震惊元素选“日常入侵”型（花瓣是湿的）而非“血腥惊悚”型；画面氛围靠“静默反差”（满席笑无人吃）不靠鬼气发光——详见 references/guaitan-horror.md 第六节
- **顶流网文实证法则**（情感锚定/打脸升级六级/配角功能/金手指节奏/甜虐比/催泪公式/反派前史/结尾三型——30 本高分网文数据）→ `references/wangwen-empirical.md`

## 共享机制

偏好系统、写作计划系统、黄金法则详解、字数检查脚本等跨阶段共享机制 → `references/flows/shared-infrastructure.md`；章节写作辅助 → `references/guides/*`（chapter-guide/character-building/dialogue-writing/hook-techniques/plot-structures/title-guide 等）。
