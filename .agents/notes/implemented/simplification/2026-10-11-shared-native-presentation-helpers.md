# Agent Note: Shared native presentation helpers

Status: implemented

English | [中文](2026-10-11-shared-native-presentation-helpers.zh.md)

## Problem

Tool views and long-task summaries repeated card-title extraction and execution-phase localization. The Markdown converter repeated the enclosing parser's backslash-parity predicate. Workbench root selection repeated protected-path conversion, and completed and active process cards repeated the same derived counts and entry filtering. Separate copies require parallel edits without supplying different behavior.

## Decision

[`ArkToolPresentation.title` and `ArkExecutionPhase.localizedLabel(language:)`](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellUI/ArkToolModels.swift) own the existing pure operations within the UI module. Consumers keep their own selection policy: chat tries the result title then the call title, while the long-task summary selects the result card before falling back to the tool name. The language remains an explicit argument. The separate status-phase enum retains its neutral and stopped states.

The nested Markdown converter calls [`NativeGFMParser.isEscaped`](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellUI/NativeMarkdownGFMModel.swift). The scan direction, string-index handling, and odd-backslash rule remain unchanged.

The existing private types in [`ArkRootView`](../../../../integrations/jiuzhang/native/Sources/JiuzhangShellUI/ArkRootView.swift) own their construction. `WorkbenchRootSelection` validates raw paths before URL conversion; the general root prefers the selected workspace and tool-file navigation prefers the session directory. `NativeChatProcess` derives hidden identifiers, observable detail entries and counts from its selected entries. Completed and active projections retain their separate guards, entry selection, generation and anchor policies.

## Alternatives considered

**Keep the copies.** They repeat the same pure operation and make future card or localization changes depend on finding every view.

**Merge consumer fallback policies.** Chat and long-task summaries intentionally resolve missing titles differently. Sharing the accessor preserves both policies.

**Create a separate presentation service.** Existing enums and the parser already own the data. Another service or factory adds ownership without a new consumer contract.

## Consequences

The shared helpers add no state, dependency, wire field, event, or rendering route. Existing native contracts exercise card decoding, long-task summaries, localization, accessibility, Markdown code/math boundaries and the projection's shared construction. Builds and those contracts remain separate from packaged-candidate interaction and screenshot acceptance.
