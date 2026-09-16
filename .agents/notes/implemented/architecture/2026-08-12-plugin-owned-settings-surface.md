# Agent Note: Plugin-owned settings exposure

Status: implemented

English | [中文](2026-08-12-plugin-owned-settings-surface.zh.md)

## Problem

A second namespace allowlist between a Settings registration and its Remote consumer makes third-party configuration depend on edits outside the plugin owner. A separate list can drift from the live registry, while a page-specific declaration on the Settings service would let one consumer dictate the shared capability contract.

## Decision

**Registering makes a namespace describable.** [`SettingsStore.remoteDescribe()`](../../../../packages/settings/settings/src/index.ts) returns every live registered namespace through `describe({ redactSecrets: true })`; it does not consult a second product namespace list. Unknown namespaces and rejected changes retain the Settings owner's failure semantics. Registration does not bypass schema validation, provider writability, revision checks, activation, or field-level secret projection.

**Presentation stays in the consumer.** Settings registration carries no browser slot, page name, or form-card claim. Ark's [`ArkPluginSettingsAPI`](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellCore/ArkPluginSettingsAPI.swift) decodes the supported native plugin panels from the shared descriptor. A served namespace is not a promise that Ark supplies a visual editor for it. The native consumer owns supported controls, staging and revision fencing; the service owns values and mutations.

The [generic Web UI retirement](../simplification/2026-08-29-retire-generic-web-ui.md) removes the dynamic browser card/slot implementation. It does not reverse the single-registration exposure rule. A native settings panel is not a revived `dsh.client` plugin, and an external plugin cannot install a browser card into Ark.

## Trust boundary

A namespace allowlist did withhold entire resolved, base and user layers; a metadata-only plugin inventory was never an equivalent confidentiality boundary. The retained design places the actual boundary in the [`Host Connection`](../../../../packages/host/connection/src/index.ts) privileged Settings routes and the Settings redactor. Native configuration traffic must satisfy the carrier's loopback and request-authority checks. The ability to edit the user-owned document does not authorize disclosing secret values on the wire.

Every returned layer and schema default passes the conservative [`secret projection`](../../../../packages/settings/settings/src/redact.ts). The [Native Settings ownership decision](../bug-fix/2026-09-09-native-settings-ownership-and-redaction.md) owns union/intersection traversal, default redaction, malformed secret-container refusal and unsupported secret-schema rejection. Unmarked fields are not automatically secrets; plugin authors still own correct schema roles.

## Alternatives considered

**A page declaration on `settings.register()`.** It would mix presentation names, titles and placement into a service used by several consumers; the same namespace should not require a browser-shaped service contract.

**A separate exposure catalog.** A plugin could register a namespace but forget the second catalog. One fact would require two registrations, with no reliable signal distinguishing accidental omission from deliberate hiding.

**An unused namespace deny-list.** No current consumer needs one; field-level secret roles are the supported confidentiality mechanism. A future deployment-wide disclosure policy needs its own explicit consumer and threat model.

**Automatically generate a generic form for every namespace.** A descriptor is not a complete interaction contract. Ark uses explicitly supported native controls; schema metadata alone does not promise safe staging, secret replacement or comprehensible recovery.

**A second registry of UI claims or an unordered card list.** Both duplicate the consumer's actual supported controls and can drift into empty or duplicate presentation. They are not needed by the native Settings consumer.

## Consequences

New Host namespaces participate in the shared Settings API without transport-specific source edits. Their native editing experience remains a separate consumer decision. The API preserves redaction and mutation ownership even when no visual panel exists. A future dynamic native extension UI would need its own composition and interaction acceptance; the retired browser-card tests cannot establish it.

## Verification

The Settings package's redaction and Native Remote suites cover served namespaces, revisions and protected values; [`ArkSettingsContractChecks`](../../../../integrations/jiuzhang/native/Tests/JiuzhangShellCoreTests/ArkSettingsContractChecks.swift) covers the native contract. Source and contract checks do not substitute for live App interaction or publication acceptance.
