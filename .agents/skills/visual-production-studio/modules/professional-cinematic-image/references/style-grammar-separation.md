---
type: knowledge
loading: on-demand
priority: high
domain:
  - professional-cinematic-image
size: 50
---

# 模块: style-grammar-separation（professional-cinematic-image 子模块——风格语法分离，根治"3D 国漫感/CG 感"）

## 核心原理

写实、卡通、插画、3D 动画各有自己的**视觉语法**（画面特征的组合）。AI 出"3D 国漫感"的根因：提示词里混入了 3D/动画语法的词（光滑、发光、飘带、鲜艳、完美构图），写实语法被稀释。**要电影写实感，必须全程只用摄影语法，并显式禁用动画/3D 语法。**

## 两种语法的对照（写提示词时逐条检查）

| 维度 | 电影写实语法（要） | 3D 国漫/动画语法（禁） |
|------|------------------|----------------------|
| 表面 | 哑光、织物纹理、磨损、瑕疵、毛孔、不均 | 光滑、干净、塑料感、完美无瑕 |
| 光 | 动机光（有来源）、自然曝光、柔和滚降、环境光反射 | 装饰性体积光、发光描边、霓虹辉光、无来源发光 |
| 影 | 阴影过渡平滑、黑位有层次、暗部有内容 | 硬边阴影、纯黑死黑、发光投影 |
| 质感 | 胶片颗粒、暗角、眩光、紫边、跑焦、光学缺陷 | 零颗粒、全画面锐利、HDR 感 |
| 构图 | 偏离中心、负空间、遮挡、不对称、观察式 | 完美居中、对称海报感、英雄式摆拍 |
| 人物 | 自然姿态、具体小动作、视线回避镜头、情绪含蓄 | 摆拍姿势、直视镜头、模特表情、完美脸 |
| 色彩 | 低饱和、局部强调色、肤色自然 | 高饱和撞色、全局滤镜、青橙割裂 |
| 细节 | 选择性清晰（焦点内锐利、其余虚化/落影/遮挡） | 均匀清晰、每个道具同等清楚 |

## 写实锚定词（提示词必带 2-3 个）

- `photorealistic` / `real photograph` / `taken on a real camera`（官方写实触发词）
- `35mm film grain` / `natural exposure` / `soft highlight roll-off` / `lens falloff`（胶片语法）
- `candid photograph` / `unposed` / `shot in the moment`（抓拍语法）
- `motivated lighting` / `practical light source`（动机光）
- `imperfect, worn, lived-in textures`（真实磨损）

## 禁用词（写实图负面必加 3-5 个动画/3D 语法词）

`3D render, CGI appearance, video game screenshot, digital illustration, anime style, cartoon render, cel shading, smooth plastic surfaces, glossy highlights, perfect symmetry, hero pose, poster composition, decorative glow, neon rim light, oversaturated colors`

规则：**只选 3-5 个最可能失败的**，别全贴（负面向导会稀释）。

## 自查（出图前）

① 提示词里有没有混入动画/3D 语法词（光滑/发光/飘带/鲜艳）？有=删 ② 摄影语法写实锚定词 ≥2 个？③ 负面含 3D/CG/动画词 ≥3 个？④ 人物是"正在发生的动作"不是摆拍？⑤ 构图有负空间/遮挡/不对称？——五项全过才出图。
