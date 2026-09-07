---
type: knowledge
loading: on-demand
priority: high
domain:
  - professional-cinematic-image
size: 55
---

# 模块: openai-official-method（professional-cinematic-image 子模块——OpenAI 官方 GPT-Image 提示词方法）

> 来源：OpenAI Cookbook《GPT Image Generation Models Prompting Guide》（官方文档本地镜像，MIT）。写 GPT Image 提示词必须遵守的官方最佳实践。

## 结构顺序（官方推荐）

提示词按固定顺序写：**背景/场景 → 主体 → 关键细节 → 约束**；复杂请求用短标签分段或换行，不用一长段。示例格式（官方认可）：标签式分段（如【场景】【主体】【细节】【约束】）优于长段落。

## 关键方法（每条都来自官方 alpha 测试反复验证）

1. **写实就直说 "photorealistic"**：要照片感就直接写"photorealistic / real photograph / taken on a real camera / professional photography"——这些词强力触发模型的写实模式；相机参数（50mm/T2.0）可以写但模型会宽松解读，主要用于整体感觉而非精确物理模拟
2. **像"正在拍摄的瞬间"来写**：把提示词写成摄影师现场抓拍的口吻（candid photograph），强调真实纹理（毛孔/皱纹/布料磨损/瑕疵），避免"影棚抛光/过度修饰"类词
3. **细节密度与场景类型匹配**：宽画幅/电影感/低光/雨/霓虹场景要**额外加尺度、氛围、色彩细节**，否则模型会用表面写实换取氛围
4. **人物描述四要素**：尺度（全身含脚/相对桌子的高度）、身体取景（full body visible, feet included）、视线（looking down at the book, not at the camera）、物体互动（hands naturally gripping）
5. **约束显式化**：明确排除项（no watermark/no extra text/no logos）+ 明确保留项（preserve identity/geometry/layout）；编辑场景用"只改 X + 其他全保持"，每轮迭代重复保留清单防漂移
6. **迭代优于堆叠（核心）**：长提示词可以工作，但**调试时从干净的基线提示词开始，用小改动单步精修**（"make lighting warmer"、"remove the extra tree"）——不要一次堆全部要求；用"same style as before / the subject"引用上下文，关键细节漂移时重新指定
7. **质量档位**：默认 medium；小字/密集信息/特写人像/身份敏感/高分辨率用 high；大批量变体/快速试错用 low

## 对长提示词的纪律（我们踩过的坑）

- 超长中文提示词（>500 字）在对话式界面中，模型会稀释重点——**把最关键的三条约束放最前**（本帧必须/本帧禁入/亮度档），其余细节放后面
- 一次生成只改一个变量：先出基线，再单步调（亮度→构图→材质→细节），每步只改一处
- 系列图：第一张定风格基线，后续用 "same style as before, same lighting, same character" 引用上下文
- 每轮迭代把"保留清单"重复写一遍（防漂移）："保持人物服装/发型/船/桃花瓣不变，只改光线"

## 官方质量参数参考

- gpt-image-2：最高质量默认；支持任意分辨率（最长边 <3840px，长边:短边 ≤3:1，总像素 65万-829万）
- 常用尺寸：HD 竖版 1024x1536 / HD 横版 1536x1024 / 方形 1024x1024 / 2K 2560x1440（可靠性上限）
- 出图 >2560x1440 视为实验性，结果可能不稳定
