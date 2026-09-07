# Routing Test（五工作室路由测试）

验证：用户任务只命中一个产品级工作室，再按需加载 1 个内部主模块和必要参考；不得回退到旧 Skill 名或一次加载全部模块。

## 场景 1：写长篇小说

- 用户："写一部都市悬疑小说第一章，并规划后续连载。"
- 应加载：`story-creation-studio/SKILL.md` + `modules/inkos-long-writing/instructions.md`；需要阶段制规划时再补 `modules/chinese-novelist/instructions.md`。
- 不应加载：短篇、影视、视觉、翻译或媒体模块。
- 检查点：故事事实、人物、伏笔和章节状态只有一个 owner。

## 场景 2：把小说改成竖屏漫剧并出执行镜头

- 用户："把这篇小说改成竖屏漫剧，并给出可生成的视频镜头。"
- 应加载：`cinematic-production-studio/SKILL.md` + `modules/short-drama-ai-suite/instructions.md`；进入逐镜执行时再补 `modules/cavok-director-os/instructions.md`。
- 不应加载：故事正文创作或实际分镜画格模块。
- 检查点：改编、导演和执行共享同一人物、轴线、首尾帧和连续性状态。

## 场景 3：制作连续分镜画格或电影关键帧

- 用户："把这份镜头表画成连续分镜板，并精修三张关键帧。"
- 应加载：`visual-production-studio/SKILL.md` + `modules/visual-storyboard-master/instructions.md`；精修关键帧时再补 `modules/professional-cinematic-image/instructions.md`。
- 不应加载：固定图像 provider 或重新改写导演镜头。
- 检查点：CH/PR/EN/LG 锚点、轴线和动作连续。

## 场景 4：翻译长篇文档

- 用户："把这份长文翻成英文，保持术语和人物名一致。"
- 应加载：`translation-studio/SKILL.md` + `modules/inkos-translation/instructions.md`。
- 不应加载：故事改写、视觉或媒体模块。
- 检查点：代码、路径、ID 和指定产品名不被误译。

## 场景 5：制作并渲染视频

- 用户："把这些素材做成一支 45 秒品牌短片，先给预览。"
- 应加载：`media-production-studio/SKILL.md` + `modules/hyperframes/instructions.md`；自由多场景构建再进入 `modules/general-video/instructions.md`。
- 不应加载：所有 HyperFrames 子模块全文；只按阶段读取 core、creative、animation、media 或 CLI。
- 检查点：确定性时间线、冻结本地资产、check、真实预览、批准后渲染。

## 判定标准

- 活动发现入口恰好为五个工作室；内部 `modules/**/instructions.md` 不被宿主单独发现。
- 任务主工作室唯一；内部主模块不多加载、不漏加载。
- 无旧独立 Skill 名、无重复 Codex/Claude 发现层、无固定 Qwen 生图入口。
- Native Ark `skill.list` 与原生菜单返回相同五项，连续打开菜单时 CPU 不出现持续布局循环。

