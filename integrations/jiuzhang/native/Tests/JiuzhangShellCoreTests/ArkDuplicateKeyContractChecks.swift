import Foundation
import JiuzhangShellCore
import JiuzhangShellUI

func runArkDuplicateKeyContractChecks() {
  let providerRows = ArkProviderModelInput.encodedRows(
    [
      ArkProviderModelInput(id: "model-b", name: "Edited B"),
      ArkProviderModelInput(id: "model-a", name: "Edited A"),
      ArkProviderModelInput(id: "model-a", name: "Ignored duplicate input"),
    ],
    preserving: [
      .object([
        "id": .string("model-a"),
        "providerField": .string("first-a"),
      ]),
      .object([
        "id": .string("model-a"),
        "providerField": .string("later-a"),
      ]),
      .object([
        "id": .string("model-b"),
        "providerField": .string("first-b"),
      ]),
    ]
  )
  check(
    providerRows.count == 2
      && providerRows[0]["id"]?.stringValue == "model-b"
      && providerRows[0]["name"]?.stringValue == "Edited B"
      && providerRows[0]["providerField"]?.stringValue == "first-b"
      && providerRows[1]["id"]?.stringValue == "model-a"
      && providerRows[1]["name"]?.stringValue == "Edited A"
      && providerRows[1]["providerField"]?.stringValue == "first-a",
    "provider model encoding preserves edited order and the first stored row for duplicate ids"
  )

  let feedbackValue: JSONValue = .object([
    "items": .array([
      feedbackRow(messageID: "message-1", rating: "positive", version: "11111111-1111-4111-8111-111111111111"),
      feedbackRow(messageID: "message-2", rating: "negative", version: "22222222-2222-4222-8222-222222222222"),
    ]),
  ])
  let feedback = try? ArkFeedbackAPIContract.items(from: feedbackValue)
  check(
    feedback?.map(\.messageID) == ["message-1", "message-2"],
    "message feedback preserves the Host array order for unique ids"
  )
  do {
    _ = try ArkFeedbackAPIContract.items(from: .object([
      "items": .array([
        feedbackRow(messageID: "same-message", rating: "positive", version: "33333333-3333-4333-8333-333333333333"),
        feedbackRow(messageID: "same-message", rating: "negative", version: "44444444-4444-4444-8444-444444444444"),
      ]),
    ]))
    check(false, "message feedback rejects duplicate message ids as an invalid wire response")
  } catch {
    check(true, "message feedback rejects duplicate message ids as an invalid wire response")
  }

  let sessions = ArkSessionSummary.uniquePreservingFirst([
    session(id: "session-a", title: "first-a"),
    session(id: "session-b", title: "only-b"),
    session(id: "session-a", title: "later-a"),
  ])
  check(
    sessions.map(\.id) == ["session-a", "session-b"]
      && sessions.map(\.title) == ["first-a", "only-b"],
    "session navigation preserves Host order and the first row for duplicate ids"
  )

  let graphNodes = ArkWikiLoader.firstGraphNodeByPath([
    .object(["path": .string("concepts/a.md"), "id": .string("first-a")]),
    .object(["path": .string("concepts/a.md"), "id": .string("later-a")]),
    .object(["path": .string("concepts/b.md"), "id": .string("only-b")]),
    .object(["path": .string(""), "id": .string("invalid")]),
  ])
  check(
    graphNodes.count == 2
      && graphNodes["concepts/a.md"]?["id"]?.stringValue == "first-a"
      && graphNodes["concepts/b.md"]?["id"]?.stringValue == "only-b",
    "Wiki graph metadata keeps the first node for each nonempty path"
  )

  let fileRows = ArkWikiLoader.uniqueFileRowsByPath([
    .object(["path": .string("concepts/a.md"), "name": .string("first-a")]),
    .object(["path": .string("concepts/b.md"), "name": .string("only-b")]),
    .object(["path": .string("concepts/a.md"), "name": .string("later-a")]),
    .object(["name": .string("missing-path")]),
  ])
  check(
    fileRows.compactMap { $0["path"]?.stringValue } == ["concepts/a.md", "concepts/b.md"]
      && fileRows.first?["name"]?.stringValue == "first-a",
    "Wiki file rows preserve traversal order and the first row for duplicate paths"
  )

  let bilingualRows: [JSONValue] = [
    .object(["path": .string("guides/start.md"), "name": .string("start.md")]),
    .object(["path": .string("guides/start.zh.md"), "name": .string("start.zh.md")]),
    .object(["path": .string("guides/english-only.md"), "name": .string("english-only.md")]),
    .object(["path": .string("guides/chinese-only.zh.md"), "name": .string("chinese-only.zh.md")]),
  ]
  check(
    ArkWikiLoader.localizedFileRows(bilingualRows, language: .zh)
      .compactMap { $0["path"]?.stringValue }
      == ["guides/start.zh.md", "guides/english-only.md", "guides/chinese-only.zh.md"],
    "Chinese Wiki projection keeps one Chinese member per pair and retains unpaired knowledge"
  )
  check(
    ArkWikiLoader.localizedFileRows(bilingualRows, language: .en)
      .compactMap { $0["path"]?.stringValue }
      == ["guides/start.md", "guides/english-only.md", "guides/chinese-only.zh.md"],
    "English Wiki projection keeps one English member per pair and retains unpaired knowledge"
  )
  check(
    ArkWikiLoader.fallbackTitle(path: "guides/start.zh.md", name: "start.zh.md") == "start"
      && ArkWikiLoader.fallbackTitle(path: "guides/start.md", name: nil) == "start",
    "Wiki fallback titles never expose Markdown localization suffixes"
  )

  let pages = ArkWikiLoader.uniquePagesByID([
    wikiPage(id: "node-a", path: "concepts/a.md", title: "first-a"),
    wikiPage(id: "node-b", path: "concepts/b.md", title: "only-b"),
    wikiPage(id: "node-a", path: "concepts/duplicate-a.md", title: "later-a"),
  ])
  check(
    pages.map(\.id) == ["node-a", "node-b"]
      && pages.map(\.title) == ["first-a", "only-b"],
    "Wiki pages preserve list order and the first page for duplicate graph ids"
  )
  let localizedPages = [
    wikiPage(id: "paired", path: "guides/start.md", title: "Start"),
    wikiPage(id: "paired", path: "guides/start.zh.md", title: "开始"),
    wikiPage(id: "single", path: "guides/single.md", title: "Single"),
  ]
  let chinesePages = ArkWikiLoader.localizedPages(localizedPages, language: .zh)
  let chineseEdges = ArkWikiLoader.visibleEdges([
    ArkWikiEdge(source: "paired", target: "single"),
    ArkWikiEdge(source: "hidden", target: "single"),
  ], pages: chinesePages)
  check(
    chinesePages.map(\.title) == ["开始", "Single"]
      && chineseEdges == [ArkWikiEdge(source: "paired", target: "single")],
    "Wiki language projection chooses before duplicate-id folding and releases hidden-language edges"
  )
  check(
    ArkWikiLoader.firstPageByID([
      wikiPage(id: "node-a", path: "concepts/a.md", title: "first-a"),
      wikiPage(id: "node-a", path: "concepts/duplicate-a.md", title: "later-a"),
    ])["node-a"]?.title == "first-a",
    "Wiki graph lookup retains the first page for a duplicate node id"
  )

  let sourceRoot = contractNativeRoot.appendingPathComponent("Sources", isDirectory: true)
  let unsafeFiles = swiftSources(containing: "Dictionary(uniqueKeysWithValues:", under: sourceRoot)
  check(
    unsafeFiles.isEmpty,
    "Native production sources contain no duplicate-key trapping Dictionary initializer"
  )
}

private func feedbackRow(messageID: String, rating: String, version: String) -> JSONValue {
  .object([
    "messageId": .string(messageID),
    "rating": .string(rating),
    "version": .string(version),
  ])
}

private func session(id: String, title: String) -> ArkSessionSummary {
  ArkSessionSummary(
    id: id,
    title: title,
    updatedAt: Date(timeIntervalSince1970: 1),
    running: false,
    blank: false,
    cwd: "/tmp",
    agentPreset: nil,
    permissionPreset: nil,
    parentSessionID: nil,
    origin: nil
  )
}

private func wikiPage(id: String, path: String, title: String) -> ArkWikiPage {
  ArkWikiPage(
    id: id,
    title: title,
    relativePath: path,
    category: "concepts",
    body: "",
    links: [],
    byteCount: 0
  )
}

private func swiftSources(containing needle: String, under root: URL) -> [String] {
  guard let enumerator = FileManager.default.enumerator(
    at: root,
    includingPropertiesForKeys: [.isRegularFileKey],
    options: [.skipsHiddenFiles]
  ) else { return ["<source enumeration failed>"] }
  var matches: [String] = []
  for case let url as URL in enumerator where url.pathExtension == "swift" {
    guard let text = try? String(contentsOf: url, encoding: .utf8) else {
      matches.append(url.path)
      continue
    }
    if text.contains(needle) { matches.append(url.path) }
  }
  return matches.sorted()
}
