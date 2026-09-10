import Foundation
import JiuzhangShellCore
@testable import JiuzhangShellUI

func runArkDocumentReferenceContractChecks() async {
  let root = FileManager.default.temporaryDirectory
    .appendingPathComponent("ark-document-reference-\(UUID().uuidString)", isDirectory: true)
  do {
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  } catch {
    check(false, "native document-reference fixture can be created")
    return
  }
  defer { try? FileManager.default.removeItem(at: root) }

  let store = ArkDocumentReferenceStore(rootURL: root)
  do {
    let paragraphs = (0..<12).map { index in
      index == 8
        ? "NEEDLE_CONTEXT 这是用户问题真正相关的长文段落。" + String(repeating: " 关键资料", count: 220)
        : "UNRELATED_\(index) " + String(repeating: "普通背景资料 ", count: 220)
    }
    let raw = paragraphs.joined(separator: "\n\n")
    let pasted = try await store.importPastedText(raw, name: "长文测试")
    let prompt = try await store.contextualizedPrompt(
      baseText: "请查找 NEEDLE_CONTEXT 关键资料",
      documents: [pasted]
    )
    check(
      pasted.extractedCharacters == raw.count
        && pasted.id.hasPrefix("sha256:")
        && prompt.hasPrefix("请查找 NEEDLE_CONTEXT 关键资料\n[[ARK_DOCUMENT_CONTEXT_V1:")
        && prompt.contains("NEEDLE_CONTEXT")
        && prompt.contains("Only bounded relevant excerpts are included")
        && prompt.count < raw.count,
      "long pasted text becomes one metadata-only document reference with bounded relevant excerpts"
    )
    var projection = ArkMessageProjection()
    _ = projection.append(ArkHistoryEvent(
      id: 1,
      type: "user/message",
      time: Date(timeIntervalSince1970: 1),
      data: .object([
        "content": .array([.object([
          "type": .string("text"),
          "text": .string(prompt),
        ])]),
      ]),
      view: nil
    ))
    let projected = projection.messages.first
    check(
      projected?.text == "请查找 NEEDLE_CONTEXT 关键资料"
        && projected?.documentReferences.map(\.name) == ["长文测试"]
        && projected?.documentReferences.first?.id == pasted.id
        && projected?.blocks == [.text("请查找 NEEDLE_CONTEXT 关键资料")]
        && projected?.text.contains("Only bounded relevant excerpts") == false,
      "native message projection keeps bounded document context model-only and renders durable metadata"
    )
    var legacyProjection = ArkMessageProjection()
    _ = legacyProjection.append(ArkHistoryEvent(
      id: 2,
      type: "user/message",
      time: Date(timeIntervalSince1970: 2),
      data: .object([
        "content": .array([.object([
          "type": .string("text"),
          "text": .string("旧问题\n\n[Local document: 旧文档.docx · sha256:abcdef123456]\nOnly bounded relevant excerpts are included; hidden"),
        ])]),
      ]),
      view: nil
    ))
    check(
      legacyProjection.messages.first?.text == "旧问题"
        && legacyProjection.messages.first?.documentReferences.first?.name == "旧文档.docx",
      "native message projection compacts pre-envelope bounded document messages"
    )
    var oversizedProjection = ArkMessageProjection()
    let oversizedText = String(repeating: "历史纯长文本", count: 2_000)
    _ = oversizedProjection.append(ArkHistoryEvent(
      id: 3,
      type: "user/message",
      time: Date(timeIntervalSince1970: 3),
      data: .object([
        "content": .array([.object([
          "type": .string("text"),
          "text": .string(oversizedText),
        ])]),
      ]),
      view: nil
    ))
    check(
      oversizedProjection.messages.first?.text.isEmpty == true
        && oversizedProjection.messages.first?.blocks.isEmpty == true
        && oversizedProjection.messages.first?.documentReferences.first?.id
          .hasPrefix("legacy-long:") == true
        && oversizedProjection.messages.first?.documentReferences.first?.sourceBytes
          == oversizedText.utf8.count,
      "native message projection compacts legacy plain long text into one durable document card"
    )
    let permissions = (try? FileManager.default.attributesOfItem(atPath: pasted.textURL.path)[.posixPermissions]) as? NSNumber
    check(
      permissions?.intValue == 0o600,
      "native document-reference extracted text is owner-private"
    )

    let sourceText = root.appendingPathComponent("word-source.txt")
    let wordURL = root.appendingPathComponent("word-fixture.docx")
    try Data("WORD_IMPORT_MARKER 来自真实 DOCX。".utf8).write(to: sourceText)
    let converter = Process()
    converter.executableURL = URL(fileURLWithPath: "/usr/bin/textutil")
    converter.arguments = ["-convert", "docx", "-output", wordURL.path, "--", sourceText.path]
    converter.standardOutput = FileHandle.nullDevice
    converter.standardError = FileHandle.nullDevice
    try converter.run()
    converter.waitUntilExit()
    guard converter.terminationStatus == 0 else {
      check(false, "native document-reference DOCX fixture can be produced")
      return
    }
    let word = try await store.importFile(wordURL)
    let wordPrompt = try await store.contextualizedPrompt(
      baseText: "WORD_IMPORT_MARKER 是什么？",
      documents: [word]
    )
    check(
      word.name == "word-fixture.docx"
        && wordPrompt.contains("WORD_IMPORT_MARKER"),
      "native document reference imports Word through the platform extractor"
    )

    await store.remove([pasted, word])
    check(
      !FileManager.default.fileExists(atPath: pasted.textURL.path)
        && !FileManager.default.fileExists(atPath: word.textURL.path),
      "native document-reference temporary text is removed after use"
    )
  } catch {
    check(false, "native document-reference behavior succeeds: \(error.localizedDescription)")
  }

  let rootSource = (try? String(
    contentsOf: contractNativeRoot.appendingPathComponent(
      "Sources/JiuzhangShellUI/ArkRootView.swift"
    )
  )) ?? ""
  let composerSource = (try? String(
    contentsOf: contractNativeRoot.appendingPathComponent(
      "Sources/JiuzhangShellUI/NativeComposerTextView.swift"
    )
  )) ?? ""
  let modelSource = (try? String(
    contentsOf: contractNativeRoot.appendingPathComponent(
      "Sources/JiuzhangShellUI/ArkAppModel.swift"
    )
  )) ?? ""
  check(
    rootSource.contains("model.pendingDocuments")
      && rootSource.contains("ark.composer.document.")
      && rootSource.contains("ark.chat.document.")
      && rootSource.contains(".frame(width: 224, height: 54, alignment: .leading)")
      && !rootSource.contains(".frame(maxWidth: 280, minHeight: 48, alignment: .leading)")
      && rootSource.contains("private func arkSessionDisplayTitle(")
      && rootSource.contains("let marker = \"[[ARK_DOCUMENT_\"")
      && rootSource.contains("arkSessionDisplayTitle(session.title")
      && rootSource.contains("UTType(filenameExtension: \"docx\")")
      && composerSource.contains("ArkDocumentReferenceStore.longPasteThreshold")
      && composerSource.contains("onPasteDocument")
      && modelSource.contains("documentStore.contextualizedPrompt")
      && modelSource.contains("await documentStore.remove(documents)"),
    "native composer owns long-paste cards, Word intake, bounded context, and cleanup"
  )
}
