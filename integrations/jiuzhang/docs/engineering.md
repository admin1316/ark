# Engineering notes

English | [中文](engineering.zh.md)

Maintainer-facing notes for building, verifying, and packaging Ark. Product-facing information lives in the [README](../README.md).

## Baseline

The product layer builds on a pinned upstream baseline: the framework at commit `47f943859bef60e4160492346772ded9b24f765a` (version `0.1.0-rc.5`, MIT licensed). The integration uses that checkout's built CLI directly and does not fork its package graph; upgrades and rollbacks happen through git history. Third-party licenses are disclosed in the repository's [THIRD_PARTY_NOTICES.md](../../../THIRD_PARTY_NOTICES.md).

## Layouts

One launcher pair (`src/start.mjs` + `src/runtime.mjs`) serves both supported layouts and detects its location at load time:

- **Source checkout**: launcher under `integrations/jiuzhang/src/`, product files under `integrations/jiuzhang/profile`, Ark runner built at `packages/boot/native-api-runner/lib/bin.js`, child working directory = repository root.
- **Standalone runtime**: launcher and `runtime-closure.mjs` at the runtime root beside a `jiuzhang/` product-file directory and `node_modules/@deepseek-ai/dsh-native-api-runner/lib/bin.js`, child working directory = the runtime root. The macOS application records this root as `JiuzhangRuntimeRoot`.

## Install behavior

Before installing runtime configuration into the default home, `migrateLegacyProductData` copies a present `~/Library/Application Support/九章天幕行业大脑/Harness` tree into `~/Library/Application Support/Ark/Harness`. It preserves file permissions and timestamps, sessions, settings, managed credentials, attachments, and symbolic links; retains the source tree; marks a successful copy so later user edits are not compared against the rollback copy; and fails before copying when an existing destination entry differs. `JIUZHANG_DSH_HOME` overrides are isolated and do not trigger this migration.

`installRuntimeConfiguration` reconciles exactly three Ark-owned product files (`profile/package.json`, `profile/cordis.patch.yml`, `profile/pnpm-workspace.yaml`) into the product home. It rejects linked, shared, or group/world-writable ownership paths; content-addresses any drift into a verified owner-only rollback; and atomically replaces only the compared bytes. User settings remain outside this managed profile. Nothing else from the source directory can leak into the home (enforced by tests).

## Build and run (source layout)

```sh
pnpm install --frozen-lockfile
pnpm run build
node integrations/jiuzhang/src/start.mjs --port 0
```

The launcher sets the process permission fallback to `read-only` and disables telemetry; saved user settings still win. The profile composes `@deepseek-ai/dsh-base` with the API-only `@deepseek-ai/dsh-native-api-app`, disables the OpenTelemetry session plugin, and keeps the SQLite session-query provider closed (`path: ':memory:'`, `openAt: never`).

## Verify

```sh
pnpm run test:jiuzhang                       # profile, launcher, and native application contracts
pnpm run verify-translation-pairing          # bilingual doc pairs
pnpm run verify-agent-note-format            # agent note format
```

The registered Node runner requires the built Ark entry (`pnpm run build` first). `node integrations/jiuzhang/tests/run.mjs --node-only` runs the platform-eligible Node tests; `--inventory-only` rejects missing, duplicate or unregistered test files. The default runner also builds and executes native contracts on macOS. Product controls remain native; the Workbench browser alone renders external HTTP(S) pages in WebKit without an Ark credential, tool or local-file bridge.

The required [CI workflow](../../../.github/workflows/ci.yml) separates portable Ark regressions, Swift native contracts, and a macOS packaging/install smoke. The portable job builds host outputs before the runner; the macOS smoke builds and seals a current-source runtime, assembles one isolated candidate with temporary data, and invokes the installed-state test. Test failures, skipped jobs and cancellation fail the aggregate verdict. These jobs do not certify manual native interaction or authorize production installation.

## Knowledge connections and recovery

The `knowledge-wiki` settings namespace uses the existing revision/CAS service and contains eight fields:

| Route | Fields | Unconfigured behavior |
|---|---|---|
| Text analysis and research | `textProvider`, `textModel` | Explicitly selected registered LLM route; both fields are required when enabled. |
| Image captions | `visionProvider`, `visionModel` | Both empty preserves local media and returns a warning. |
| Vector retrieval | `embeddingProvider`, `embeddingBaseUrl`, `embeddingModel`, `embeddingCredential` | All empty uses local keyword retrieval; enabling requires the complete route and an independent credential reference. |

Native Settings → Models edits these selections; credential values go to Keychain, not route settings. Text and image calls reuse the registered provider, including endpoint and protocol. Each multi-stage operation prepares its model calls before the first request; the provider retains credential-value rotation. Project operations carry the opaque `projectContext` from the registry, so changing UI selection cannot redirect an admitted operation. Host restart expires project identities. The [knowledge engine](../../../packages/host/knowledge-wiki/README.md) owns format limits, keyword fallback, project revocation and zero-source research behavior.

The composer writes bounded owner-only draft and attachment journals with file sync, atomic publication and directory sync before ordinary-prompt transmission. Host acknowledgement waits for the inbox event to reach persistence; invocation identity and content digest deduplicate uncertain retries, including cold sessions. Acknowledgement clears only the matching draft revision and payload. New-conversation migration preserves a recovery record across session creation. Slash commands retain their separate execution contract and do not acquire general side-effect idempotency from prompt receipts.

## Offline model evaluation

The [evaluation cases](../evals/cases.mjs) contain 24 synthetic tasks across coding, Chinese writing, document analysis and fixture-tool execution. The [reporter](../evals/report.mjs) prepares four comparison slots over two rounds; it neither runs a model nor accesses the network or credentials.

```sh
node integrations/jiuzhang/evals/report.mjs template
node integrations/jiuzhang/evals/report.mjs summarize /absolute/path/to/metadata.json
```

The template starts with every run unexecuted. Completed records require source/configuration hashes, rubric booleans and numeric observations. Reports distinguish failure, provider error, skip and not-run; missing usage or cost remains unknown. Free-text responses, errors, keys and unknown fields are rejected without echoing their values. Synthetic observations are labeled separately from measured calls. The [Claude research record](../evals/claude-research.json) links official documentation and marks unread reports explicitly; it does not establish account access, adapter compatibility or model quality. Paid comparisons require a separate approved budget.

## macOS application

```sh
# Source/standalone layout (development):
zsh integrations/jiuzhang/native/build-app.sh /path/to/output

# Self-contained distribution: embed the selected Node binary and the standalone
# runtime inside the bundle, recording bundle-relative paths in Info.plist.
JIUZHANG_SELF_CONTAINED=1 JIUZHANG_RUNTIME_ROOT=/path/to/runtime \
  JIUZHANG_PACK_RECEIPT=/path/to/pack-receipt.json \
  zsh integrations/jiuzhang/native/build-app.sh /path/to/output
```

Emits `Ark.app` at the output path: a native AppKit + SwiftUI executable, ICNS generation (Pillow required), and Info.plist recording of the Node.js executable, launcher, runner, and runtime root. Self-contained builds require the receipt emitted by [pack-runtime](../src/pack-runtime.mjs). The build signs embedded Node separately with `Resources/node.entitlements`, then executes that signed Node before accepting the bundle. Signing is ad-hoc by default, or uses a Developer ID from `JIUZHANG_SIGN_IDENTITY`; `JIUZHANG_NOTARY_PROFILE` additionally submits to notarytool and staples the ticket. The self-contained bundle resolves its recorded `Contents/...` paths against `Bundle.main.bundleURL`, so moving the app does not break it. [Info.plist](../native/Resources/Info.plist) owns the independent marketing version and build number; native contracts pin both. Source/standalone layouts still depend on the recorded external paths and require rebuilding when one moves.

## Brand

The native view uses the approved black Ark application icon from `Resources/AppIcon.png` and the native `ARK` wordmark; the application/window name is `Ark`. Preserve this branding and do not reintroduce the retired red 九章天幕 icon. Browser build identity and PWA metadata are not Ark product inputs.

## Local API gate

Each Ark.app launch generates a fresh token and passes it to the child as `DSH_API_TOKEN`. The native `URLSession` client sends it as an `Authorization: Bearer` header on every RPC. `@deepseek-ai/dsh-native-api-app` fixes the listener to loopback with `apiOnly: true`, mounts no frontend or browser roster, and composes strict `/api` RPC, `/api/respond`, `/api/session/export`, `/api/events/mux`, and `/api/events/host` through `dsh-host-connection`. Readiness is the post-settlement `dsh native-api:` line. The standalone closure checker rejects Web/headless and retired legacy-API package identities in direct links and the pnpm store, plus every `node_modules.*` sibling tree. The token is launch-scoped authentication, not macOS process-identity authentication.

## Lifecycle recovery

Ark embeds no WebKit-linked update framework. Updates are distributed outside the application until a fully native updater is implemented. Each backend launch waits at most 30 seconds for readiness by default; signed `ArkBackendReadinessTimeoutSeconds` metadata accepts a positive finite deployment override. Readiness, exit, failure and quit invalidate the timer. A timeout stops and reaps only the owned launch before the existing three-retry backoff runs; old readiness and timer callbacks cannot affect its replacement. The stability window, not the first readiness line, resets rapid-crash history. Native shutdown cancels and awaits knowledge loading and polling; cancelled or stale project results cannot install a replacement view.

## Credentials storage

The credentials provider ships a `keychain` mode (macOS only): secrets live in the login Keychain under a dedicated service via the `security` CLI, with the inherited-environment and `.env` precedence layers unchanged. The jiuzhang profile defaults the credentials row to `mode: keychain` on macOS so Keychain ACLs bind to a stable bundle signature; non-macOS dev/CI compositions keep the file mode. A keychain-mode suite covers store/resolve/describe/unset against a mocked `security` CLI.

## Installed-state acceptance

`integrations/jiuzhang/tests/install-e2e.mjs` boots the product as an install would (embedded node + launcher, isolated home) and verifies API-only readiness, unauthenticated 401 behavior, token-admitted RPC, and the seeded local-model provider. Point the test at a standalone runtime (`JIUZHANG_RUNTIME_ROOT`) or an assembled `Ark.app` (`ARK_APP_PATH`). Native controls, interaction and same-state screenshots require separate candidate acceptance; this API smoke alone does not prove them.

Candidate shutdown verification: a candidate bundle's launcher and backend are owned descendants of the candidate UI process. Record the actual port from its `dsh native-api:` readiness line, quit the candidate UI, and verify that the UI, launcher, backend, and that exact listener all disappear before accepting the run. The launcher gives its child six seconds, while the native process owner allows eight seconds for launcher shutdown within AppKit's twenty-second total termination deadline. Cleanup retains exact process identity checks. Production promotion requires passed candidate acceptance and explicit user confirmation; release assets belong in `admin1316/ark-releases`.
