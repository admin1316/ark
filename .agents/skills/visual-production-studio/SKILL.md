---
name: visual-production-studio
description: 视觉制作工作室。用于把剧本、镜头表、故事或视觉概念完成为连续分镜画格、storyboard、首尾帧、角色/场景连续性方案、故事封面、电影关键帧、海报、概念图和仙侠大境等专业视觉提示词。Use when 用户要画分镜、生成画格或封面、设计写实电影画面、诊断 AI 感、锁定物理相机与材质；不绑定固定图像 provider，也不负责小说正文或导演文字分镜。
---

# 视觉制作工作室

这是所有静态视觉与画格任务的唯一入口。先确定交付物，再加载一个主模块；实际生成图像时使用当前会话明确可用的图像工具，不绑定或伪装任何固定内部 provider。

## 路由

| 任务 | 主模块 |
| --- | --- |
| 导演镜头表到连续、可编号、可复核分镜画格 | `modules/visual-storyboard-master/instructions.md` |
| 剧本/叙事到可拍、可画、可生图的视觉拆解 | `modules/inkos-storyboard/instructions.md` |
| 作品封面与平台视觉方向 | `modules/inkos-story-cover/instructions.md` |
| 写实电影关键帧、海报、概念图、物理相机与材质 | `modules/professional-cinematic-image/instructions.md` |
| 克制电影真实感、去 AI 感的英文执行提示词 | `modules/zy-cinematic-realism/instructions.md` |
| 东方仙侠大境、云海宫城与神性尺度 | `modules/xianxia-visual-director/instructions.md` |

## 联合流程

需要“分镜板 + 精选关键帧”时，先由分镜模块锁定镜号、轴线、动作与首尾帧，再仅对关键镜使用电影关键帧模块。所有画格复用人物 CH、道具 PR、环境 EN、光线 LG 锚点。

## 质量规则

- 单主体、单焦点；空间、机位、光源和材质必须可见、可验证。
- 连续画格必须保留角色身份、服装、道具、轴线、视线和动作接续。
- 不把风格词堆叠当作视觉设计；物理相机与材质字段必须真实。
- 生成结果必须实际检查，不得把提示词或工具返回当成已验收成图。
- 涉及真人肖像、第三方 IP、上传或发布时遵守授权边界。
