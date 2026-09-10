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

The integration tests are wired into the CI consumers gate and require the built Ark entry (`pnpm run build` first). The native contract builds and executes the Swift contract binary, verifies the API-only bundle, and rejects WebKit in the application executable.

## macOS application

```sh
# Source/standalone layout (development):
zsh integrations/jiuzhang/native/build-app.sh /path/to/output

# Self-contained distribution: embed the selected Node binary and the standalone
# runtime inside the bundle, recording bundle-relative paths in Info.plist.
JIUZHANG_SELF_CONTAINED=1 JIUZHANG_RUNTIME_ROOT=/path/to/runtime \
  zsh integrations/jiuzhang/native/build-app.sh /path/to/output
```

Emits `Ark.app` at the output path: a native AppKit + SwiftUI executable, ICNS generation (Pillow required), and Info.plist recording of the Node.js executable, launcher, CLI, and runtime root. A self-contained build signs embedded Node separately with `Resources/node.entitlements`, then executes that signed Node before accepting the bundle. Signing is ad-hoc by default, or uses a Developer ID from `JIUZHANG_SIGN_IDENTITY`; `JIUZHANG_NOTARY_PROFILE` additionally submits to notarytool and staples the ticket. The self-contained bundle resolves its recorded `Contents/...` paths against `Bundle.main.bundleURL`, so moving the app does not break it. The application bundle's marketing version is `3.1.0` (Info.plist `CFBundleShortVersionString` and `CFBundleVersion`; the native contract tests assert both fields, so update them together). Source/standalone layouts still depend on the recorded external paths and require rebuilding when one moves.

## Brand

The native view owns the Ark identity directly: the application/window name is `Ark`, the navigation lockup is `九章天幕 + ARK`, and `Resources/AppIcon.png` supplies the application icon. Browser build identity and PWA metadata are not Ark product inputs.

## Local API gate

Each Ark.app launch generates a fresh token and passes it to the child as `DSH_API_TOKEN`. The native `URLSession` client sends it as an `Authorization: Bearer` header on every RPC. `@deepseek-ai/dsh-native-api-app` fixes the listener to loopback with `apiOnly: true`, mounts no frontend or browser roster, and composes strict `/api` RPC, `/api/respond`, `/api/session/export`, `/api/events/mux`, and `/api/events/host` through `dsh-host-connection`. Readiness is the post-settlement `dsh native-api:` line. The standalone closure checker rejects Web/headless and retired legacy-API package identities in direct links and the pnpm store, plus every `node_modules.*` sibling tree. The token is launch-scoped authentication, not macOS process-identity authentication.

## Lifecycle recovery

Ark embeds no WebKit-linked update framework. Updates are distributed outside the application until a fully native updater is implemented. Unexpected backend exits restart automatically with growing backoff (up to three attempts) before the failure dialog appears.

## Credentials storage

The credentials provider ships a `keychain` mode (macOS only): secrets live in the login Keychain under a dedicated service via the `security` CLI, with the inherited-environment and `.env` precedence layers unchanged. The jiuzhang profile defaults the credentials row to `mode: keychain` on macOS so Keychain ACLs bind to a stable bundle signature; non-macOS dev/CI compositions keep the file mode. A keychain-mode suite covers store/resolve/describe/unset against a mocked `security` CLI.

## Installed-state acceptance

`integrations/jiuzhang/tests/install-e2e.mjs` boots the product as an install would (embedded node + launcher, isolated home) and verifies API-only readiness, unauthenticated 401 behavior, token-admitted RPC, and the seeded local-model provider. Installed acceptance also checks that the Ark executable does not link WebKit and that its accessibility tree contains native controls rather than a Web area. Point the test at a standalone runtime (`JIUZHANG_RUNTIME_ROOT`) or an assembled `Ark.app` (`ARK_APP_PATH`).

Candidate shutdown verification: a candidate bundle's launcher and backend are owned descendants of the candidate UI process. Record the actual port from its `dsh native-api:` readiness line, quit the candidate UI, and verify that the UI, launcher, backend, and that exact listener all disappear before accepting the run. The launcher force-kills an uncooperative backend after four seconds; the UI waits seven seconds before force-killing the launcher, so the supervisor cannot be removed before its child deadline settles.
