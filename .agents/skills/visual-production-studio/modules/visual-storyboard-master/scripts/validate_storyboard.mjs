#!/usr/bin/env node
import fs from "node:fs";

const input = process.argv[2];
if (!input) {
  console.error("用法: node validate_storyboard.mjs <storyboard.json>");
  process.exit(2);
}

let data;
try {
  data = JSON.parse(fs.readFileSync(input, "utf8"));
} catch (error) {
  console.error(`FAIL 无法读取 JSON: ${error.message}`);
  process.exit(1);
}

const errors = [];
const allowedModes = new Set(["board-sketch", "animatic-frame", "keyframe-color"]);
const allowedAxis = new Set(["L", "R", "ON"]);
const allowedDirection = new Set(["LTR", "RTL", "STATIC", "DEPTH", "NA"]);
const allowedStatus = new Set(["planned", "generated", "approved", "redo", "blocked"]);

function requireValue(value, path) {
  if (value === undefined || value === null || value === "") errors.push(`${path} 缺失`);
}

requireValue(data.project?.title, "project.title");
requireValue(data.project?.format, "project.format");
requireValue(data.project?.aspectRatio, "project.aspectRatio");
requireValue(data.project?.fps, "project.fps");
requireValue(data.project?.targetDurationSec, "project.targetDurationSec");
requireValue(data.project?.visualMode, "project.visualMode");
if (data.project?.visualMode && !allowedModes.has(data.project.visualMode)) {
  errors.push("project.visualMode 非法");
}
if (!Array.isArray(data.shots) || data.shots.length === 0) errors.push("shots 必须是非空数组");

const sceneIds = new Set(Object.keys(data.continuity?.scenes ?? {}));
const characterIds = new Set(Object.keys(data.continuity?.characters ?? {}));
const shotIds = new Set();
let totalDuration = 0;

for (const [index, shot] of (data.shots ?? []).entries()) {
  const base = `shots[${index}]`;
  for (const key of ["id", "sceneId", "beat", "purpose", "durationSec", "framing", "blocking"]) {
    requireValue(shot[key], `${base}.${key}`);
  }
  if (shot.id) {
    if (shotIds.has(shot.id)) errors.push(`${base}.id 重复: ${shot.id}`);
    shotIds.add(shot.id);
  }
  if (shot.sceneId && !sceneIds.has(shot.sceneId)) errors.push(`${base}.sceneId 未在 continuity.scenes 定义`);
  if (!(Number(shot.durationSec) > 0)) errors.push(`${base}.durationSec 必须大于 0`);
  totalDuration += Number(shot.durationSec) || 0;

  const camera = shot.camera ?? {};
  for (const key of ["angle", "lensMm", "height", "movement", "axisSide", "screenDirection"]) {
    requireValue(camera[key], `${base}.camera.${key}`);
  }
  if (camera.axisSide && !allowedAxis.has(camera.axisSide)) errors.push(`${base}.camera.axisSide 非法`);
  if (camera.screenDirection && !allowedDirection.has(camera.screenDirection)) errors.push(`${base}.camera.screenDirection 非法`);
  if (camera.lensMm && !(Number(camera.lensMm) >= 8 && Number(camera.lensMm) <= 400)) {
    errors.push(`${base}.camera.lensMm 超出合理校验范围`);
  }

  const composition = shot.composition ?? {};
  for (const key of ["focus", "flow", "negativeSpace", "horizon", "vanishingPoints"]) {
    requireValue(composition[key], `${base}.composition.${key}`);
  }

  const continuity = shot.continuity ?? {};
  for (const key of ["characters", "wardrobeState", "propState", "positionState", "lightState", "damageState"]) {
    if (continuity[key] === undefined || continuity[key] === null) errors.push(`${base}.continuity.${key} 缺失`);
  }
  for (const id of continuity.characters ?? []) {
    if (!characterIds.has(id)) errors.push(`${base}.continuity.characters 未定义角色: ${id}`);
  }

  const frame = shot.frame ?? {};
  for (const key of ["mode", "status", "prompt", "negativePrompt", "imagePath"]) {
    if (frame[key] === undefined || frame[key] === null) errors.push(`${base}.frame.${key} 缺失`);
  }
  if (frame.mode && !allowedModes.has(frame.mode)) errors.push(`${base}.frame.mode 非法`);
  if (frame.status && !allowedStatus.has(frame.status)) errors.push(`${base}.frame.status 非法`);
  if (["generated", "approved"].includes(frame.status) && !frame.imagePath) {
    errors.push(`${base}.frame.imagePath 在 ${frame.status} 状态下不能为空`);
  }
  if (frame.status === "approved" && frame.imagePath && !fs.existsSync(frame.imagePath)) {
    errors.push(`${base}.frame.imagePath 文件不存在: ${frame.imagePath}`);
  }
}

const target = Number(data.project?.targetDurationSec) || 0;
if (target > 0 && Math.abs(totalDuration - target) > Math.max(1, target * 0.05)) {
  errors.push(`镜头总时长 ${totalDuration.toFixed(2)}s 与目标 ${target.toFixed(2)}s 偏差超过 5%`);
}

if (errors.length) {
  console.error(`FAIL ${errors.length} 个问题`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`PASS ${data.shots.length} 个镜头，总时长 ${totalDuration.toFixed(2)}s`);

