# Agent Note: Native shell crash recovery and signed-bundle packaging

Status: implemented

English | [中文](2026-08-15-ark-native-shell-recovery-and-packaging.zh.md)

## Problem

Five defects made the native Ark application's crash recovery and distribution claims hollow. First, `BackendProcess` reused one Foundation `Process` across launches, but a `Process` cannot be re-run after termination — the restart path called by `AppDelegate` on an unexpected exit crashed instead of recovering. Second, the application kept stale service state after an exit, so even a successful restart did not rebuild the client connection. Third, `build-app.sh` signed the bundle before its final `Info.plist` edits (Sparkle key and feed), embedded no `Sparkle.framework` although the binary links it, submitted the bare `.app` to notarytool (which rejects directories), and the hardened runtime blocked loading the framework entirely. Fourth, the build and local-install helpers accepted production paths and could remove or replace `/Applications/Ark.app` before candidate acceptance or rollback preparation. Fifth, the Ark product profile defaulted credentials to a home-directory file although the provider ships a Keychain mode.

## Decision

**Each launch owns a fresh `Process` and `Pipe`.** `BackendProcess` lives in `JiuzhangShellCore` (testable from the contract suite), creates a new process and pipe per `start`, refuses a second start before the previous exit is reaped (`BackendProcessError.alreadyRunning`), and reports each exit through its own termination handler. `AppDelegate` removes the stale native model and restores the loading state on an unrequested exit, resets the restart budget when a readiness line arrives, and restarts with the existing growing backoff. The contract suite kills the child with SIGKILL twice and verifies the exits are reported, the restart spawns a fresh PID, a double start is refused, and `stop` reaps.

**The bundle is fully assembled, then signed once.** `build-app.sh` performs every `Info.plist` edit (embedded paths, `SUPublicEDKey`, `SUFeedURL`/disable checks) before signing, embeds `Sparkle.framework` (SwiftPM artifact, Homebrew fallback) with the `@executable_path/../Frameworks` rpath added via `install_name_tool`, and only then signs the framework, the embedded Node, and the app (`--deep`, hardened runtime, entitlements) — `--timestamp` for a Developer ID identity, `--timestamp=none` for ad-hoc. `codesign --verify --deep --strict` gates the output. Notarization submits a zip archive (notarytool rejects bare `.app` directories), then staples and validates. The entitlements gain `com.apple.security.cs.disable-library-validation`, which Sparkle's docs require for hardened-runtime apps and which makes the ad-hoc local build load the framework too.

**SwiftMath font lookup is adapted only from its exact pinned source.** The candidate build resolves SwiftMath through `Package.resolved`, requires exactly one `MTFont` resource anchor and two `MathFont` resource anchors before changing either file, and rejects drifted, duplicate, missing, partially adapted, or already-adapted anchors. The release-only adapter resolves `SwiftMath_SwiftMath.bundle` under `Bundle.main.resourceURL`; ordinary development and contract-test executables fall back to `Bundle.module`. The build restores the pinned checkout sources on exit, copies the generated bundle into `Contents/Resources`, and signs it as part of the final application bundle.

**Build and local-install helpers produce candidates only.** `build-app.sh` validates and canonicalizes its output before dependency work, rejects the production application hierarchy, link-shaped targets, nested `Ark.app` paths, and any existing candidate, and never removes an earlier bundle. A self-contained build also compares the Native client's required RPC routes with the package reached through the runtime's direct `@deepseek-ai/dsh-host-apiproxy` symlink; a missing package artifact or Host route fails before signing. `install-local.sh` creates a uniquely named candidate under private temporary storage or the explicit Desktop candidate directory, while `update-local.sh` delegates to that same owner. `--system` fails with the governed-promotion requirement. Production replacement remains a separate, explicitly authorized operation with candidate acceptance and a unique rollback.

**Ark credentials default to the Keychain on macOS.** The jiuzhang profile patch sets the credentials row's `mode` through a `!!js` platform expression: `keychain` on darwin, `file` elsewhere (Linux dev/CI compositions stay on the file backend). The profile test parses the loader's `!!js` dialect and asserts the platform-selected value.

## Alternatives considered

**Reset the `Process` object's properties and call `run` again.** Rejected: Foundation throws on a second `run` of a terminated process; the wrapper must mint fresh objects per launch.

**Keep the stale service URL when the replacement process requests the same port.** Rejected: an exited listener no longer owns that endpoint, and only a new validated readiness event establishes the replacement service before clients reconnect.

**Sign after the Sparkle plist edits.** Rejected: modifying `Info.plist` invalidates the existing signature; the only valid order is all edits, then one signing pass, then verification.

**Submit the `.app` to notarytool.** Rejected: notarytool requires a zip, dmg, or pkg; the audit reproduced the rejection against the live tool.

**Treat an already-adapted SwiftMath checkout as an idempotent success.** Rejected: once the original anchors are absent, the build cannot distinguish its own earlier rewrite from upstream source drift or a partial external edit. Exact input counts plus exit-time source restoration keep repeated offline builds possible without weakening the drift check.

**Keep a convenience `--system` installer behind a confirmation flag.** Rejected: a shell confirmation cannot prove candidate behavior, source/runtime compatibility, rollback identity, or authorization to replace the active product. Candidate construction and production promotion remain separate operations.

## Consequences

A killed backend restarts and the native client reconnects without user action; the failure dialog only appears after the retry budget is exhausted. The self-contained bundle passes `codesign --verify --deep --strict` with Sparkle and SwiftMath fonts embedded, and a signed build with a Developer ID can be notarized and stapled. SwiftMath source drift stops packaging before compilation, while exit-time restoration leaves an explicitly supplied resolved scratch tree reusable. Reusing an output directory fails instead of replacing its `Ark.app`, and the convenience install/update entry points stop at a verified candidate; maintainers must use a new destination and the governed promotion flow. Keychain mode prompts on first credential access (the ACL binds to the bundle identity) and keeps secrets out of the home directory; machines without a signing identity still produce verifiable ad-hoc builds.
