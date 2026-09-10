# 模块: execution-spec（cavok-director-os 子模块，按需加载）

### 严格短镜头执行稿（2-5 秒视频模型）逐镜 10 必填字段

> **行业标准词**：执行稿的焦段/机位/光色描述统一用 [ShotDeck 级行业词库](../../_shared/shotdeck-standard-language.md)（景别 ECU~XWS、机位 Eye Level~POV、镜头 Wide~Tele/Anamorphic、灯光 High Key~Rembrandt~Volumetric、色彩 Monochrome~Complementary），禁止自造词；与 ShotDeck 参考图对照时五维词组合（如 Low Angle + Wide + Low Key）
1 精确起止时码(三位毫秒)+帧数 · 2 焦段/机位高度/轴线侧/承载与移动 · 3 前中后景+主体占比 · 4 人物位置/朝向/距离/接地点/路径 · 5 道具数量/位置/方向/状态 · 6 按时间窗的动作/重心/呼吸/视线/微表情生命周期 · 7 湿发/衣料/水花/烟雨地面的物理反馈与延迟 · 8 焦点/景深/主光方向/负补光/唯一暖色/黑位 · 9 同期声/对白/呼吸/Foley/VFX声/混响 · 10 结束姿势(下一段首帧继承)

### 渲染规格与衔接扩展（执行稿 10 字段之上的进阶规格，AI 视频或 CG 管线通用，必填）

- **渲染管线选择（衔接电影级渲染规格书）**：速度/跟拍/大场景镜 → UE 5.3 Lumen 实时（GI 弹射 2 次/Nanite 无 LOD/Niagara 粒子）；人脸/皮肤/质感特写镜 → Redshift RT 离线（SSS/微表面）；爆点/光谱光效镜 → Octane X；复杂光照验证 → V-Ray 6 物理相机；执行稿头部写明管线+理由，四问（谁渲染/怎么拍/光怎么给/材质是什么）缺一即抽卡
- **物理相机五项（执行稿每镜必给，参数写死可复现）**：焦距（35mm 中性/85mm 特写/24mm 大场面/100mm 细节）· T 光圈 · 快门（180° 开角 = 帧率倒数×2）· ISO · 白平衡+曝光补偿；运动模糊：跟拍镜 2 级标准+轨道模糊，庄严镜振幅 0
- **可执行参数层（执行稿必须落到真实软件字段）**：UE5 相机用 CineCameraComponent 真实属性（FocalLength mm/Aperture f-stop/ShutterSpeed 1-s/ISO/ManualFocusDistance cm）；Redshift 用 Standard Material（Roughness/IOR/SSS Amount/SSS Radius cm）+ Redshift Camera（Focal Length/Aperture/Shutter Speed/ISO/White Balance K）；Octane 用 Universal Material + F-Stop/Shutter/ISO/White Balance；V-Ray 用 Physical Camera（f-number/shutter speed/ISO/white balance）+ GI Primary/Secondary Engine；禁止发明不存在的字段名；输出按 short-drama-ai-suite 规格书 JSON schema（engine/camera/motion/lights/gi/materials/particles）
- **一镜一事**：每镜只承担一个事件（驶入/称量/亮灯/横移/心跳）；单事件=单锚点=低失败率；2-5 秒镜内动作节点上限 2 个，超了拆镜；禁止一镜内完成'认知+哭泣+台词+奔跑'全链
- **主光保底（人脸镜生死线）**：人脸给侧顶 45° 主光（五官可辨）+发丝金边轮廓光；禁止强逆光人脸；微表情最小集（蹙眉+睫毛轻颤），微表情生命周期字段（第 6 条）内不得塞抽搐级动作
- **转场字段（每镜必标，衔接镜头衔接技法）**：hard-cut / dissolve(0.3-0.5s) / match-cut（上镜结束姿势=下镜起始姿势）/ whip-pan / blackout + 一句理由；剪辑点标'动作中剪/动作后剪'
- **首尾帧锚定强化（第 10 条升级）**：结束姿势即 outFrame，用'可直接复制进下一镜提示词开头'的语言写；下一镜 inFrame 与之匹配；跨批次时本批首镜 inFrame 引用上批末镜 outFrame（文字接力）
- **音画衔接（第 9 条升级）**：标声音先入（下一镜声音提前 0.3-0.5s）/画面先入；BGM 跨镜不断；静默设计只标特定镜，前后镜给声音进入/退出路径
