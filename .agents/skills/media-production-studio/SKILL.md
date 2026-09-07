---
name: media-production-studio
description: 媒体与视频制作工作室，也是 HyperFrames 的唯一入口。用于创建、编辑、动画化、预览、检查或渲染视频/动效/标题卡/字幕/旁白/音频响应画面，管理图片、音频、图标、品牌素材与处理效果，或操作 HyperFrames CLI、registry、keyframes 和确定性时间线。Use when 用户要制作或修改视频、动效、媒体资产或诊断 HyperFrames 项目；不用于小说、导演文字分镜或单张电影画面创意。
---

# 媒体与视频制作工作室

所有 HyperFrames 与媒体能力只从这里进入。新的视频/动画任务先读取主流程；编辑现有项目时从受影响模块开始，不重新做无关发现。

## 路由

| 任务 | 主模块 |
| --- | --- |
| 新建/编辑/诊断任何 HyperFrames 视频或动画 | `modules/hyperframes/instructions.md` |
| 无专用流程的多场景、混剪、品牌片或自由构建 | `modules/general-video/instructions.md` |
| composition 结构、timing、tracks、sub-composition、确定性 | `modules/hyperframes-core/instructions.md` |
| 视觉方向、配色、字体、节拍、叙事与品牌 | `modules/hyperframes-creative/instructions.md` |
| 动画规则、蓝图、转场、GSAP/Lottie/Three/WebGPU | `modules/hyperframes-animation/instructions.md` |
| 精确 2D/3D keyframes、FLIP、路径、mask、SVG morph | `modules/hyperframes-keyframes/instructions.md` |
| init/check/preview/render/cloud/doctor 等 CLI | `modules/hyperframes-cli/instructions.md` |
| registry block/component 的发现、安装和接线 | `modules/hyperframes-registry/instructions.md` |
| BGM、SFX、图片、图标、logo、配音、字幕、调色和媒体处理 | `modules/media-use/instructions.md` |

## 不可破坏的合同

- HyperFrames 作品必须使用单一 paused、seek-safe、确定性时间线；禁止渲染时网络、时钟、未播种随机数和无限循环。
- 创作前确定设计与叙事目标；视频检查通过不等于用户已批准渲染。
- 媒体先解析为冻结的本地资产并记录来源；不得伪造品牌标识或静默上传用户素材。
- 先跑快速 lint，再跑最终 check；实际预览通过后才可渲染，渲染后还要核验文件和时长。
- 只按需打开内部参考，避免一次加载整个媒体知识库。

