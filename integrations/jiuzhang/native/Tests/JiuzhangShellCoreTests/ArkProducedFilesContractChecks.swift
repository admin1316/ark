import Foundation
import JiuzhangShellCore
import JiuzhangShellUI

func runArkProducedFilesContractChecks() {
  let events = [
    producedCall(10, id: "report", turn: 3, view: .object([
      "card": .string("diff"),
      "diffs": .array([.object([
        "path": .string("site/report.html"),
        "newText": .string("report"),
      ])]),
    ])),
    producedResult(12, id: "report"),
    producedCall(13, id: "style-a", turn: 3, view: .object([
      "card": .string("generic"),
      "kind": .string("edit"),
      "locations": .array([.object(["path": .string("a/style.css")])]),
    ])),
    producedResult(15, id: "style-a"),
    producedCall(16, id: "style-a-again", turn: 3, view: .object([
      "card": .string("generic"),
      "kind": .string("edit"),
      "locations": .array([.object(["path": .string("a/style.css")])]),
    ])),
    producedResult(17, id: "style-a-again"),
    producedCall(18, id: "failed", turn: 3, view: .object([
      "card": .string("generic"),
      "kind": .string("edit"),
      "locations": .array([.object(["path": .string("failed.txt")])]),
    ])),
    producedResult(19, id: "failed", failed: true),
    producedCall(20, id: "read", turn: 3, view: .object([
      "card": .string("read"),
      "path": .string("notes.md"),
    ])),
    producedResult(21, id: "read"),
    producedCall(22, id: "style-b", turn: 3, view: .object([
      "card": .string("generic"),
      "kind": .string("edit"),
      "locations": .array([.object(["path": .string("b/style.css")])]),
    ])),
    producedResult(30, id: "style-b"),
  ]

  let replay = ArkProducedFilesProjection(events: events)
  var live = ArkProducedFilesProjection()
  for event in events { live.append(event) }
  check(
    replay.files == live.files,
    "produced files replay and live append are identical"
  )

  let atClosing = ArkProducedFilesProjection.files(replay.files, turn: 3, through: 24)
  check(
    atClosing.map(\.path) == ["site/report.html", "a/style.css"],
    "produced files keep first-seen successful mutations and exclude reads failures duplicates and late settlements"
  )

  let afterLateSettlement = ArkProducedFilesProjection.files(replay.files, turn: 3, through: 30)
  check(
    afterLateSettlement.map(\.path) == ["site/report.html", "a/style.css", "b/style.css"],
    "produced files retain same-basename paths as distinct exact identities"
  )
  let paths = afterLateSettlement.map(\.path)
  check(
    ArkProducedFilesProjection.resolveMention("report.html", paths: paths) == "site/report.html"
      && ArkProducedFilesProjection.resolveMention("a/style.css", paths: paths) == "a/style.css"
      && ArkProducedFilesProjection.resolveMention("style.css", paths: paths) == nil
      && ArkProducedFilesProjection.resolveMention("notes.md", paths: paths) == nil,
    "produced-file mentions resolve exact or unique basenames and fail closed on ambiguity or unwritten files"
  )
  let mentionURL = ArkProducedFilesProjection.mentionURL(for: "site/report.html")
  check(
    mentionURL.flatMap(ArkProducedFilesProjection.mentionPath(from:)) == "site/report.html",
    "produced-file inline links round-trip exact paths through the private native URL scheme"
  )

  let rootURL = contractNativeRoot.appendingPathComponent("Sources/JiuzhangShellUI/ArkRootView.swift")
  let modelURL = contractNativeRoot.appendingPathComponent("Sources/JiuzhangShellUI/ArkAppModel.swift")
  let toolURL = contractNativeRoot.appendingPathComponent("Sources/JiuzhangShellUI/ArkToolModels.swift")
  let markdownURL = contractNativeRoot.appendingPathComponent("Sources/JiuzhangShellUI/NativeMarkdownView.swift")
  let gfmURL = contractNativeRoot.appendingPathComponent("Sources/JiuzhangShellUI/NativeMarkdownGFMView.swift")
  guard let root = try? String(contentsOf: rootURL, encoding: .utf8),
        let model = try? String(contentsOf: modelURL, encoding: .utf8),
        let tool = try? String(contentsOf: toolURL, encoding: .utf8),
        let markdown = try? String(contentsOf: markdownURL, encoding: .utf8),
        let gfm = try? String(contentsOf: gfmURL, encoding: .utf8)
  else {
    check(false, "produced-file Native sources are readable")
    return
  }
  check(
    model.contains("producedFilesProjection.append(event)")
      && model.contains("producedFiles = producedFilesProjection.files")
      && root.contains("NativeProducedFilesRow")
      && root.contains("ark.chat.produced-files")
      && root.contains("openToolFile(file.path)"),
    "Native chat publishes durable produced-file chips through the existing Workbench file opener"
  )
  check(
    tool.contains("case .generic(let card) where card.kind == \"edit\"")
      && tool.contains("case .diff(let card)")
      && tool.contains("guard !resultFailed(event)")
      && !tool.contains("message.text"),
    "produced files derive from successful typed mutation views rather than model prose"
  )
  check(
    markdown.contains("ArkProducedFilesProjection.mentionPath(from: url)")
      && gfm.contains("ArkProducedFilesProjection.resolveMention")
      && gfm.contains("style.union(.code)"),
    "Native GFM inline-code mentions open only disambiguated produced files"
  )
}

private func producedCall(
  _ sequence: Int,
  id: String,
  turn: Int,
  view: JSONValue
) -> ArkHistoryEvent {
  ArkHistoryEvent(
    id: sequence,
    type: "tool/call",
    time: Date(timeIntervalSince1970: Double(sequence)),
    data: .object([
      "callId": .string(id),
      "turn": .number(Double(turn)),
      "name": .string("fixture"),
      "arguments": .string("{}"),
    ]),
    view: .object(["for": .string("call"), "view": view])
  )
}

private func producedResult(
  _ sequence: Int,
  id: String,
  failed: Bool = false
) -> ArkHistoryEvent {
  ArkHistoryEvent(
    id: sequence,
    type: "tool/result",
    time: Date(timeIntervalSince1970: Double(sequence)),
    data: .object([
      "message": .object([
        "source": .object(["callId": .string(id)]),
        "content": .array([.object([
          "type": .string("text"),
          "text": .string(failed ? "failed" : "ok"),
          "isError": .bool(failed),
        ])]),
      ]),
    ]),
    view: nil
  )
}
