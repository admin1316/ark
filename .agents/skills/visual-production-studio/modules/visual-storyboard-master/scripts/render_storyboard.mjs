#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const [input, output = "storyboard.html"] = process.argv.slice(2);
if (!input) {
  console.error("用法: node render_storyboard.mjs <storyboard.json> [storyboard.html]");
  process.exit(2);
}

const data = JSON.parse(fs.readFileSync(input, "utf8"));
const escapeHtml = (value = "") => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

const baseDir = path.dirname(path.resolve(input));
const cards = data.shots.map((shot) => {
  const rawImage = shot.frame?.imagePath || "";
  const image = rawImage ? path.relative(path.dirname(path.resolve(output)), path.resolve(baseDir, rawImage)) : "";
  const media = image
    ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(shot.id)}">`
    : `<div class="placeholder">${escapeHtml(shot.frame?.status || "planned")}</div>`;
  return `<article class="shot">
    <header><strong>${escapeHtml(shot.id)}</strong><span>${escapeHtml(shot.durationSec)}s · ${escapeHtml(shot.framing)} · ${escapeHtml(shot.camera?.lensMm)}mm</span></header>
    <div class="frame">${media}</div>
    <dl>
      <dt>目的</dt><dd>${escapeHtml(shot.purpose)}</dd>
      <dt>画面</dt><dd>${escapeHtml(shot.blocking)}</dd>
      <dt>摄影机</dt><dd>${escapeHtml(shot.camera?.angle)}；${escapeHtml(shot.camera?.movement)}；轴侧 ${escapeHtml(shot.camera?.axisSide)}；方向 ${escapeHtml(shot.camera?.screenDirection)}</dd>
      <dt>声音</dt><dd>${escapeHtml([shot.sound?.dialogue, shot.sound?.sfx, shot.sound?.music].filter(Boolean).join(" / "))}</dd>
      <dt>连续性</dt><dd>${escapeHtml([shot.continuity?.positionState, shot.continuity?.propState, shot.continuity?.lightState, shot.continuity?.damageState].filter(Boolean).join("；"))}</dd>
    </dl>
  </article>`;
}).join("\n");

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(data.project.title)} 分镜板</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#eee;color:#111;font:14px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}.top{padding:20px 24px;background:#111;color:#fff}.top h1{margin:0 0 4px;font-size:24px}.top p{margin:0;color:#bbb}.board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;padding:18px}.shot{break-inside:avoid;background:#fff;border:1px solid #bbb}.shot header{display:flex;justify-content:space-between;padding:8px 10px;border-bottom:1px solid #ccc}.frame{aspect-ratio:${escapeHtml(data.project.aspectRatio.replace(":", "/"))};background:#ddd;display:grid;place-items:center;overflow:hidden}.frame img{width:100%;height:100%;object-fit:contain}.placeholder{color:#777;text-transform:uppercase}.shot dl{display:grid;grid-template-columns:52px 1fr;margin:0;padding:8px 10px;gap:4px 8px}.shot dt{font-weight:700}.shot dd{margin:0}@media(max-width:900px){.board{grid-template-columns:1fr}}@media print{body{background:#fff}.top{background:#fff;color:#000;border-bottom:2px solid #000}.top p{color:#333}.board{padding:10px;gap:10px}.shot{page-break-inside:avoid}}
</style></head><body><section class="top"><h1>${escapeHtml(data.project.title)}</h1><p>${escapeHtml(data.project.format)} · ${escapeHtml(data.project.aspectRatio)} · ${escapeHtml(data.project.visualMode)} · ${escapeHtml(data.project.targetDurationSec)}s</p></section><main class="board">${cards}</main></body></html>`;

fs.writeFileSync(output, html);
console.log(`已生成 ${output}`);

