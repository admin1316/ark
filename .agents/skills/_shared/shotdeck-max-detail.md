---
type: knowledge
loading: on-demand
priority: high
domain:
  - all-skills
size: 70
---

# 电影剧照级细节标准（ShotDeck 级十维全细节——AI 生图提示词"特别细节"的完整检查清单）

> 来源：ShotDeck（Lawrence Sher 创办，全球最大电影剧照库）分类体系 + 好莱坞剧照细节标准。**生图提示词要达到"剧照级"，必须覆盖以下十维**；缺失任一维，画面就缺一维的真实感。与 shotdeck-standard-language.md（五维基础词库）配合使用。

## 十维细节清单（写提示词时逐维检查）

### 1. 景别 Framing（选一）
ECU / CU / MCU / MS / MWS / WS / EWS / XWS + Single/Two-Shot/OTS/Group/Insert
> 细节：主体占画面高度比例（如"脸占 15%""全身从 y=0.3 到 y=0.85"）

### 2. 机位 Camera（角度+高度+轴线）
角度：Eye Level / High / Low / Bottom Up / Top Down / Dutch / OTS / POV / Profile / Straight-on
高度：写清楚（"机位在人物胸口高度"）
轴线：写主体朝向（"面向画右，视线留白在右"）

### 3. 镜头 Lens（焦段+光学+景深）
焦段：Wide ≤35 / Standard 40-50 / Medium Tele 75-100 / Tele 135+
光学：Spherical / Anamorphic / Macro
景深：写清哪个层清晰哪个层虚化（"主体全焦，前景 15% 虚化，背景 35% 虚化"）

### 4. 灯光 Lighting（方向+风格+光源+光质）
方向：Front / Side / Side-top 45° / Top / Under / Backlit / Rim
风格：High Key / Low Key / Chiaroscuro / Rembrandt / Butterfly
光源：Practical / Available / Neon / Candle / Window / Slit / Screen
光质：硬光 Hard（清晰阴影）/ 柔光 Soft（渐变阴影）/ 体积光 Volumetric（丁达尔）
> 细节：每个光各写色温+方向+作用（"主光 45° 暖金 5200K 照亮右脸；轮廓光冷蓝 6500K 勾勒发梢"）

### 5. 色彩 Color（色板+温度+饱和度+分布）
色板：Monochrome / Duotone / Complementary / Analogous / Clash
温度：Warm / Cool / Neutral / Mixed
分布：写百分比（"冷青灰 70% + 暖金 25% + 粉 5%"）
> 细节：指定"唯一强调色"（画面中只有一个高饱和点）

### 6. 质感 Texture（表面处理+颗粒+光学缺陷）
表面：胶片颗粒 Film Grain / 哑光 Matte / 光泽 Glossy / 油画 / 水墨
颗粒度：Fine / Medium / Heavy
光学缺陷（实拍证据）：暗角 Vignette / 眩光 Flare / 紫边 Chromatic Aberration / 跑焦 Soft Focus / 辉光 Halation
> 细节：写 1-2 个光学缺陷（无缺陷=CG 感）

### 7. 表演 Performance（表情+姿态+微动作）
表情：眼/眉/嘴/呼吸/视线 各自状态（"眉心微蹙未成川字，嘴唇轻抿，视线低垂"）
姿态：重心/肩线/手的动作（"重心微后移，右手垂身侧指节微蜷"）
> 细节：禁止笼统情绪词（悲伤/愤怒），只写可见证据

### 8. 环境与道具 Environment/Props（分层+材质+状态）
分层：前景/中景/后景 各写内容+虚化度
道具：数量/位置/状态（"桃花瓣三瓣贴船舷，一瓣边缘微卷带水珠"）
> 细节：道具必须有材质描述（"乌木船身纵向木纹旧蚀痕，水痕凹槽深色堆积"）

### 9. 时间与天气 Time/Weather（时段+光线条件）
时段：Day / Dusk / Night / Blue Hour
天气：晴/雾/雨/雪/阴（"雾云能见度数丈"）
> 细节：环境光的行为（"雾中漫射光，无直射"）

### 10. 情绪与叙事 Mood/Narrative（一帧的潜台词）
画面传递的情绪基调 + 观众应读到的信息
> 细节：写"这一帧正在发生什么"+"观众应该感觉到什么"

## 十维检查法（出图前逐维自检）

写完后逐维过：① 景别选了？主体比例写了？② 机位角度+高度+朝向写了？③ 焦段+景深分层写了？④ 光的方向/风格/光源/光质+色温全写了？⑤ 色彩分布百分比+唯一强调色写了？⑥ 质感+光学缺陷写了？⑦ 表演是可见证据不是情绪词？⑧ 环境三层+道具材质写了？⑨ 时段天气写了？⑩ 情绪潜台词写了？——十维全过 = 剧照级；缺 3 维以上 = 需要重写。

## 记忆点（提示词的最后加分项）

- ShotDeck 顶级剧照的共同点：**一眼可辨的焦点 + 一组克制的光色 + 一个真实质感 + 一层叙事潜台词**
- 细节不是堆砌：十维每维 1-2 个具体词就够，写多了模型会稀释重点
- 最容易被忽略的三维：光质（软硬）、光学缺陷、表演可见证据——这三维是"AI 味"和"剧照感"的分水岭
