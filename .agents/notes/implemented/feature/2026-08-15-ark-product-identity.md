# Agent Note: Ark product identity

Status: implemented

English | [中文](2026-08-15-ark-product-identity.zh.md)

## Problem

The product surfaces still carried upstream attribution ("基于 DeepSeek Harness 的 Ark", a "DEEPSEEK HARNESS" wordmark line, the upstream welcome notice, and a product name with a 九章天幕行业大脑 parenthetical), and machine identifiers used the legacy product directory name. The product should present itself as Ark alone.

## Decision

**User-visible product surfaces are Ark-only.** The web title, install manifest, wordmark (九章天幕 + ARK), welcome notice, onboarding hint, persona, and preset description no longer reference the framework. The welcome notice and onboarding hint become brand-aware: client copy resolves the build-time `data-dsh-product-brand` attribute at runtime, so the default DeepSeek Harness build keeps its copy byte-identical (the welcome notice version was bumped so the new copy shows once).

**The product name extends to machine identifiers.** The default product data home moved from `~/Library/Application Support/九章天幕行业大脑/Harness` to `~/Library/Application Support/Ark/Harness` in the launcher, Swift shell contract, docs, and agent note; the macOS bundle executable is now `Ark`. A one-time `migrateLegacyProductData` copies a present legacy home into the renamed location (permissions, timestamps, sessions, settings, credentials, attachments, symlinks), refuses conflicting destination entries before copying, retains the source as a rollback copy, and marks completion so later edits are not compared. `JIUZHANG_DSH_HOME` overrides stay isolated. The bundle identifier and the legacy-app-name regression guard remain unchanged.

**Documentation is product-facing with engineering notes separated.** Root README, contributing guide, and integration READMEs present the product; build, verification, packaging, baseline, and layout details moved to `integrations/jiuzhang/docs/engineering.md`. The MIT license file and third-party notices are untouched (license obligations).

## Alternatives considered

**Renaming only the display name.** Rejected: the legacy home path would strand all installed state (sessions, settings, credentials) on the next launch.

**Moving the legacy home by rename instead of copy.** Rejected: a copy keeps the source as a rollback copy and never destroys data; a rename is irreversible.

## Consequences

Ark presents its own identity end to end while the framework baseline remains documented in the engineering notes for maintainers. Fresh installs and migrated installs both land in the Ark home; the running GUI picks up the new copy on reload (no-cache plugin bundles). The one-time migration is a no-op on machines where the legacy home is already gone.
