# Agent Note: Jiuzhang product profile

Status: implemented

English | [中文](2026-08-14-jiuzhang-product-profile.zh.md)

## Problem

Jiuzhang needs to start from DeepSeek Harness without restoring the deleted Ark implementation or forking Harness into a second application tree. Sharing the normal Harness home would mix product state with unrelated sessions, while selecting a shipped coding preset would reintroduce model tools and responsibilities outside the empty-product baseline. A desktop wrapper must also make clear whether it contains a complete runtime or merely starts the checkout.

## Decision

**Jiuzhang is an integration layer over one fixed upstream baseline.** The imported runtime is DeepSeek Harness `0.1.0-rc.5` at upstream commit `47f943859bef60e4160492346772ded9b24f765a`. `integrations/jiuzhang` owns only the product profile, Agent Preset, installer, launcher, tests, and user-facing integration documentation; the Harness framework and package graph are not forked. A tested build-time product-brand selector supplies the Jiuzhang title and wordmark while leaving the default DeepSeek Harness build unchanged.

**The product owns a dedicated Harness home.** The default is `~/Library/Application Support/Ark/Harness`, with an absolute `JIUZHANG_DSH_HOME` override for isolated verification. A default launch copies a present `~/Library/Application Support/九章天幕行业大脑/Harness` tree into this home once, including sessions, settings, managed credentials, attachments, permissions, timestamps, and symbolic links. Migration rejects differing destination entries before copying, retains the source as a rollback copy, and writes a destination marker after success so later edits are not compared with that copy. Installation then creates only missing profile and preset files and preserves user edits on later launches. This exact data-home migration does not import any earlier Ark database, PDF, knowledge base, training corpus, or learning state. Normal Harness use may create new settings, managed credentials, attachments, and JSONL session records inside this dedicated home.

**One complete persona-only Agent Preset is the shipped default.** The profile composes the official base and Web bundles, selects `jiuzhang`, and the preset mounts only `@deepseek-ai/dsh-persona` with `complete: true` and runtime-context injection disabled. Host plugins can remain loaded for Harness operation, but the model receives no shell, filesystem, web, skill, subagent, workflow, or other tool through this preset. Persisted user settings may deliberately select another default Agent Preset; startup preserves that choice.

**The local defaults minimize ambient effects.** The launcher sets the process permission fallback to `read-only`; saved Harness settings may still select a later Web session's permission preset, while the complete Agent Preset continues to expose no model tools. Both the profile row and environment disable session telemetry. SQLite session search stays unopened through `path: ':memory:'` and `openAt: never`, so no search database is created by this profile.

**The desktop wrapper remains thin.** It can start the built CLI either from the source checkout or from a separately assembled standalone runtime. The chosen layout and compatible Node.js executable are recorded in the application bundle; moving either recorded dependency breaks startup until the wrapper is rebuilt. The wrapper does not embed another Harness tree or Node runtime.

**Model readiness remains independently verifiable.** No API key ships with Jiuzhang. A successful build, local HTTP response, or visible Web UI proves only the local runtime path; a real model conversation requires a configured supported provider and credential and must be verified separately.

## Alternatives considered

**Restore the earlier Ark code, databases, PDFs, or knowledge directories.** Rejected because the product starts from a clean redesign boundary and those assets would silently reintroduce deleted scope and unreviewed state.

**Copy or rewrite the Harness packages under a Jiuzhang application tree.** Rejected because a second implementation would increase source weight, duplicate upstream behavior, and make upstream fixes harder to consume.

**Reuse the normal `~/.dsh` home.** Rejected because Jiuzhang sessions, settings, credentials, and profile edits would become indistinguishable from other Harness usage.

**Rename the default home without a startup migration.** Rejected because changing the machine identifier while an installed product already owns sessions, settings, and credential references would either strand that state or invite an unsafe live move. Copy-before-use plus conflict rejection provides a rollback path and prevents silent replacement.

**Use a shipped coding preset and rely only on `read-only`.** Rejected because a filesystem permission mode does not remove model-visible tools or their non-filesystem effects. A complete persona-only preset provides the smaller capability set directly.

**Package the full repository and Node runtime inside the first desktop build.** Rejected because that would turn the initial local integration into a large independent distribution before its runtime and model paths are verified. The thin launcher keeps the dependency visible; self-contained packaging remains separate.

## Consequences

Jiuzhang can use the maintained Harness Web and session infrastructure while keeping its shipped default model capability to plain conversation and its state separate from general Harness use. The data-home rename costs one retained rollback copy until a user deliberately removes it; a conflict stops startup instead of choosing one version. The source checkout remains the development input; an installed standalone runtime can remove it from the application startup path without duplicating framework source. The product-specific code stays small and does not fork upstream packages. The integration neither supplies knowledge nor claims automatic learning; those capabilities require later evidence-governed product decisions. Keyless tests can prove composition, migration, installation, preservation, conflict rejection, telemetry settings, and absence of imported legacy assets, while provider-backed conversation and any desktop packaging claim require their own runtime evidence.
