# 可视化分镜大师

一个可直接安装到 Codex 的中文技能。它承接剧本、Director Master 镜头表、角色资产和场景资产，逐镜生成可见分镜画格，并输出可验证的 `storyboard.json` 与可打印 `storyboard.html`。

## 安装

把整个 `visual-storyboard-master` 文件夹复制到：

```text
~/.agents/skills/visual-storyboard-master/
```

重新开始一个 Codex 任务后，即可使用自然语言或显式技能名调用：

```text
使用 $visual-storyboard-master，把这份九列分镜绘制成 9:16 灰阶分镜板。
```

## 最小测试

```bash
node scripts/validate_storyboard.mjs examples/minimal-storyboard.json
node scripts/render_storyboard.mjs examples/minimal-storyboard.json examples/minimal-storyboard.html
```

## 典型上游与下游

```text
Director Master / Novel Characters
                 ↓
       Visual Storyboard Master
                 ↓
          CAVOK Director OS
```

## 包含内容

- 中文技能入口与自动触发描述。
- 26 个已分析能力模块和 1 个明确缺失的待补模块。
- 逐镜画格、空间轴线、连续性和视觉质检流程。
- 零依赖 JSON 验证器。
- 零依赖 HTML 分镜板生成器。
- 《人间香火录》两镜头最小示例。

