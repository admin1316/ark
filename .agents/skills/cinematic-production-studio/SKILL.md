---
name: cinematic-production-studio
description: 影视制作工作室。把小说、故事、剧本或概念转化为短剧/漫剧、可演剧本、互动影游结构、导演定调、文字分镜、镜头连续性和 Seedance/可灵等 AI 视频执行稿。Use when 用户要求小说改编、竖屏剧、剧本、导演方案、镜头语言、运镜、动作 VFX、首尾帧、物理相机、音画衔接或多结局互动叙事；不负责小说正文、真正绘制分镜画格或单张电影关键帧。
---

# 影视制作工作室

影视任务只有一个入口，内部按“改编 → 剧本/互动结构 → 导演 → 执行稿”路由。全流程任务共享同一人物、场景、轴线、符号锁和连续性状态。

## 路由

| 任务 | 主模块 |
| --- | --- |
| 小说改短剧、漫剧、竖屏剧、爆点与平台节奏 | `modules/short-drama-ai-suite/instructions.md` |
| 小说/大纲到可演剧本 | `modules/inkos-script-writing/instructions.md` |
| 互动影游、多结局、变量旗标 | `modules/inkos-interactive-film/instructions.md` |
| 开放世界、分支互动、状态和时间推进 | `modules/inkos-play-world/instructions.md` |
| 导演定调、表演调度、镜头语言、九列分镜 | `modules/director-master/instructions.md` |
| 严格逐镜执行、物理相机、动作/VFX、声音与连续性 | `modules/cavok-director-os/instructions.md` |
| 一次性交付角色、场景、剧本、分镜与视频提示词 | `modules/cinematic-prompt/instructions.md`，但仍服从本入口的连续性与安全规则 |

`modules/cavok-director-os/skills/cavok-director/instructions.md` 是执行模块内部的精简导演角色，不作为独立 Skill 发现入口。

## 执行顺序

1. 锁定媒介、受众、时长、画幅和叙事目标。
2. 先完成可演结构与场面调度，再设计摄影机和剪辑。
3. 需要 AI 视频时，为每镜写可见动作、物理环境、音画、首尾帧和禁止项。
4. 验证轴线、时空、人物/道具锚点、动作接续、声音和渲染字段。

## 边界

- 不把心理结论伪装成可拍画面；不发明相机、渲染或平台参数。
- 不承诺审核必过、生成必现或商业必爆。
- 不帮助侵犯肖像/IP，不未经授权上传、发布、购买或删除。
- 真正生成连续分镜画格、封面或关键帧时转交 `$visual-production-studio`。

