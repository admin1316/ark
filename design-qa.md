# Ark native restoration design QA

- Product boundary: native SwiftUI/AppKit `/Applications/Ark.app`; no visible Web UI.
- Legacy graph reference: `/Users/hui/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_p5mhmzlbctpm22_47c0/temp/RWTemp/2026-08/9e20f478899dc29eb19741386f9343c8/a509b4d13c56ad90a2dd1e02af76da82.jpg`
- Legacy workbench reference: `/Users/hui/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_p5mhmzlbctpm22_47c0/temp/RWTemp/2026-08/9e20f478899dc29eb19741386f9343c8/9a8e5477e54b5b1d63667cd0e1c430d1.jpg`
- Legacy composer/stats reference: `/var/folders/tj/zym7f5k919375cmql460k5yw0000gn/T/codex-clipboard-e6013e38-e6bd-4c29-99f7-9ce31a5f1ff0.jpg`
- Installed workbench capture: `/var/folders/tj/zym7f5k919375cmql460k5yw0000gn/T/com.openai.sky.CUAService/Ark Screenshot 2026-08-23 at 1.55.22 AM.jpeg`
- Installed graph/status capture: `/var/folders/tj/zym7f5k919375cmql460k5yw0000gn/T/com.openai.sky.CUAService/Ark Screenshot 2026-08-23 at 2.04.24 AM.jpeg`
- Installed trajectory capture: `/var/folders/tj/zym7f5k919375cmql460k5yw0000gn/T/com.openai.sky.CUAService/Ark Screenshot 2026-08-23 at 1.57.58 AM.jpeg`

## Passed installed surfaces

- New conversation accepts text and images without a Workspace lock; first submit owns session creation and an absent Workspace remains Ungrouped.
- New-conversation composer is responsive, exposes direct Add Workspace, and omits the product-owned `jiuzhang` preset.
- Workbench restores the legacy `Files × +` tab strip, path entry, left editor/preview, right searchable file tree, persistent Terminal/Git tabs, and native split resizing.
- 万相织鉴 restores a dark, continuously evolving orbital node field with glow, zoom, pan, selection, category/community modes, and real current knowledge data.
- Trajectory retains the colored overview, compact semantic rows, inspector, and older-history loading. Long system/skill context is summarized in Input/Output and remains complete in Raw JSON.
- Session status light is backed by real state: gray idle, pulsing green running, pulsing yellow decision/approval, red abnormal stop/failure.
- Candidate and installed native-only/API-only contract tests passed through installed binary SHA-256 `563ff5b7375d736ef5b4465733bf7493f08e58053322e29511d2cc5db69569f9`.

## Blocked final surface

The legacy full-width active composer and exact whole-session stats strip are implemented, compiled, contract-tested, signed, and present in candidate binary SHA-256 `16ab413d55a4294774ed1dcf2366d95bb54e4f0cb5a2e7fbad1a780f8bba4eb8`.

The stats line mirrors the original order and semantics:

`轮 / 步 | LLM · 工具调用 | 首 token 平均 · tok/s | 缓存命中 | 输入 · 输出`

It uses whole-session `sessionStats` and `tokenUsage`, `K/M` token formatting, minute-second durations, precise near-100% cache-hit formatting, single-line truncation, and a full hover value.

Promotion is blocked because the final candidate E2E/escalated install request was rejected after the Codex usage limit was reached. The system instructed not to retry before 2026-08-29 08:51 or without renewed available usage. The unverified candidate was not forced over the installed app.

final result: blocked
