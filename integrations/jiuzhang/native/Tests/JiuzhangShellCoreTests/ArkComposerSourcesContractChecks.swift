import AppKit
import Foundation
import JiuzhangShellCore
import SwiftUI
@testable import JiuzhangShellUI

func runArkComposerSourcesContractChecks() {
  runComposerAPIDecoderChecks()
  runComposerTriggerChecks()
  runComposerTriggerSurrogateChecks()
  runComposerSuggestionChecks()
  runComposerDraftChecks()
  runComposerSubmissionChecks()
  runComposerSourceShapeChecks()
  runComposerBridgeSafetyChecks()
  runComposerStyleCacheChecks()
}

private func runComposerStyleCacheChecks() {
  MainActor.assumeIsolated {
    var composing = false
    let coordinator = NativeComposerTextView.Coordinator(
      isComposing: Binding(
        get: { composing },
        set: { composing = $0 }
      ),
      focusRevision: 0,
      textChanged: { _, _, _ in },
      selectionChanged: { _, _ in }
    )
    let editor = NSTextView()
    editor.font = .systemFont(ofSize: 14)
    editor.string = "hello"
    editor.setSelectedRange(NSRange(location: 3, length: 0))
    coordinator.applyReferenceStylesIfNeeded(to: editor, text: "hello", references: [])
    editor.textStorage?.addAttribute(
      .foregroundColor,
      value: NSColor.systemPink,
      range: NSRange(location: 0, length: 1)
    )
    coordinator.applyReferenceStylesIfNeeded(to: editor, text: "hello", references: [])
    let cachedColor = editor.textStorage?.attribute(
      .foregroundColor,
      at: 0,
      effectiveRange: nil
    ) as? NSColor
    check(
      cachedColor?.isEqual(NSColor.systemPink) == true
        && editor.selectedRange() == NSRange(location: 3, length: 0),
      "native composer skips unchanged full-storage styling without moving the caret"
    )

    let reference = ArkComposerReferenceOccurrence(
      source: "file",
      canonicalReference: "file:///tmp/example",
      label: "he",
      appearance: .file,
      offset: 0,
      length: 2
    )
    coordinator.applyReferenceStylesIfNeeded(
      to: editor,
      text: "hello",
      references: [reference]
    )
    let refreshedColor = editor.textStorage?.attribute(
      .foregroundColor,
      at: 0,
      effectiveRange: nil
    ) as? NSColor
    check(
      refreshedColor?.isEqual(NSColor.controlAccentColor) == true
        && editor.selectedRange() == NSRange(location: 3, length: 0),
      "native composer reapplies reference styling only when its semantic inputs change"
    )
  }
}

private func runComposerBridgeSafetyChecks() {
  let bridgeURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeComposerTextView.swift"
  )
  guard let bridge = try? String(contentsOf: bridgeURL, encoding: .utf8) else {
    check(false, "native composer AppKit bridge source is readable")
    return
  }
  let initialText = bridge.range(of: "editor.string = text")
  let delegate = bridge.range(of: "editor.delegate = context.coordinator")
  check(
    initialText != nil
      && delegate != nil
      && initialText!.lowerBound < delegate!.lowerBound,
    "native composer installs initial TextKit content before attaching its publishing delegate"
  )
  check(
    bridge.contains("context.coordinator.performProgrammaticUpdate")
      && bridge.contains("guard !applyingProgrammaticUpdate")
      && bridge.contains("private var applyingProgrammaticUpdate = false"),
    "native composer suppresses delegate publishes during SwiftUI-driven TextKit synchronization"
  )
}

private func runComposerAPIDecoderChecks() {
  let commands = try? ArkComposerAPIContract.commands(from: .array([
    .object([
      "name": .string("goal"),
      "description": .string("Set the durable goal"),
      "input": .object(["hint": .string("Describe the goal"), "images": .bool(true)]),
    ]),
    .object([
      "name": .string("compact"),
      "description": .string("Compact context"),
    ]),
  ]))
  check(commands?.count == 2, "native composer decodes every Host command row")
  check(commands?.first?.input?.hint == "Describe the goal", "native composer preserves command input hints")
  check(commands?.first?.input?.acceptsImages == true, "native composer preserves command image capability")

  let skills = try? ArkComposerAPIContract.skills(from: .object([
    "skills": .array([
      .object([
        "name": .string("dsh-code-review"),
        "description": .string("Review the selected change"),
        "whenToUse": .string("Use for code review"),
        "modelInvocable": .bool(false),
      ]),
    ]),
  ]))
  check(skills?.first?.name == "dsh-code-review", "native composer decodes the session-root Skill catalog")
  check(skills?.first?.modelInvocable == false, "native composer retains user-only Skill identity")

  let files = try? ArkComposerAPIContract.files(from: .array([
    .object(["path": .string("Sources/Ark App.swift"), "kind": .string("file")]),
    .object(["path": .string("Sources/UI"), "kind": .string("directory")]),
  ]))
  check(files?.map(\.kind) == [.file, .directory], "native composer decodes file and directory reference kinds")

  let mention = "@[Research](dsh-session:InNlc3Npb24tMSI)"
  let sessions = try? ArkComposerAPIContract.sessions(from: .array([
    .object([
      "sessionId": .string("session-1"),
      "label": .string("Research"),
      "cwd": .string("/tmp/project"),
      "createdAt": .number(1_700_000_000_000),
      "mention": .string(mention),
    ]),
  ]))
  check(sessions?.first?.mention == mention, "native composer never reconstructs a session id from its display label")
  do {
    _ = try ArkComposerAPIContract.sessions(from: .array([
      .object([
        "sessionId": .string("session-1"),
        "label": .string("Research"),
        "createdAt": .number(1),
        "mention": .string("@Research"),
      ]),
    ]))
    check(false, "native composer rejects a noncanonical session mention")
  } catch {
    check(true, "native composer rejects a noncanonical session mention")
  }
}

private func runComposerTriggerChecks() {
  let slash = ArkComposerTriggerDetector.detect(text: "  /go", caret: 5, revision: 7)
  check(slash?.trigger == .slash, "native composer detects a leading slash trigger")
  check(slash?.query == "go", "native composer extracts the slash query")
  check(slash?.position == .leading, "native composer classifies a whitespace-prefixed slash as leading")
  check(slash?.draftRevision == 7, "native composer stamps trigger spans with the draft revision")

  check(
    ArkComposerTriggerDetector.detect(
      text: "https://example.com/path",
      caret: ("https://example.com/path" as NSString).length,
      revision: 1
    ) == nil,
    "native composer does not open slash completion inside URLs"
  )
  check(
    ArkComposerTriggerDetector.detect(text: "mail@example.com", caret: 16, revision: 1) == nil,
    "native composer does not open references inside email addresses"
  )

  let quotedText = "read @\"docs/a b"
  let quoted = ArkComposerTriggerDetector.detect(
    text: quotedText,
    caret: (quotedText as NSString).length,
    revision: 9
  )
  check(quoted?.trigger == .reference && quoted?.quoted == true, "native composer detects open quoted file references")
  check(quoted?.query == "docs/a b", "native composer preserves whitespace inside quoted reference queries")
}

private func runComposerTriggerSurrogateChecks() {
  // R19-02 回归：扫描路径经过代理对（emoji 等 BMP 外字符）时不得触发 UnicodeScalar 强解包崩溃
  let emoji = "a 🚀"
  check(
    ArkComposerTriggerDetector.detect(text: emoji, caret: (emoji as NSString).length, revision: 3) == nil,
    "native composer scan across surrogate pairs does not crash and yields no trigger"
  )
  let emojiSlash = "🚀 /go"
  let emojiHit = ArkComposerTriggerDetector.detect(text: emojiSlash, caret: (emojiSlash as NSString).length, revision: 4)
  check(emojiHit?.trigger == .slash && emojiHit?.query == "go", "native composer still detects slash after surrogate scan")
  check(
    ArkComposerTriggerDetector.detect(text: "  ", caret: 2, revision: 1) == nil,
    "native composer treats whitespace before caret as no trigger"
  )
  check(
    ArkComposerTriggerDetector.detect(text: "\n", caret: 1, revision: 1) == nil,
    "native composer treats newline before caret as no trigger"
  )
  let emojiBareSlash = "🚀 /"
  let bareHit = ArkComposerTriggerDetector.detect(text: emojiBareSlash, caret: (emojiBareSlash as NSString).length, revision: 5)
  check(bareHit?.trigger == .slash, "native composer detects bare slash after emoji")
}

private func runComposerSuggestionChecks() {
  let commands = [
    ArkComposerCommand(
      name: "goal",
      description: "Set goal",
      input: ArkComposerCommandInput(hint: "Goal text")
    ),
    ArkComposerCommand(
      name: "plan",
      description: "Enter plan mode",
      input: ArkComposerCommandInput(hint: "Optional planning request")
    ),
    ArkComposerCommand(name: "compact", description: "Compact context"),
  ]
  let skills = [
    ArkComposerSkill(name: "goal", description: "Collision", modelInvocable: true),
    ArkComposerSkill(name: "code-review", description: "Review code", modelInvocable: false),
    ArkComposerSkill(name: "CODE-REVIEW", description: "Duplicate source", modelInvocable: true),
  ]
  let leading = ArkComposerSuggestionBuilder.slash(
    commands: commands,
    skills: skills,
    query: "go",
    position: .leading
  )
  check(leading.map(\.id) == ["command:goal"], "Host commands win exact name collisions with Skills")
  let skill = ArkComposerSuggestionBuilder.slash(
    commands: commands,
    skills: skills,
    query: "cr",
    position: .leading
  ).first
  check(skill?.id == "skill:code-review", "native slash menu applies one shared fuzzy ranker")
  check(skill?.userOnly == true, "native slash menu marks user-only Skills without changing invocation text")
  check(
    ArkComposerSuggestionBuilder.deduplicatedSkills(skills).map(\.name)
      == ["goal", "code-review"],
    "native composer collapses duplicate Skill sources by canonical name"
  )
  let grouped = ArkComposerSuggestionBuilder.groupedSlash(
    commands: commands,
    skills: skills,
    skillsTitle: "技能",
    skillsDetail: "2 个可用技能"
  )
  check(
    grouped.filter { $0.kind == .skillCollection }.count == 1
      && grouped.filter { $0.kind == .skill }.isEmpty,
    "empty slash completion presents Skills as one organized collection"
  )
  let capabilityLauncher = ArkComposerSuggestionBuilder.capabilityLauncher(
    commands: commands,
    skills: skills,
    filesTitle: "文件和文件夹",
    filesDetail: "引用工作区文件",
    sessionsTitle: "引用 Ark 会话",
    sessionsDetail: "引用其他会话",
    skillsTitle: "技能与插件",
    skillsDetail: "1 个可用技能",
    commandTitles: ["goal": "目标", "plan": "计划模式", "compact": "压缩上下文"],
    commandDetails: ["goal": "持续长任务", "plan": "先规划再执行", "compact": "释放上下文"]
  )
  check(
    capabilityLauncher.prefix(5).map(\.id)
      == ["launcher:files", "launcher:sessions", "command:goal", "command:plan", "command:compact"],
    "plus launcher keeps add actions before authoritative long-task and planning commands"
  )
  check(
    capabilityLauncher.filter { $0.section == .add }.count == 2
      && capabilityLauncher.filter { $0.section == .tasks }.count == 3
      && capabilityLauncher.filter { $0.section == .plugins }.map(\.id) == ["skill-collection"],
    "plus launcher groups add, long-task, and one bounded Skill collection without a second catalog"
  )
  let largeLauncher = ArkComposerSuggestionBuilder.capabilityLauncher(
    commands: commands,
    skills: (0..<1_000).map {
      ArkComposerSkill(name: "plugin-\($0)", description: "Plugin \($0)", modelInvocable: true)
    },
    filesTitle: "Files",
    filesDetail: "Files",
    sessionsTitle: "Sessions",
    sessionsDetail: "Sessions",
    skillsTitle: "Skills",
    skillsDetail: "1000 skills",
    commandTitles: [:],
    commandDetails: [:]
  )
  check(
    largeLauncher.count == 6 && largeLauncher.last?.id == "skill-collection",
    "plus launcher keeps a thousand-Skill catalog bounded behind one collection row"
  )
  check(
    !ArkComposerSuggestionBuilder.capabilityLauncher(
      commands: [commands[2]],
      skills: [],
      filesTitle: "Files",
      filesDetail: "Files",
      sessionsTitle: "Sessions",
      sessionsDetail: "Sessions",
      skillsTitle: "Skills",
      skillsDetail: "0 skills",
      commandTitles: [:],
      commandDetails: [:]
    ).contains { $0.id == "command:goal" || $0.id == "command:plan" },
    "plus launcher never invents Goal or Plan for a preset that does not advertise them"
  )
  check(
    !ArkComposerSuggestionBuilder.capabilityLauncher(
      commands: commands,
      skills: [],
      filesTitle: "Files",
      filesDetail: "Files",
      sessionsTitle: "Sessions",
      sessionsDetail: "Sessions",
      skillsTitle: "Skills",
      skillsDetail: "0 skills",
      commandTitles: [:],
      commandDetails: [:],
      position: .inline
    ).contains { $0.id == "command:goal" || $0.id == "command:plan" },
    "plus launcher keeps argument-taking Goal and Plan commands leading-only"
  )
  let families = ArkComposerSuggestionBuilder.skillFamilies([
    ArkComposerSkill(name: "media-core", description: "Core", modelInvocable: true),
    ArkComposerSkill(name: "media-cli", description: "CLI", modelInvocable: true),
    ArkComposerSkill(name: "media-animation", description: "Animation", modelInvocable: true),
    ArkComposerSkill(name: "story-studio", description: "Story", modelInvocable: true),
  ], otherTitle: "其他技能")
  check(
    families.map(\.id) == ["media", "_other"]
      && families.first?.skills.count == 3,
    "native composer nests similar canonical prefixes into one Skill family"
  )
  let canonicalStudios = ArkComposerSuggestionBuilder.skillCollectionRows([
    ArkComposerSkill(name: "story-creation-studio", description: "Story", modelInvocable: true),
    ArkComposerSkill(name: "cinematic-production-studio", description: "Cinema", modelInvocable: true),
    ArkComposerSkill(name: "visual-production-studio", description: "Visual", modelInvocable: true),
    ArkComposerSkill(name: "translation-studio", description: "Translation", modelInvocable: true),
    ArkComposerSkill(name: "media-production-studio", description: "Media", modelInvocable: true),
  ], otherTitle: "其他技能") { "\($0) 个技能" }
  check(
    canonicalStudios.count == 5
      && canonicalStudios.allSatisfy { $0.kind == .skill },
    "five canonical studios open directly without a redundant Other Skills level"
  )
  let inline = ArkComposerSuggestionBuilder.slash(
    commands: commands,
    skills: [],
    query: "",
    position: .inline
  )
  check(!inline.contains(where: { $0.id == "command:goal" }), "argument-taking commands remain leading-only")

  let spacedFile = ArkComposerFileCandidate(path: "docs/a b.md", kind: .file)
  check(
    ArkComposerSuggestionBuilder.fileMention(spacedFile, preserveQuote: false) == "@\"docs/a b.md\"",
    "native composer quotes file mentions containing whitespace"
  )
  let directory = ArkComposerFileCandidate(path: "docs", kind: .directory)
  check(
    ArkComposerSuggestionBuilder.fileMention(directory, preserveQuote: false) == "@docs/",
    "native directory picks keep completion open at the next path segment"
  )

  var menu = ArkComposerSuggestionMenu.closed
  let hit = ArkComposerTriggerHit(
    trigger: .slash,
    query: "",
    quoted: false,
    position: .leading,
    range: NSRange(location: 0, length: 1),
    draftRevision: 1
  )
  menu.begin(generation: 2, hit: hit)
  check(
    menu.publish(generation: 1, candidates: leading) == false,
    "native composer drops stale asynchronous candidate generations"
  )
  check(
    menu.publish(generation: 2, candidates: leading) == true,
    "native composer accepts only the current candidate generation"
  )
  menu.move(-1)
  check(menu.highlightedIndex == 0, "native composer keyboard selection wraps deterministically")
}

private func runComposerDraftChecks() {
  let canonical = "@[Research](dsh-session:InNlc3Npb24tMSI)"
  var document = ArkComposerDraftDocument(text: "see @", revision: 4)
  check(document.insertReference(
    in: NSRange(location: 4, length: 1),
    displayText: "@Research",
    canonicalReference: canonical,
    source: "reference",
    label: "Research",
    appearance: .session,
    expectedRevision: 4
  ), "native composer inserts a revision-CAS structured reference")
  check(document.text == "see @Research ", "native composer keeps readable reference text in the editor")
  check(
    (try? document.serializedText()) == "see \(canonical) ",
    "native composer serializes the hidden canonical reference for the Host"
  )
  var inlineReference = ArkComposerDraftDocument(text: "body")
  check(inlineReference.insertReference(
    in: NSRange(location: 4, length: 0),
    displayText: "@Research",
    canonicalReference: canonical,
    source: "reference",
    label: "Research",
    appearance: .session,
    expectedRevision: 0
  ), "plus launcher inserts an inline structured reference")
  check(
    inlineReference.text == "body @Research "
      && inlineReference.references.first?.offset == 5
      && (try? inlineReference.serializedText()) == "body \(canonical) ",
    "inline plus references preserve a word boundary and canonical reference offset"
  )
  check(
    document.deletionRange(caret: 13, backward: true) == NSRange(location: 4, length: 9),
    "native composer backspace can delete one structured reference atomically"
  )
  let encoded = try? JSONEncoder().encode(document)
  let restored = encoded.flatMap { try? JSONDecoder().decode(ArkComposerDraftDocument.self, from: $0) }
  check(restored == document, "native composer persists display text and canonical reference identity together")

  let staleRevision = document.revision - 1
  check(
    document.replacePlainText(
      in: NSRange(location: 0, length: 0),
      with: "x",
      expectedRevision: staleRevision
    ) == false,
    "native composer rejects a stale menu span instead of editing a newer draft"
  )

  document.replaceText("see @ResXearch ")
  check(document.references.isEmpty, "editing inside a structured reference converts it to ordinary text")
  check(
    (try? document.serializedText()) == "see @ResXearch ",
    "edited ordinary reference text never reuses stale hidden identity"
  )

  var current = ArkComposerDraftDocument(text: "new")
  current = current.prepending(restored!)
  check(current.text.hasSuffix("\nnew"), "failed submissions restore ahead of text typed during the request")
  check(current.references.count == 1, "failed submission restore retains structured references")
}

private func runComposerSubmissionChecks() {
  let goal = ArkComposerCommand(
    name: "goal",
    description: "Set goal",
    input: ArkComposerCommandInput(hint: "Goal text")
  )
  let compact = ArkComposerCommand(name: "compact", description: "Compact")
  let vision = ArkComposerCommand(
    name: "vision",
    description: "Vision",
    input: ArkComposerCommandInput(hint: "Prompt", acceptsImages: true)
  )
  check(
    (try? ArkComposerSubmissionRoute.resolve(
      text: "/goal ship it",
      imageCount: 0,
      commands: [goal, compact]
    )) == .command(goal),
    "native submit routes argument-taking Host commands away from the model"
  )
  check(
    (try? ArkComposerSubmissionRoute.resolve(
      text: "/compact",
      imageCount: 0,
      commands: [goal, compact]
    )) == .command(compact),
    "native submit executes an exact bare Host command"
  )
  check(
    (try? ArkComposerSubmissionRoute.resolve(
      text: "/compact extra",
      imageCount: 0,
      commands: [goal, compact]
    )) == .prompt,
    "an argued bare-only command remains ordinary prompt text"
  )
  check(
    (try? ArkComposerSubmissionRoute.resolve(
      text: "/dsh-code-review inspect this",
      imageCount: 0,
      commands: [goal, compact]
    )) == .prompt,
    "unknown command names remain available to the Host Skill pre-step"
  )
  do {
    _ = try ArkComposerSubmissionRoute.resolve(text: "/goal ship", imageCount: 1, commands: [goal])
    check(false, "native command submit refuses unsupported images without consuming the draft")
  } catch {
    check(true, "native command submit refuses unsupported images without consuming the draft")
  }
  check(
    (try? ArkComposerSubmissionRoute.resolve(
      text: "/vision inspect",
      imageCount: 1,
      commands: [vision]
    )) == .command(vision),
    "native command submit admits images only from authoritative command metadata"
  )
}

private func runComposerSourceShapeChecks() {
  let uiRoot = contractNativeRoot.appendingPathComponent("Sources/JiuzhangShellUI")
  let coreRoot = contractNativeRoot.appendingPathComponent("Sources/JiuzhangShellCore")
  let model = try? String(
    contentsOf: uiRoot.appendingPathComponent("ArkAppModel.swift"),
    encoding: .utf8
  )
  let root = try? String(
    contentsOf: uiRoot.appendingPathComponent("ArkRootView.swift"),
    encoding: .utf8
  )
  let editor = try? String(
    contentsOf: uiRoot.appendingPathComponent("NativeComposerTextView.swift"),
    encoding: .utf8
  )
  let api = try? String(
    contentsOf: coreRoot.appendingPathComponent("ArkComposerAPI.swift"),
    encoding: .utf8
  )
  check(
    api?.contains("commands/list") == true
      && api?.contains("skill/list") == true
      && api?.contains("fileReferences/list") == true
      && api?.contains("sessionReferenceResolver/candidates") == true,
    "native composer sources use the four canonical Host capabilities"
  )
  check(
    model?.contains("ArkComposerSubmissionRoute.resolve") == true
      && model?.contains("serializedText()") == true,
    "native submission adjudicates commands and serializes references before the prompt sink"
  )
  check(
    root?.contains("NativeComposerSuggestionPanel(model: model,") == true
      && root?.contains("model.openComposerSourceLauncher") == true
      && root?.contains("composerLauncherTasksSection") == true
      && root?.contains("composerLauncherPluginsSection") == true
      && root?.contains("ark.composer.suggestions.search") == true
      && root?.contains("ark.composer.suggestions.back") == true
      && root?.contains("composerSuggestionSelected") == true
      && model?.contains("ArkComposerSuggestionBuilder.capabilityLauncher") == true
      && model?.contains("openComposerReferenceCollection(.files") == true
      && model?.contains("openComposerReferenceCollection(.sessions") == true
      && model?.contains("public func updateComposerLauncherQuery") == true
      && model?.contains("composerLauncherFocusRevision &+= 1") == true
      && model?.contains("composerLauncherQuery == query") == true
      && model?.contains("loadComposerFiles(sessionID: sessionID, query: query)") == true
      && model?.contains("loadComposerSessions(sessionID: sessionID, query: query)") == true
      && root?.contains("model.composer = \"/plan \"") == false,
    "native composer uses one searchable, accessible dynamic panel instead of a second static plus or slash menu"
  )
  if let composer = root.flatMap({ source in
    composerSourceSlice(
      source,
      from: "private struct NativeComposer: View",
      through: "private struct NativeComposerSuggestionPanel: View"
    )
  }),
  let sizingBody = composerBalancedClosure(composer, marker: "VStack(spacing: 8) {"),
  let launcherOverlay = composerBalancedClosure(
    composer,
    marker: ".overlay(alignment: .top) {"
  ),
  let shadowRange = composer.range(
    of: ".shadow(color: Color.black.opacity(0.14), radius: 10, y: 4)"
  ),
  let overlayRange = composer.range(of: ".overlay(alignment: .top) {"),
  let sheetRange = composer.range(of: ".sheet(isPresented: $showDangerConfirmation) {") {
    let launcher = "NativeComposerSuggestionPanel(model: model,"
    let totalLauncherCount = composer.components(separatedBy: launcher).count - 1
    let sizingLauncherCount = sizingBody.components(separatedBy: launcher).count - 1
    let overlayLauncherCount = launcherOverlay.components(separatedBy: launcher).count - 1
    check(
      totalLauncherCount == 1
        && sizingLauncherCount == 0
        && overlayLauncherCount == 1
        && shadowRange.lowerBound < overlayRange.lowerBound
        && overlayRange.lowerBound < sheetRange.lowerBound
        && launcherOverlay.contains("dimensions[.bottom] + 8")
        && launcherOverlay.contains(".transition(.opacity)")
        && !composer.contains(".transition(.opacity.combined(with: .move(edge: .bottom)))"),
      "plus launcher has one owner inside the final non-sizing overlay and outside the sizing composer body"
    )
  } else {
    check(false, "native composer source remains available for launcher layout validation")
  }
  check(
    editor?.contains("onMenuKey") == true
      && editor?.contains("hasMarkedText()") == true
      && editor?.contains("onReferenceDeletionRange") == true
      && editor?.contains("private struct StyleFingerprint: Equatable") == true
      && editor?.contains("guard styleFingerprint != fingerprint else { return }") == true
      && editor?.contains("applyReferenceStylesIfNeeded(") == true,
    "AppKit composer arbitrates menu keys behind the IME guard and deletes references atomically"
  )
  check(
    editor?.contains("struct NativeComposerSearchField: NSViewRepresentable") == true
      && editor?.contains("final class ComposerNSSearchField: NSSearchField") == true
      && editor?.contains("private func focusComposerIfNeeded") == true
      && editor?.contains("private func focusSearchIfNeeded") == true
      && editor?.contains("window.isKeyWindow") == true
      && editor?.contains("window.firstResponder !== editor") == true
      && editor?.contains("ArkComposerMenuKey(nativeKeyCode: event.keyCode)") == true
      && root?.contains("handleMenuKey: { model.handleComposerMenuKey($0, isComposing: false) }") == true,
    "native composer focus is idempotent and the launcher search forwards Up, Down, Enter, and Escape"
  )
  check(
    editor?.contains("var onFocusMove: ((NativeComposerFocusAction) -> Void)?") == true
      && editor?.contains("if !moveKeyboardFocus(backward: false) { onFocusMove?(.next) }") == true
      && editor?.contains("if !moveKeyboardFocus(backward: true) { onFocusMove?(.previous) }") == true
      && root?.contains(".focused($toolbarFocus, equals: .sources)") == true
      && root?.contains(".focused($toolbarFocus, equals: .permission)") == true
      && root?.contains(".focused($toolbarFocus, equals: .attachment)") == true
      && root?.contains(".focused($toolbarFocus, equals: .model)") == true
      && root?.contains(".focused($toolbarFocus, equals: .stop)") == true
      && root?.contains(".focused($toolbarFocus, equals: .send)") == true
      && root?.contains(".accessibilityLabel(ArkL10n.text(.composerStop") == true,
    "native composer owns a complete toolbar focus fallback with an accessible stop action"
  )
}

private func composerSourceSlice(
  _ source: String,
  from startMarker: String,
  through endMarker: String
) -> String? {
  guard let start = source.range(of: startMarker),
        let end = source.range(of: endMarker, range: start.upperBound..<source.endIndex)
  else { return nil }
  return String(source[start.lowerBound..<end.upperBound])
}

private func composerBalancedClosure(_ source: String, marker: String) -> String? {
  guard let markerRange = source.range(of: marker),
        let openingBrace = source[markerRange.lowerBound..<markerRange.upperBound]
          .firstIndex(of: "{")
  else { return nil }
  var depth = 0
  var cursor = openingBrace
  while cursor < source.endIndex {
    switch source[cursor] {
    case "{":
      depth += 1
    case "}":
      depth -= 1
      if depth == 0 {
        return String(source[markerRange.lowerBound...cursor])
      }
    default:
      break
    }
    cursor = source.index(after: cursor)
  }
  return nil
}
