# Ark

English | [中文](README.zh.md)

This directory carries the Ark product profile, launcher pair, native macOS application, runtime-closure policy, and contract tests.

## Product surface

- **Agent presets**: Ark defaults to the shipped `standard` preset and exposes preset selection and authoring through its native settings. The managed profile disables the preset service's generic built-in root, so the launcher's Native roots own the roster. Each session receives the tools and prompt owned by its selected preset; generic CLI presets remain available to their own deployments.
- **Honest boundaries**: Ark works only with what you explicitly provide in the current session. It does not claim to have collected, learned, trained on, or access data you have not provided, and says so when there is no evidence.
- **Local data**: settings, credentials, attachments, and JSONL session records live in `~/Library/Application Support/Ark/Harness` (override with `JIUZHANG_DSH_HOME`). A default launch copies a present `~/Library/Application Support/九章天幕行业大脑/Harness` home once, refuses conflicting destination files, and retains the source as a rollback copy.
- **Safe defaults**: the launcher falls back to a read-only permission mode and disables telemetry. You may deliberately raise permissions or switch the default preset in settings; saved choices are preserved on launch.

## Run

### macOS application

Open `Ark.app` (see the [engineering notes](docs/engineering.md) for packaging).

### From source

```sh
node integrations/jiuzhang/src/start.mjs --port 3080
```

The launcher reconciles the Ark-owned `jiuzhang` profile with rollback before starting the dedicated native API entry. User settings remain separate from the managed profile.

## Configure models

Open Ark Settings → Models and add a compatible provider credential. Ark bundles no API key and does not treat application startup as a verified model conversation.

Built-in providers retain their catalog endpoints, protocols and per-model capabilities. Native presentation groups brand variants without merging route identities or credentials. The model picker supports search and explicit selection; an empty model list restores the installed catalog. Logos are local, hash-verified resources with text fallback for missing artwork. OAuth and multi-field account setup still require complete native authorization wiring; catalog presence is not proof that those flows or a real account have passed acceptance.

## Feedback

Ark is in internal testing. Report problems and suggestions to the product team directly.

## Maintainers

Build, verification, packaging, and layout details: [engineering notes](docs/engineering.md).
