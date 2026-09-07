# 模块: output-contract（visual-storyboard-master 子模块，按需加载）

## 输出契约速查卡（核心精确规范，直接引用）

### 目录结构
<project>/storyboard/ 下：storyboard.json · storyboard.html · frames/（SC01-SH001-board.png 等）· references/（characters/、scenes/）

### storyboard.json 顶层：project（title/format/aspectRatio/fps/targetDurationSec/visualMode）· continuity（characters/scenes/props）· shots[]

### 每个 shot 至少 12 字段
id（SC01-SH001 格式）· sceneId · beat · purpose · durationSec · framing · camera（angle/lensMm/height/movement/axisSide/screenDirection）· blocking · composition · continuity · frame（模式/状态/正负提示词/路径）· sound

### 枚举值（只允许）
axisSide: L · R · ON；screenDirection: LTR · RTL · STATIC · DEPTH · NA

### 画格状态机
planned → generated → approved；redo（重画）；blocked（缺参考/上游决定）

### 子画格与首尾帧
多动作节点用同镜号 -A/-B/-C 子画格；尾帧必须继承首帧的空间/角色/摄影机状态，除非镜头运动明确改变。
### 衔接字段（视频生成阶段的输入，每镜必填，保证逐镜生成可无缝拼接）

- shot 增加 handoff 字段（与 continuity 同级）：`outFrame`（本镜出点帧画面状态：角色姿势/道具位置/光源方向一句话描述）· `inFrame`（下一镜入点帧需匹配的状态，可与 outFrame 相同或为其续接）· `nextTransition`（与下一镜的转场：hard-cut / dissolve / match-cut / whip-pan / blackout）· `actionBridge`（跨镜动作接续说明：上镜动作结束姿势 → 下镜动作起始姿势）· `axisCheck`（本镜轴线侧 L/R/ON 与视线方向，确保相邻镜不越轴）
- **衔接字段写作纪律**：outFrame 用'可直接复制进下一镜提示词的起始状态'的语言（生成时把上一镜 outFrame 原文贴入下一镜提示词开头）；match-cut 必须写明'上镜结束姿势 = 下镜起始姿势'的具体动作；剪辑点建议写进 purpose 或 beat（动作中剪/动作后剪）
- **批次生成**：跨批次时本批首镜的 inFrame 必须引用上批末镜的 outFrame（文字接力）；任何一镜改画后，同步更新其 outFrame 与前后镜的衔接字段
### 画格渲染规格落位（画格是渲染规格的下游消费者，每镜随画格输出）

- **渲染规格落位**：每个画格（shot）标注——管线（UE5.3 Lumen / Redshift RT / Octane X / V-Ray 6，来自 director-master 分镜表扩展字段）· 物理相机（焦距/T/快门 180° 开角/ISO/白平衡，参数写死）· 材质要点（皮肤 SSS/布料粗糙度/金属 IOR，引用 novel-characters 材质参数）· 主光方向（人脸镜必须侧顶 45° 主光可辨，禁强逆光）
- **影像质感落位（真人实拍画格必标，防 AI 味）**：画格描述加影像基底（Kodak Vision3 250D/500T/Fuji Eterna/ARRI Alexa 风格，来自 director-master 备注列）· 颗粒倾向（细/粗/暗部颗粒）· 光学特征（球面奶油焦外/变形宽银幕椭圆眩光/老镜头暗角紫边——写进画格'光影'段）· 曝光行为（高光溢出只给光源/暗部深灰层次/死黑 ≤10% 角落）；漫剧/动画画格不适用（走风格化，见漫剧画格风格化技法）；画格是图片生成入口，缺影像质感=出图即 AI 味
- **锚点落位（衔接符号锁）**：每格列出本格必须出现的符号锁编码（CH-XX/PR-XX/EN-XX/LG-XX）；画格生成前按编码核对特征，锚点缺失 = 该格返工；未登记符号不得凭空出现
- **一镜一事**：每格只承载一个事件/一个视觉焦点；多事件拆格（-A/-B 子画格）；氛围粒子宁少勿多
- **亮度锚定（防'画格出图太暗'，光影段必写）**：暗环境+亮主体——画格光影段先写主体亮度（'面部中间调清晰''主体受光充足'）再写环境（'环境深灰层次'）；禁止只写'暗部/阴影/夜景'环境词；死黑 ≤10% 只在角落/光源背面；'暗部'类词每格 ≤3 个；负面清单加'无整体过暗/无主体淹没在阴影中'；暗场景画格（雨夜/烛光）必须显式写'主体明亮可辨'
- **与上下游的衔接**：输入 = director-master 分镜表（九列+渲染规格+衔接字段）+ novel-characters 锚点与材质参数；输出 = 画格图片（含 handoff 衔接字段），供 cavok-director-os 执行稿与 professional-cinematic-image 关键帧消费；字段均有下游消费方，无孤岛字段

### 三种模式（批次只能选一）
board-sketch（灰阶线稿）· animatic-frame（时间线预演）· keyframe-color（只用于高潮/转折/场景母版）

