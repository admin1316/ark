# 模块: ai-film-look-engineering（professional-cinematic-image 子模块——AI 生图电影质感工程，联网研究沉淀）

> 来源：GPT Image 2/即梦 Seedream/Midjourney/Nano Banana Pro 官方与第三方实测 + GameRes-DataEye 买量数据 + 本地实拍语法互证。
> 核心结论：电影感=用"能指代光学/物理事实的词"打败模型的"完美默认"；模型默认值（页游CG/绘本光效/3D渲染）恰是真实照片里不存在的东西。

## 1. 各模型词汇响应
- **跨模型无效词**：masterpiece / 8k / ultra-detailed / hyperrealistic / award-winning——现代模型忽略甚至惩罚
- **有效词=具体光学事实**：胶片型号（Kodak Vision3 250D/500T/Portra 400）对 MJ/Flux/Nano Banana/Seedream/Imagen 4 都有效；"authentic film grain" 在 GPT Image 2 成立
- **GPT Image 2**：对话式吃长描述；**无负面词参数**；Responses API 自动改写 prompt；"35mm film grain" 单写是飘的风格标签，要写成句（"grain heavier in shadows"）
- **Midjourney**：光词最强——把提示词当"灯光布置图"写（key light from camera left）
- **即梦/Seedream**：主体→风格→构图→光线→相机解析，前 5-8 词权重最高、30-100 词最佳；材质词很吃
- **Nano Banana Pro**：官方结构 subject+composition+action+location+style；像摄影师指挥镜头（f/1.8/golden hour 逆光/21:9 调色）

## 2. 页游感根源与破解
- **根源**：训练数据里"仙侠/史诗"标签下绝大多数是页游/手游买量 CG（DataEye 证实高度套路化：神域远景/翅膀坐骑/金光大道/武士夹道）
- **机理**：模糊词→先验坍缩——只写"仙侠/金光/神鸟"必落回页游模板
- **破解**：① 写实锚定词 ≥2（photorealistic/real photograph/candid/motivated lighting）② "史诗感"翻译成物理事实（一光源+一时刻+一天气+具体材质）③ 不对称构图词硬破对称（off-center/negative space/foreground obstruction）

## 3. 构图（AI 能执行什么）
- 三分法：写归一化坐标最稳（主体 x=0.382；安全区 x0.05-0.95）
- 前景遮挡（前景物占边缘 10-15%）、负空间、框架构图（门窗框住主体）、dutch angle、S 形视线、远景小人
- **别写指令名**（"add golden spiral"），写视觉路径："视线从前景的手沿烛光落到人物脸上"

## 4. 光影
- 方向词（side/back/rim/top light）、光比词（low key/Rembrandt lighting）、单一光源、体积光限量（只给一处+rim light）
- "全身发光"=绘本感的机理：无来源/无方向/无衰减的光=动画语法；真电影光有动机+平方反比衰减+暗部有内容
- 写法：motivated lighting+指定光源+（"light falls off, shadows retain detail, blacks not crushed"）
- 人脸侧顶 45° 主光保底，禁强逆光脸（易糊成剪影）

## 5. 材质与光学缺陷
- 皮肤毛孔+次表面透光（耳廓透光）；布料纤维（亚麻/丝绸/羊毛）；金属磨损（旧铜露铜/IOR）；云=水汽（柔边无勾线）
- **光学缺陷总和**：Vision3 500T（粗颗粒/橙青分离）/Cooke 球面镜（奶油焦外）/anamorphic 椭圆光斑/暗角/紫边/灰尘光斑/轻微跑焦——且要写位置（"光源右上角一枚灰斑"）
- 本地技能补充：每张图至少 3 类光学证据且写位置；死黑≤10% 只给角落

## 6. 中文 vs 英文（用户要求中文为主时的对策）
- 中文易出 3D 国漫感三机理：① 风格词颗粒度粗（"白底主图"偏暖灰 vs "studio shot on pure white"更纯）② 中文模板常混入 octane/unreal/PBR/8K 渲染语法词 ③ "仙侠"直接命中页游分布
- **对策（中文提示词时）**：用"具体光学事实的中文描述"替代模糊中文风格词（"光从左侧45度窗来"而非"仙气飘飘"）；禁写 octane/unreal/PBR/8K；叙事细节写中文
- 术语对照：电影剧照 cinematic still / 35mm胶片颗粒 / 侧光 / 逆光 / 轮廓光 rim light / 顶光 / 伦勃朗光 / 低调 low-key / 体积光 / 前景遮挡 / 负空间 / 斜构图 / 框架构图 / 抓拍 candid / 动机光 / 实拍 / 暗角 / 低饱和 / 青橙调

## 7. 12 宫格陷阱与对策
- **后半段崩坏**=长序列注意力/一致性衰减（7-12 格丢脸、重复道具）
- **重复镜头**=同 seed 构图趋同；每格分辨率低放大即糊；每格独立采样=不同人
- **对策**：分批 4 格（或单张）逐张质检，别一次 12 格；固定 seed 微调；**锁脸用参考图而非文字**（GPT/Nano Banana：上传参考图并写明用途"Image A 姿态/B 风格/C 背景"；即梦：参考图+身份锚点写进每张+同 seed）；prompt 越模糊身份越漂移

## 8. 负面提示词真相（重要）
- 真有 negative_prompt 字段的只有 Ideogram V3；MJ 的 --no 弱；**GPT Image 2/Nano Banana/Flux/Recraft 完全没有**
- 即梦有负面框，适合"修 bug"（no extra limbs），别写剧情
- **无负面词模型两招**：① "不要X"翻译成正向"必须Y"（禁塑料感→写哑光/织物纹理/磨损）② 多轮编辑圈选修复
- 有效写法：只选本图最可能失败的 3-5 类、10-20 词、删自相矛盾项（要浅景深就别禁 bokeh）
