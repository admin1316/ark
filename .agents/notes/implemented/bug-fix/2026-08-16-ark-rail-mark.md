# Agent Note: Ark collapsed-rail mark

Status: implemented

English | [中文](2026-08-16-ark-rail-mark.zh.md)

## Problem

The collapsed sidebar rail still showed the DeepSeek whale (`FishLogo`) under the Ark product identity: the hero shell and the wordmark were brand-aware, but the rail's resting mark was hardcoded, so collapsing the sidebar left a DeepSeek glyph in the top-left corner of the product.

## Decision

`SidebarRoot` resolves the same `data-dsh-product-brand` document attribute the hero shell reads and renders the Ark seal bitmap (`/ark-seal.png`, the 128px red seal with 九章天幕 seal-script) in the rail instead of the whale when the Ark product is selected; the DeepSeek build keeps the whale byte-for-byte. The seal is an `<img>` riding the same `railFish` class as the fish (24px, hover-hidden with the panel icon), matching the hero shell's existing `/ark-seal.png` usage. The wordmark's hidden-Jiuzhang-branch mechanism (inline stylesheet in `apps/web/index.html`) is untouched because the rail swap is a component-level branch, not a stylesheet-selected overlay.

## Alternatives considered

**A linear SVG seal glyph (rounded square + 九) as a new ui-primitives component.** Tried and rejected in the same change: the product owner wants the actual application icon in the rail, so the linear approximation was removed again before shipping. A component-level `<img>` branch reuses the existing seal bitmap instead of inventing a second mark.

**Stylesheet-selected dual render like the wordmark.** Rejected: the wordmark mechanism hides every non-Jiuzhang child of one svg via `apps/web/index.html` inline CSS; replicating it for the rail would require the same two-branch tree in two more slots and a third stylesheet rule, while the component-level branch needs one attribute read.

## Consequences

Collapsing the sidebar in the Ark product shows the red seal; the DeepSeek Harness build renders the whale as before. The rail swap is covered in `sidebar-root.client.spec.tsx` (default product keeps the fish, ark product swaps the seal `<img>`).
