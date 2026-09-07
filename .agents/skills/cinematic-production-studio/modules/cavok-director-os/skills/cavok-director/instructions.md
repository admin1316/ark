---
name: cavok-director
description: CAVOK 电影导演组：设计可制作的电影场景、镜头表、分镜、场面调度、动作编排、灯光、声音、连续性和 AI 视频生成提示词。用户要把故事、剧本、角色设定或视觉概念转化为真人、动画、游戏 CG 或漫剧的导演级执行方案，尤其需要精确视点、空间连续性、可信表演、物理特效、负面约束或生成失败诊断时使用（Use when）。
---

# CAVOK Director

Direct the scene as a coherent photographed event, not a collection of attractive images.

## Workflow

1. Extract the dramatic objective, conflict, reveal, emotional turn, and scene exit.
2. Establish geography before designing coverage: entrances, eyelines, screen direction, height, distance, cover, light sources, and VFX paths.
3. Lock character identity, wardrobe, physical state, relationships, and continuity-critical props.
4. Build the beat map. Assign one dominant narrative purpose to every beat.
5. Choose viewpoint deliberately. State whose information the audience shares and when that ownership changes.
6. Design blocking before camera movement. Preserve contact, weight transfer, and cause-and-effect between actions.
7. Select shot size, lens behavior, angle, movement, focus, duration, and transition for the beat.
8. Design lighting, atmosphere, production sound, dialogue, and VFX as interacting systems.
9. Write the generation prompt in chronological, observable language.
10. Add only failure-specific negative constraints, then audit continuity and physical plausibility.

For detailed rules, read only the references relevant to the request:

- Story, shot design, POV, camera, staging, action, lighting, sound, prompting, and review: [director-framework.md](references/director-framework.md)
- Physically based supernatural effects and collisions: [cinematic-vfx.md](references/cinematic-vfx.md)
- Unreal Engine execution with Chaos, Niagara, Lumen, and Sequencer: [unreal-vfx-execution.md](references/unreal-vfx-execution.md)
- Character, prop, action, lighting, damage, and VFX continuity: [continuity-direction.md](references/continuity-direction.md)
- Adapting the same directing plan to different AI video models: [model-adapters.md](references/model-adapters.md)
- Diagnosing generated footage and choosing minimum-cost corrections: [generation-diagnostics.md](references/generation-diagnostics.md)
- Actor intention, subtext, micro-behavior, and relationship performance: [performance-direction.md](references/performance-direction.md)
- Fight grammar, tactical beats, safety, coverage, and ability choreography: [action-direction.md](references/action-direction.md)
- CAVOK's conditional fast-cut action signature and spatial safeguards: [cavok-action-signature.md](references/cavok-action-signature.md)
- Content-driven shot, lens, camera position, movement, and coverage decisions: [camera-shot-decision-system.md](references/camera-shot-decision-system.md)
- Editorial structure, pacing, transitions, and salvage strategy: [editing-direction.md](references/editing-direction.md)
- Production sound, Foley, dialogue, VFX sound, perspective, and mix: [sound-direction.md](references/sound-direction.md)
- Exposure, color, texture, temporal consistency, and image finishing: [color-finishing.md](references/color-finishing.md)
- Character, environment, prop, material, and reference asset governance: [art-assets.md](references/art-assets.md)
- Shot planning, dependencies, budgets, review gates, rights, and release safety: [production-legal.md](references/production-legal.md)
- Reusable deliverable formats and prompt skeletons: [templates.md](references/templates.md)
- JiMeng/Seedance-ready 2–5 second prompts with exact timecode, cut frames, spatial locks, performance lifecycle, sound bridges, and negative constraints: [strict-short-video-contract.md](../../references/strict-short-video-contract.md)

## Non-negotiable rules

- Preserve causal order: perception precedes reaction; preparation precedes release; contact precedes consequence.
- Do not change POV ownership accidentally.
- Do not separate characters before the scripted trigger if their initial physical relationship matters.
- Give every camera move a narrative purpose, readable acceleration/deceleration, and a stable arrival.
- Choose camera language from story, information, emotion, relationship, geography, and rhythm; never apply fast cutting or signature shots by default.
- Avoid perpetual floating, automatic orbiting, indiscriminate slow motion, and pose-first staging.
- Describe visible evidence instead of abstract praise such as “epic,” “premium,” or “cinematic.”
- Treat VFX as photographed physical events with a source, formation, propagation, contact, feedback, aftermath, and dissipation.
- Make light, air, foliage, debris, fabric, hair, surfaces, sound, and performers respond at the correct scale.
- Separate invariants from shot-specific instructions. Repeat identity anchors only where the model may drift.
- If timing is constrained, prioritize readable beats over excessive coverage.

## Output contract

Unless the user requests another format, deliver:

1. Directorial intent and assumptions.
2. Beat map with viewpoint ownership.
3. Shot table with timecode, framing, camera, blocking, image, sound, and continuity notes.
4. Character, environment, camera, lighting, and VFX locks.
5. One chronological ready-to-use generation prompt.
6. A targeted negative prompt.
7. A continuity and feasibility checklist.

When diagnosing generated footage, preserve what works. Identify the failing layer—story clarity, geography, POV, blocking, camera, material, lighting, simulation, compositing, timing, or continuity—and revise only that layer plus its dependencies.

For a user-requested ready-to-generate 2–5 second clip, the short summary format is not sufficient. Read and follow the strict short-video contract. Deliver at least the same operational detail as the user's accepted production prompt: exact total duration and frame rate, exact cut times, one photographed event per time window, reference-role locks, geography, actor micro-actions, physical VFX, sound perspective, end-frame continuity, and failure-specific prohibitions.

## Iteration

After each generation, record: project, scene, successful choices, failures, model-specific errors, new reusable rule, and next test. Promote a lesson into this skill only when it generalizes beyond one shot or one model.

