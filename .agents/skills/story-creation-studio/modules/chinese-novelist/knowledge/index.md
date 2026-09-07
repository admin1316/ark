# chinese-novelist Knowledge Index（深档索引层）

> 深档不默认加载；先看用途→章节→只读对应小节。metadata（loading: on-demand）已标注。

## references/guides/chapter-guide.md（744 行 · 按需加载）

- 用途：chapter-guide — ## 前 20% 决定生死；## 十种强力开头技巧；## 打破读者预期；## 中文文学技法；## 标准章节结构；## 章节类型分类
- 调用：任务匹配chapter-guide主题时读取
- 读取：只读对应小节，不读全文

## references/guides/content-expansion.md（532 行 · 按需加载）

- 用途：content-expansion — ## 扩充前的判断；## 技巧一：场景肌理充实；## 技巧二：关键时刻放慢；## 技巧三：内心世界展开；## 技巧四：对话层次丰富；## 技巧五：次要情节穿插
- 调用：任务匹配content-expansion主题时读取
- 读取：只读对应小节，不读全文

## references/guides/hook-techniques.md（504 行 · 按需加载）

- 用途：hook-techniques — ## 悬念钩子十三式；## 章节间悬念连接；## 章首引子七式；## 悬念设置禁忌；## 悬念强度等级；## 悬念编排策略
- 调用：任务匹配hook-techniques主题时读取
- 读取：只读对应小节，不读全文

## references/guides/dialogue-writing.md（319 行 · 按需加载）

- 用途：dialogue-writing — ## 对话核心原则；## 对话格式规范；## 潜台词（Subtext）；## 对话与动作结合；## 对话节奏进阶；## 对话场景类型
- 调用：任务匹配dialogue-writing主题时读取
- 读取：只读对应小节，不读全文

## README.md（298 行 · 按需加载）

- 用途：README — ## ✨ 为什么用这个？；## 🚀 快速开始；## 🖼️ 使用过程；## 🧠 创作记忆；## 📊 创作流程；## 📖 输出样例
- 调用：任务匹配README主题时读取
- 读取：只读对应小节，不读全文

## references/guides/plot-structures.md（268 行 · 按需加载）

- 用途：plot-structures — ## 三幕式结构（Three-Act Structure）；## 英雄之旅（Hero's Journey）；## 悬疑小说结构；## 言情小说结构；## 惊悚/动作结构；## 反转结构（Twist-Based）
- 调用：任务匹配plot-structures主题时读取
- 读取：只读对应小节，不读全文

## references/guides/character-building.md（217 行 · 按需加载）

- 用途：character-building — ## 核心原则：矛盾创造深度；## 侧面揭示技法；## 主角塑造；## 反派塑造；## 配角的功能性；## 人物关系设计
- 调用：任务匹配character-building主题时读取
- 读取：只读对应小节，不读全文

## references/flows/phase3-writing.md（208 行 · 按需加载）

- 用途：phase3-writing — ## 0. 启动检测与模式读取；## 1. 逐章创作流程（通用，所有模式共用）；## 2. 串行模式（writingMode: "serial"）；## 3. 子Agent并行模式（writingMode: "subagent-parallel"）；## 项目信息；## 创作步骤
- 调用：任务匹配phase3-writing主题时读取
- 读取：只读对应小节，不读全文

## references/flows/phase1-layer2-customize.md（186 行 · 按需加载）

- 用途：phase1-layer2-customize — ## Q4：世界观/背景设定；## Q5：叙事视角与基调；## Q6：核心主题/价值观；## Q7：读者定位与风格参考；## Q8：章节数量与特殊要求；## 全部问答完成 → 配置确认
- 调用：任务匹配phase1-layer2-customize主题时读取
- 读取：只读对应小节，不读全文

## references/flows/phase1-layer1-core.md（153 行 · 按需加载）

- 用途：phase1-layer1-core — ## Q1：题材与创意概要；## Q2：主角与关系网络；## Q3：核心冲突与驱动力；## 第一层完成 → 摘要展示与过渡；## 已收集信息
- 调用：任务匹配phase1-layer1-core主题时读取
- 读取：只读对应小节，不读全文

## references/flows/shared-infrastructure.md（142 行 · 按需加载）

- 用途：shared-infrastructure — ## 三大黄金法则；## 用户偏好系统；## 标题传递机制；## 写作计划系统；## 字数检查脚本
- 调用：任务匹配shared-infrastructure主题时读取
- 读取：只读对应小节，不读全文

## references/guides/title-guide.md（128 行 · 按需加载）

- 用途：title-guide — ## 题材-风格映射；## 标题创作技巧；## 质量标准
- 调用：任务匹配title-guide主题时读取
- 读取：只读对应小节，不读全文

## references/flows/phase1-layer3-title.md（95 行 · 按需加载）

- 用途：phase1-layer3-title — ## Step 1：分析创意元素；## Step 2：生成候选标题；## Step 3：展示与选择；## Step 4：确认标题并过渡
- 调用：任务匹配phase1-layer3-title主题时读取
- 读取：只读对应小节，不读全文

## 加载策略

- 热路径（每次）：SKILL.md + 技法模块（≤80 行）
- 按需路径：本索引对应深档的小节
- 禁止：一次读取深档全文（除非用户明确要求）