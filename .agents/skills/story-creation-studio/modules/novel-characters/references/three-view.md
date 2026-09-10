# 模块: three-view（novel-characters 子模块，按需加载）

### Step 8 — 三视图（可选，只给 protagonist 和 major）

读 `{baseDir}/references/turnaround.md`，照它的调用契约做。要点：

- **没有 codex 就整步跳过**，只交提示词，后面照常走
- 跑在 codex 里就直接用 `$imagegen`；跑在别处就 shell 调 codex，先按那里的脚本探测版本最高的 binary（旧版会直接报错）
- **一个角色一次调用，绝不批量**
- 必须写明 copy 到 `./images/<slug>-turnaround.png`
- 单个角色失败就跳过，不阻断；最后汇总说明

`supporting` / `minor` 只给提示词不出图。用户明确要求全出就全出。

