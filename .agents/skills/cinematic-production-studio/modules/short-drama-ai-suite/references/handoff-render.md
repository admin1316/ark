# 模块: handoff-render（short-drama-ai-suite 子模块，按需加载）

### AI 视频镜头衔接专家技法（逐镜生成后如何无缝接成完整视频，成片前必做）

- **衔接的本质**：AI 视频是逐镜独立生成的片段，'衔接设计'在生成前做（分镜标注），在生成后验（末帧/首帧比对）；缺衔接的逐镜生成 = 幻灯片
- **衔接帧纪律（最高优先级）**：每镜生成前必须定义'出点帧'（本镜最后一帧的画面状态）与下一镜的'入点帧'（首帧画面状态）；出点与入点的角色姿势/道具位置/光源方向必须一致（可直接叠化重合），不一致则重写其中一镜的提示词
- **转场五型（按需选用，生成时写入提示词）**：硬切（动作或视线引导，最常用）· 叠化（时间流逝/回忆，0.3-0.5s）· 动作匹配剪（上一镜动作的结束姿势 = 下一镜动作的起始姿势——AI 视频最强的衔接）· 甩镜/快速横移（追击/惊变，用运动模糊掩盖接缝）· 黑场（静默/时间跳跃，配合声音设计）
- **动作接续**：跨镜动作必须连续——上镜末帧定格在动作 A 的结束，下镜首帧从同一姿势开始动作 B（不跳变）；'准备→接触→反馈→余波'四段动作可以跨镜分配，但每镜只承担其中一段，禁止一镜内重复完成整个动作
- **视线与轴线**：相邻镜之间视线方向必须匹配（A 看左，B 就在右侧）；对话场景遵守 180° 轴线——两镜不得越过轴线（越轴=观众迷失方向）；越轴必须用中间镜过渡（穿过轴线的移动镜头或特写）
- **剪辑点与节奏**：单镜时长 2-4 秒（竖屏节奏）；剪辑点优先选在'动作中间'而非'动作结束'（动作中剪比动作后剪更流畅）；连续 3 镜以上同景别必须换景别（全景→中景→特写循环）；情绪页允许长镜（4-6s 单一镜头）
- **音画衔接**：声音先入（下一镜的声音提前 0.3-0.5s 进入上一镜结尾）或画面先入（动作先动声音后到）；BGM 跨镜延续不断（剪辑点不停音乐）；静默设计（全静）只在特定镜生效，前后镜必须有声音进入/退出路径
- **批量生成衔接纪律**：分批次生成时，每批首镜的入点帧必须引用上一批末镜的出点帧描述（文字接力：把上一镜末帧的完整描述贴进下一镜提示词的'起始状态'）；批次间隙补'衔接校验'：两批相邻镜的末帧/首帧截图对比，不符则重生成其中一镜
- **镜头衔接与翻页的关系**：漫剧翻页钩子镜的'页末格'与下一页'页首格'之间，用动作匹配剪或硬切+声音先入衔接——翻页的停顿感来自剪辑点的呼吸，不是画面断裂
- **成片前衔接检查清单**：逐对相邻镜核对——① 末帧/首帧状态一致？② 视线方向匹配？③ 未越轴？④ 剪辑点是否在动作中？⑤ 声音是否连续或设计性中断？⑥ 道具/服装/光源跨镜无跳变？任一不过即返工该镜或补过渡镜

### 电影级渲染规格书技法（CG/影视级可复现镜头标准，每镜生成前必填，与镜头衔接技法配套）

- **规格书与衔接的分工**：镜头衔接技法管'镜与镜怎么接'，渲染规格书管'每一镜怎么生成得可复现'——先按本技法写规格，再按衔接技法设计转场；两技法配套使用，缺一不可
- **管线四问（每镜先问再写）**：谁渲染？怎么拍？光怎么给？材质是什么？四问齐了才是一个可复现的镜头；四问缺一 = 回到抽卡
- **管线分工（不混用，按镜头职责选）**：速度/跟拍/大场景镜 → UE 5.3 Lumen 实时渲染（全局光照弹射 2 次、天光参与间接光、Nanite 虚拟几何体高模直读无 LOD 跳变、Niagara 粒子系统）；人脸/皮肤/质感特写镜 → Redshift RT 离线渲染（微表面散射、SSS 次表面）；爆点/光谱光效镜 → Octane X 离线渲染（光谱光照）；复杂光照逻辑/物理相机严谨性验证 → V-Ray 6 全局光照 + 物理相机
- **物理相机参数化（每镜必填五项，参数写死才可复现）**：焦距（定焦叙事：35mm 中性/85mm 特写/24mm 大场面/100mm 细节）、光圈 T 值、快门（180° 开角 = 帧率倒数×2，电影运动模糊标准）、ISO、白平衡+曝光补偿；运动模糊：跟拍镜开 2 级标准模糊+轨道模糊，庄严镜振幅 0
- **一镜一事（最高降险纪律）**：每镜只承担一个事件（驶入/称量/亮灯/横移/心跳）；单事件 = 单锚点 = 低失败率；4 秒塞 6 个动作节点 = 各节点概率连乘 = 指数级抽卡失败；事件必须拆镜，绝不合并
- **首尾帧锚定**：首帧/尾帧用文字写死（姿势/位置/光位/构图），中间过渡交给模型/渲染器；尾帧可复制进下一镜提示词开头（文字接力）；锚点不一致 = 该镜重写
- **主光保底（人脸镜生死线）**：人脸永远给足主光——侧顶光 45° 暖金主光清晰照亮左脸（五官可辨）+ 发丝边缘一线金边轮廓光；禁止强逆光人脸（模型对逆光人脸极不稳定，糊成剪影或五官崩坏）；微表情只保留最小集（蹙眉+睫毛轻颤），大表情/抽搐级动作禁止
- **固定机位优先**：运镜用固定机位 + 光位变化（光从左脸扫到下巴）替代微妙推近（3%/s 级推近超出模型可控粒度，结果常是静止或随机抖动）；必须跟拍时用 Spline 路径 + ease-in-out 速度曲线 + 相机与主体速度同步（追逐感的来源）
- **材质物理层（真实质感的来源，离线镜必填）**：皮肤 SSS 半径 2.5cm/次表面 0.6；布料微表面粗糙度 0.8（亚麻）；金属 IOR 1.5；水面 IOR 1.33 折射粗糙度 0.02；桃花瓣等半透物用次表面散射（透光呈粉金色）；材质即真实感，贴图堆叠不替代物理层
- **粒子宁少勿多**：光尘/花瓣等氛围粒子给密度/风速/受光参数（如密度 200 颗/立方、风速 0.3m/s、受体积光影响），最容易被生成成噪点/飞蚊满屏；密度超过镜头主体 = 删
- **光照 = 叙事**：主光方向/色温/强度写死（无衰减）；GI 弹射产生的环境染色就是'称量感'的来源（金光弹到暗面产生微弱金染）；光斑用矩形光精确控制（0.5m 宽一线金边），不靠随机光晕
- **规格书模板（每镜按此结构输出）**：管线选择（谁渲染+理由）→ 物理相机五项 → 跟拍/运动设计 → 光照方案（主光/补光/轮廓光/GI/粒子）→ 材质指定 → 首帧/尾帧锚定 → 音画衔接（配合声音设计技法）
### 可执行参数层（真实软件字段对照表，规格书必须落到这一层才算可复现）

- **为什么要有这一层**：'文学化术语'（如'全局光照弹射 2 次''微表面散射'）在真实软件里对不上号；规格书必须给出软件实际存在的字段名+单位+数值范围，执行者才能直接转录进软件。以下对照表为真实字段，禁止发明不存在的参数

- **UE 5.3 真实字段（CineCameraActor / Lumen / Nanite / Niagara）**：
- 相机（CineCameraComponent 属性）：`FocalLength`(mm)· `Aperture`(f-stop 数值，如 2.8)· `SensorWidth`(mm，默认 36)· `ShutterSpeed`(1/s 或 `ShutterTime` 秒)· `ISO`· `ManualFocusDistance`(cm)· `Filmback` 预设；180° 开角 = ShutterSpeed = 帧率×2 的倒数（24fps→1/48）
- Lumen：Project Settings → `Dynamic Global Illumination Method = Lumen`、`Reflection Method = Lumen`；Post Process Volume → `Global Illumination Method = Lumen`、`Lumen Final Gather Quality`(0-100 自动档)· `Reflection Method = Lumen`；Lumen 是实时 GI，无'弹射次数'字段——用 Final Gather Quality 与 Scene Detail 控制质量，写'弹射 2 次'时落为'Final Gather Quality ≥ 60'
- Nanite：Static Mesh 资产启用 `Enable Nanite Support`（Nanite Virtualized Geometry 自动 LOD，无 LOD 层级字段）；写'Nanite 高模直读'时落为'启用 Nanite 的 Static Mesh 资产'
- Niagara：`Niagara System` 资产 → Emitter → `Particle Spawn/Update`（`Spawn Rate`(粒/秒)· `Initial Velocity`(cm/s)· `Drag`· `Max Particles` 上限）；'密度 200 颗/立方'落为'Spawn Rate + Max Particles 按体积换算'

- **Redshift RT 真实字段（C4D 插件 / Standard Material / Redshift Camera）**：
- `Redshift Standard Material`：`Diffuse Color`· `Roughness`(0-1)· `Specular Level`· `Specular Roughness`· `Metalness`· `IOR`(1.0-2.0)；SSS 组：`SSS Amount`(0-1)· `SSS Radius`(cm，皮肤 2-3)· `SSS Scale`· `SSS IOR`· `SSS Phase`；'皮肤 SSS 半径 2.5cm'直接落为 `SSS Radius = 2.5`
- `Redshift Camera`（Physical 选项卡）：`Focal Length`(mm)· `Aperture`(f-stop)· `Shutter Speed`(1/s)· `ISO`· `White Balance`(色温 K)；景深由 Aperture 驱动

- **Octane X 真实字段（Standalone/C4D 插件）**：材质节点用 `Universal Material`（Diffuse/Specular/Metalness 统一）或 `Glossy/Metal/Diffuse` 专用节点：`Roughness`· `Metalness`· `IOR`· `Transmission`；相机节点：`F-Stop`· `Shutter`(1/s)· `ISO`· `White Balance`(K)；Octane 光谱渲染引擎直接以色温输入光源（'光谱光照'落为'光源色温 3200K + 光谱渲染'）

- **V-Ray 6 真实字段（V-Ray Physical Camera / GI）**：`f-number`(光圈)· `shutter speed`(1/s)· `ISO`· `white balance`(K 或自定义)；景深与运动模糊由物理相机驱动；GI：`Primary Engine`（Brute Force / Irradiance Map）· `Secondary Engine`（Light Cache）；天光 `V-Ray Sun`：`Turbidity`(混浊度)· `Ozone`· `Intensity Multiplier`

- **规格书输出 schema（每镜按此 JSON 结构输出，字段名=真实软件字段，可直接转录）**：
```
{
  "shot": "S1-03",
  "engine": {"name": "ue5.3-lumen" | "redshift" | "octane" | "vray6", "reason": "..."},
  "camera": {"focal_length_mm": 24, "aperture_fstop": 2.8, "shutter_1_over_s": 48, "iso": 800, "white_balance_k": 5200, "exposure_ev": -0.3, "sensor_width_mm": 36},
  "motion": {"type": "spline-follow" | "static" | "whip-pan", "speed_curve": "ease-in-out", "subject_speed_mps": 1.8},
  "lights": [{"role": "key" | "fill" | "rim" | "practical", "direction_deg": 45, "color_temp_k": 3200, "intensity": 8, "decay": "none", "shape": "parallel" | "rect" | "point"}],
  "gi": {"method": "lumen-fg" | "brute-force" | "irradiance-map", "quality": ">=60"},
  "materials": [{"object": "skin" | "cloth" | "metal" | "water" | "hair", "roughness": 0.35, "ior": 1.5, "sss_radius_cm": 2.5, "sss_amount": 0.6}],
  "particles": {"system": "niagara", "spawn_rate_per_s": 200, "max_particles": 5000, "initial_velocity_cmps": 30},
  "anchors": {"out_frame": "...", "in_frame": "..."},
  "handoff": {"transition": "match-cut", "cut_point": "mid-action", "audio": "sound-first 0.3s"}
}
```

- **参数校验（成片质检前必做，对照真实软件）**：① 字段名是否存在于对应软件（对照上表，不存在的字段名=返工）；② 单位是否正确（mm/f-stop/1-s/K/cm/s）；③ 数值是否在合理范围（Aperture 0.95-22、ISO 100-3200 常规、白平衡 2500-10000K）；④ 同一镜中 engine 与 camera/gi 字段是否匹配该渲染器（如选 Redshift 就不写 Lumen 字段）；⑤ 出点帧与下一镜入点帧状态一致——五项全过才算可复现镜头

