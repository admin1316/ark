---
name: novel-characters
description: 小说角色资产师：从小说或短故事中提取有原文证据的角色表、人物画像、视觉提示词、音色提示词和主要角色三视图方案，并生成 JSON、Markdown 与本地报告。每角色交付锚点编码（CH-XX：外观/行为/随身锚点，可跨媒介验证）、渲染材质物理参数（皮肤 SSS/发丝/布料/金属 IOR，供 UE/Redshift 等管线直用）与主光适配备注，是分镜/执行稿/关键帧的角色资产源头。用户要求拆解小说角色、制作人物小传、角色卡、选角表、音色设计、角色锚点编码、渲染材质参数或角色三视图时使用（Use when）。
---

# 小说角色资产师

输入一篇小说/短故事，输出每个角色的：人物画像、卡通形象提示词、音色提示词、三视图。

`{baseDir}` = 本文件所在目录。脚本 `{baseDir}/scripts/novel-characters.mjs`，零依赖，`node` 直接跑。**运行环境**：Claude Code 和 codex 都能跑；差别只在第 8 步出图。

## 核心流程（Step 骨架，细节见对应模块）

1. **定位输入**：用户给路径直接用；粘贴正文先落到临时 .txt（校验引文逐字需要原文）；确定输出目录。
2. **分块**：`node {baseDir}/scripts/novel-characters.mjs chunk <book.txt> <workdir>`；N==1 跳过扫描直接本会话读；N>1 进 Step 3；`truncated: true` 要明说。
3. **第一趟扫描**（仅 N>1）：支持子代理就并发（同一条消息全部调用=真并发）；每个子代理读 roster-pass.md + chunk，写 roster-NN.json。
4. **归并**：`node ... merge <workdir>`，按名字+别名收敛，notes 累加、quotes 去重，按出现块数降序。
5. **选角**：取前 N 位（默认 10）；剩余角色在汇报里提一句「还识别出 X 位没做画像」。选角参考与关系网见 `references/casting-network.md`。
6. **第二趟出卡**：每角色一份（可并发）；读 profile-pass.md + schema.md + 同批其他角色名（避免长相声线撞车）。音色设计见 `references/voice-performance.md`。
7. **校验 ⛔ 不能跳**：引文逐字、锚点可跨媒介验证、材质参数真实字段；不过就修。
8. **三视图**（可选，protagonist/major）：按 `references/three-view.md` 调用契约；没有 codex 就整步跳过只交提示词；一个角色一次调用绝不批量。
9. **输出**：角色卡 JSON 到 card-<slug>.json + 故事摘要 + 合成 cast.json；输出格式细节见 `references/output-format.md`；每角色锚点与材质参数见 `references/anchor-materials.md`（下游分镜/执行稿/关键帧消费）。
10. **汇报**：一句话说清角色数、出图数、报告路径；校验没过说明修了什么；出图失败/截断/无 codex 明确说清楚。

> **深档索引**：技能内 >80 行的深档（方法论/风格库/流程文档）不默认加载；需要时先查 `knowledge/index.md` 的用途→章节→只读对应小节，并按文件头 metadata（loading: on-demand）判断。
> **震惊工程**：产出必须过震惊点检查——画面/章节/方案里至少一个观众预期之外的元素（反常元素/情绪炸弹/隐喻层/唯一性指纹），标准见 `../_shared/shock-engineering.md`。先专业后震惊，顺序不能反。

## 路由（按需读取模块）

- 音色设计 + 表演资产与群像定位（七段链/锚点/情绪光谱）→ `references/voice-performance.md`
- 选角参考 + 角色关系网（关系四要素/未结清账驱动）→ `references/casting-network.md`
- **角色深度**（脊柱/Want vs Need/灵魂创伤/压力揭示性格/脆弱点——皮克斯方法论）→ `references/character-depth.md`
- 角色锚点编码 CH-XX + 渲染材质物理参数（SSS/布料/金属）+ 主光适配 → `references/anchor-materials.md`
- 三视图调用契约（codex 探测/单角色单次/拷贝规则）→ `references/three-view.md`
- 输出与交付格式（performance-bible/渲染命令/报告结构）→ `references/output-format.md`
- 第一趟扫描模板 → `references/roster-pass.md`；出卡模板 → `references/profile-pass.md`；校验 schema → `references/schema.md`；三视图契约 → `references/turnaround.md`

## 边界

- 单次上限 24 块（约 33 万字符），超了会明确报 `truncated`，不静默截断
- **可生图锚点纪律（角色卡供生图直接消费）**：锚点描述必须具体到不可误解（“米灰粗麻袍、织纹可见、下摆浸水变深”而非“素色旧袍”）；材质词写物理行为（weave visible/hem darkened）；避免“神秘/缥缈”类空词——角色卡就是生图提示词的素材库，卡上每个词都要能落在画面上
- **输出中文优先**：`persona` 和 `voice` 的描述字段强制中文，校验器会拦英文。分析英文原著也照样出中文角色卡
- 用户要求微表情/哭戏/真人表演层时，先完整读取 [真人微表情与连续表演合同](../_shared/micro-expression-performance-contract.md)，额外交付 performance-bible，禁止把通用词库模板复制到所有镜头

## 自测

- 引文是否逐字可回溯？锚点是否可跨媒介验证？材质参数是否真实字段？
- 表情库与锚点是否分开交付（锚点进 JSON，表情进表演圣经）？
- 关系网是否随 cast 交付？群像定位是否登记？
