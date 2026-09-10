import Foundation

/// One content-search match returned by `session.search`.
public struct ArkSessionSearchHit: Identifiable, Equatable, Sendable {
  public let sessionID: String
  public let snippet: String

  public var id: String { sessionID }

  public init(sessionID: String, snippet: String) {
    self.sessionID = sessionID
    self.snippet = snippet
  }
}

/// One bounded page returned by `session.search`.
public struct ArkSessionSearchPage: Equatable, Sendable {
  public let items: [ArkSessionSearchHit]
  public let hasMore: Bool

  public init(items: [ArkSessionSearchHit], hasMore: Bool) {
    self.items = items
    self.hasMore = hasMore
  }
}

/// The normalized title and durable event sequence returned by `session.rename`.
public struct ArkSessionRenameResult: Equatable, Sendable {
  public let title: String
  public let sequence: Int

  public init(title: String, sequence: Int) {
    self.title = title
    self.sequence = sequence
  }
}

/// A complete model route selected for the next session request.
public struct ArkModelSelection: Equatable, Sendable {
  public let provider: String
  public let model: String
  public let reasoningEffort: String?

  public init(provider: String, model: String, reasoningEffort: String? = nil) {
    self.provider = provider
    self.model = model
    self.reasoningEffort = reasoningEffort
  }
}

/// One adapter-owned reasoning effort for an exact model route.
public struct ArkModelReasoningEffort: Identifiable, Equatable, Sendable {
  public let id: String
  public let name: String
  public let description: String?

  public init(id: String, name: String, description: String? = nil) {
    self.id = id
    self.name = name
    self.description = description
  }
}

/// Reasoning choices advertised for one exact model.
public struct ArkModelReasoning: Equatable, Sendable {
  public let efforts: [ArkModelReasoningEffort]
  public let defaultEffort: String?

  public init(efforts: [ArkModelReasoningEffort], defaultEffort: String? = nil) {
    self.efforts = efforts
    self.defaultEffort = defaultEffort
  }
}

/// One model advertised inside a provider group.
public struct ArkModelCatalogModel: Identifiable, Equatable, Sendable {
  public let id: String
  public let name: String
  public let description: String?
  public let reasoning: ArkModelReasoning?

  public init(
    id: String,
    name: String,
    description: String? = nil,
    reasoning: ArkModelReasoning? = nil
  ) {
    self.id = id
    self.name = name
    self.description = description
    self.reasoning = reasoning
  }
}

/// One provider and its advisory model catalog.
public struct ArkModelProviderGroup: Identifiable, Equatable, Sendable {
  public let id: String
  public let name: String
  public let models: [ArkModelCatalogModel]

  public init(id: String, name: String, models: [ArkModelCatalogModel]) {
    self.id = id
    self.name = name
    self.models = models
  }
}

/// One provider-local failure that did not invalidate other model groups.
public struct ArkModelCatalogFailure: Identifiable, Equatable, Sendable {
  public let id: String
  public let name: String
  public let message: String

  public init(id: String, name: String, message: String) {
    self.id = id
    self.name = name
    self.message = message
  }
}

/// The detached model directory returned for one session.
public struct ArkSessionModels: Equatable, Sendable {
  public let current: ArkModelSelection
  public let routable: Bool
  public let groups: [ArkModelProviderGroup]
  public let failures: [ArkModelCatalogFailure]

  public init(
    current: ArkModelSelection,
    routable: Bool,
    groups: [ArkModelProviderGroup],
    failures: [ArkModelCatalogFailure]
  ) {
    self.current = current
    self.routable = routable
    self.groups = groups
    self.failures = failures
  }
}

/// Settled result kind returned by `commands/execute`.
public enum ArkCommandResultKind: String, Equatable, Sendable {
  case success
  case error
}

/// One admitted and durably paired slash-command execution.
public struct ArkCommandExecution: Identifiable, Equatable, Sendable {
  public let id: String
  public let result: ArkCommandResultKind
  public let text: String?
  public let sourceEventSequence: Int?

  public init(
    id: String,
    result: ArkCommandResultKind,
    text: String? = nil,
    sourceEventSequence: Int? = nil
  ) {
    self.id = id
    self.result = result
    self.text = text
    self.sourceEventSequence = sourceEventSequence
  }
}

/// One browser-free page fetched by the Host and rendered natively as Markdown.
public struct ArkWorkbenchWebDocument: Equatable, Sendable {
  public let url: String
  public let title: String
  public let statusCode: Int
  public let markdown: String
  public let truncated: Bool

  public init(url: String, title: String, statusCode: Int, markdown: String, truncated: Bool) {
    self.url = url
    self.title = title
    self.statusCode = statusCode
    self.markdown = markdown
    self.truncated = truncated
  }
}

/// One hybrid-search match in the native knowledge workspace.
public struct ArkKnowledgeSearchHit: Identifiable, Equatable, Sendable {
  public let path: String
  public let score: Double

  public var id: String { path }

  public init(path: String, score: Double) {
    self.path = path
    self.score = score
  }
}

/// Outcome of creating one canonical human-authored knowledge page.
public struct ArkKnowledgeWriteResult: Equatable, Sendable {
  public let path: String
  public let succeeded: Bool
  public let error: String?
  public let conflict: Bool

  public init(
    path: String,
    succeeded: Bool,
    error: String? = nil,
    conflict: Bool = false
  ) {
    self.path = path
    self.succeeded = succeeded
    self.error = error
    self.conflict = conflict
  }
}

/// One page produced by deep research.
public struct ArkKnowledgeFinding: Identifiable, Equatable, Sendable {
  public let title: String
  public let path: String

  public var id: String { path }

  public init(title: String, path: String) {
    self.title = title
    self.path = path
  }
}

/// One action advertised by a knowledge-governance review.
public struct ArkKnowledgeReviewAction: Identifiable, Equatable, Sendable {
  public let action: String
  public let label: String

  public var id: String { action }

  public init(action: String, label: String) {
    self.action = action
    self.label = label
  }
}

/// One knowledge-governance review and its available resolution actions.
public struct ArkKnowledgeReviewItem: Identifiable, Equatable, Sendable {
  public let id: String
  public let title: String
  public let type: String
  public let description: String?
  public let affectedPages: [String]
  public let actions: [ArkKnowledgeReviewAction]
  public let resolved: Bool
  public let resolvedAction: String?

  public init(
    id: String,
    title: String,
    type: String,
    description: String? = nil,
    affectedPages: [String] = [],
    actions: [ArkKnowledgeReviewAction] = [],
    resolved: Bool,
    resolvedAction: String? = nil
  ) {
    self.id = id
    self.title = title
    self.type = type
    self.description = description
    self.affectedPages = affectedPages
    self.actions = actions
    self.resolved = resolved
    self.resolvedAction = resolvedAction
  }
}

public enum ArkKnowledgeIngestStatus: String, Equatable, Sendable {
  case pending
  case running
  case done
  case error
  case cancelled
}

/// One Host-owned knowledge ingestion task. Project confinement and execution
/// stay behind the Remote; Native receives only user-facing queue facts.
public struct ArkKnowledgeIngestTask: Identifiable, Equatable, Sendable {
  public let id: Int
  public let input: String
  public let status: ArkKnowledgeIngestStatus
  public let written: [String]
  public let error: String?

  public init(
    id: Int,
    input: String,
    status: ArkKnowledgeIngestStatus,
    written: [String] = [],
    error: String? = nil
  ) {
    self.id = id
    self.input = input
    self.status = status
    self.written = written
    self.error = error
  }
}

public struct ArkKnowledgeIngestQueue: Equatable, Sendable {
  public let tasks: [ArkKnowledgeIngestTask]
  public let running: Bool
  public let cancelled: Bool

  public init(tasks: [ArkKnowledgeIngestTask], running: Bool, cancelled: Bool) {
    self.tasks = tasks
    self.running = running
    self.cancelled = cancelled
  }

  public var hasActiveTasks: Bool {
    tasks.contains { $0.status == .pending || $0.status == .running }
  }

  public var pendingCount: Int { tasks.filter { $0.status == .pending }.count }
  public var completedCount: Int { tasks.filter { $0.status == .done }.count }
}

public enum ArkHTTPURLInput {
  public static func normalizedHTTPURL(_ rawValue: String) -> String? {
    let normalized = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard
      let components = URLComponents(string: normalized),
      let scheme = components.scheme?.lowercased(),
      scheme == "http" || scheme == "https",
      components.host?.isEmpty == false
    else { return nil }
    return normalized
  }
}

/// Method names and strict response decoders shared by native feature surfaces.
public enum ArkDomainAPIContract {
  public enum Method {
    public static let sessionCancel = "session/cancel"
    public static let sessionRename = "session/rename"
    public static let sessionFork = "session/fork"
    public static let sessionSearch = "session/search"
    public static let sessionModels = "session/models"
    public static let sessionSelectModel = "session/selectModel"
    public static let workspaceArchiveSession = "workspace/archiveSession"
    public static let workspaceCreate = "workspace/create"
    public static let workspaceRename = "workspace/rename"
    public static let workspaceDelete = "workspace/delete"
    public static let workspaceInsertBefore = "workspace/insertBefore"
    public static let workspaceInsertSessionBefore = "workspace/insertSessionBefore"
    public static let commandsList = "commands/list"
    public static let commandsExecute = "commands/execute"
    public static let knowledgeSearch = "knowledgeWiki/search"
    public static let knowledgeCreatePage = "knowledgeWiki/createPage"
    public static let knowledgeWritePage = "knowledgeWiki/writePage"
    public static let knowledgeDeepResearch = "knowledgeWiki/deepResearch"
    public static let knowledgeReviews = "knowledgeWiki/reviews"
    public static let knowledgeResolveReview = "knowledgeWiki/resolveReview"
    public static let knowledgeResolveReviews = "knowledgeWiki/resolveReviews"
    public static let knowledgeIngestQueueAdd = "knowledgeWiki/ingestQueueAdd"
    public static let knowledgeIngestQueueStatus = "knowledgeWiki/ingestQueueStatus"
    public static let knowledgeIngestQueueCancel = "knowledgeWiki/ingestQueueCancel"
    public static let hostModels = "llm/models"
    public static let workbenchWebRead = "workbench/webRead"
  }

  public static func sessionSearch(from value: JSONValue) throws -> ArkSessionSearchPage {
    guard let rows = value["items"]?.arrayValue,
          let hasMore = value["hasMore"]?.boolValue
    else { throw invalidResponse("session.search") }
    let items = try rows.map { row -> ArkSessionSearchHit in
      guard let sessionID = row["sessionId"]?.stringValue,
            let snippet = row["snippet"]?.stringValue
      else { throw invalidResponse("session.search item") }
      return ArkSessionSearchHit(sessionID: sessionID, snippet: snippet)
    }
    return ArkSessionSearchPage(items: items, hasMore: hasMore)
  }

  public static func sessionRename(from value: JSONValue) throws -> ArkSessionRenameResult {
    guard let title = value["title"]?.stringValue,
          let sequence = nonnegativeInteger(value["seq"])
    else { throw invalidResponse("session.rename") }
    return ArkSessionRenameResult(title: title, sequence: sequence)
  }

  public static func sessionModels(from value: JSONValue) throws -> ArkSessionModels {
    guard let currentValue = value["current"],
          let routable = value["routable"]?.boolValue,
          let groupValues = value["groups"]?.arrayValue,
          let failureValues = value["failures"]?.arrayValue
    else { throw invalidResponse("session.models") }
    return ArkSessionModels(
      current: try modelSelection(from: currentValue),
      routable: routable,
      groups: try groupValues.map(modelGroup(from:)),
      failures: try failureValues.map(modelFailure(from:))
    )
  }

  public static func selectedModel(from value: JSONValue) throws -> ArkModelSelection {
    guard let selected = value["selected"] else {
      throw invalidResponse("session.selectModel")
    }
    return try modelSelection(from: selected)
  }

  /// Host-scoped model catalog groups (llm.models): the authoritative
  /// per-model reasoning capability list, available before any session exists.
  public static func hostModels(from value: JSONValue) throws -> [ArkModelProviderGroup] {
    guard let groupValues = value["groups"]?.arrayValue else {
      throw invalidResponse("llm.models")
    }
    return try groupValues.map(modelGroup(from:))
  }

  public static func archivedSessionIDs(from value: JSONValue) throws -> [String] {
    guard let values = value["archivedSessionIds"]?.arrayValue else {
      throw invalidResponse("workspace archive state")
    }
    return try stringArray(values, context: "workspace archive state")
  }

  public static func createdWorkspace(from value: JSONValue) throws -> ArkWorkspace {
    guard let workspace = value["workspace"] else {
      throw invalidResponse("workspace.create")
    }
    return try self.workspace(from: workspace)
  }

  public static func renamedWorkspace(from value: JSONValue) throws -> ArkWorkspace {
    guard let workspace = value["workspace"] else {
      throw invalidResponse("workspace.rename")
    }
    return try self.workspace(from: workspace)
  }

  public static func deletedWorkspace(from value: JSONValue) throws -> Bool {
    guard let deleted = value["deleted"]?.boolValue else {
      throw invalidResponse("workspace.delete")
    }
    return deleted
  }

  public static func workspaceOrder(from value: JSONValue) throws -> [String] {
    guard let values = value["workspaceIds"]?.arrayValue else {
      throw invalidResponse("workspace.insertBefore")
    }
    return try stringArray(values, context: "workspace.insertBefore")
  }

  public static func workspace(from value: JSONValue) throws -> ArkWorkspace {
    guard let id = value["workspaceId"]?.stringValue,
          let path = value["path"]?.stringValue,
          let title = value["title"]?.stringValue,
          let sessionValues = value["sessionIds"]?.arrayValue
    else { throw invalidResponse("workspace") }
    return ArkWorkspace(
      id: id,
      path: path,
      title: title,
      sessionIDs: try stringArray(sessionValues, context: "workspace sessionIds")
    )
  }

  public static func movedWorkspace(from value: JSONValue) throws -> ArkWorkspace {
    guard let workspaceValue = value["workspace"] else {
      throw invalidResponse("workspace.insertSessionBefore")
    }
    return try workspace(from: workspaceValue)
  }

  public static func workbenchWebDocument(from value: JSONValue) throws -> ArkWorkbenchWebDocument {
    guard let url = value["url"]?.stringValue,
          let title = value["title"]?.stringValue,
          let statusCode = nonnegativeInteger(value["statusCode"]),
          let markdown = value["markdown"]?.stringValue,
          let truncated = value["truncated"]?.boolValue
    else { throw invalidResponse("host.workbenchWebRead") }
    return ArkWorkbenchWebDocument(
      url: url,
      title: title,
      statusCode: statusCode,
      markdown: markdown,
      truncated: truncated
    )
  }

  public static func commandExecution(from value: JSONValue) throws -> ArkCommandExecution? {
    if case .null = value { return nil }
    guard let commandID = value["commandId"]?.stringValue,
          let resultValue = value["result"],
          let kindValue = resultValue["kind"]?.stringValue,
          let kind = ArkCommandResultKind(rawValue: kindValue)
    else { throw invalidResponse("commands/execute") }
    let sourceSequence: Int?
    if resultValue["sourceEventSeq"] == nil {
      sourceSequence = nil
    } else {
      guard let parsed = nonnegativeInteger(resultValue["sourceEventSeq"]) else {
        throw invalidResponse("commands/execute sourceEventSeq")
      }
      sourceSequence = parsed
    }
    return ArkCommandExecution(
      id: commandID,
      result: kind,
      text: resultValue["text"]?.stringValue,
      sourceEventSequence: sourceSequence
    )
  }

  public static func knowledgeSearch(from value: JSONValue) throws -> [ArkKnowledgeSearchHit] {
    guard let rows = value.arrayValue else { throw invalidResponse("knowledgeWiki/search") }
    return try rows.map { row in
      guard let path = row["path"]?.stringValue,
            let score = row["score"]?.numberValue
      else { throw invalidResponse("knowledgeWiki/search item") }
      return ArkKnowledgeSearchHit(path: path, score: score)
    }
  }

  public static func knowledgeWrite(from value: JSONValue) throws -> ArkKnowledgeWriteResult {
    guard let path = value["path"]?.stringValue,
          let succeeded = value["ok"]?.boolValue
    else { throw invalidResponse("knowledgeWiki/createPage") }
    return ArkKnowledgeWriteResult(
      path: path,
      succeeded: succeeded,
      error: value["error"]?.stringValue,
      conflict: value["conflict"]?.boolValue == true
    )
  }

  public static func knowledgeFindings(from value: JSONValue) throws -> [ArkKnowledgeFinding] {
    guard let rows = value["findings"]?.arrayValue else {
      throw invalidResponse("knowledgeWiki/deepResearch")
    }
    return try rows.map { row in
      guard let title = row["title"]?.stringValue,
            let path = row["path"]?.stringValue
      else { throw invalidResponse("knowledgeWiki/deepResearch finding") }
      return ArkKnowledgeFinding(title: title, path: path)
    }
  }

  public static func knowledgeReviews(from value: JSONValue) throws -> [ArkKnowledgeReviewItem] {
    guard let rows = value.arrayValue else { throw invalidResponse("knowledgeWiki/reviews") }
    return try rows.map(knowledgeReview(from:))
  }

  public static func resolvedReview(from value: JSONValue) throws -> Bool {
    guard let resolved = value.boolValue else {
      throw invalidResponse("knowledgeWiki/resolveReview")
    }
    return resolved
  }

  public static func resolvedReviewCount(from value: JSONValue) throws -> Int {
    guard let count = nonnegativeInteger(value) else {
      throw invalidResponse("knowledgeWiki/resolveReviews")
    }
    return count
  }

  public static func knowledgeIngestQueue(from value: JSONValue) throws -> ArkKnowledgeIngestQueue {
    guard
      let rows = value["tasks"]?.arrayValue,
      let running = value["running"]?.boolValue,
      let cancelled = value["cancelled"]?.boolValue
    else { throw invalidResponse("knowledgeWiki/ingestQueueStatus") }
    let tasks = try rows.map { row -> ArkKnowledgeIngestTask in
      guard
        let id = nonnegativeInteger(row["id"]),
        let input = row["input"]?.stringValue, !input.isEmpty,
        let statusValue = row["status"]?.stringValue,
        let status = ArkKnowledgeIngestStatus(rawValue: statusValue)
      else { throw invalidResponse("knowledgeWiki/ingestQueueStatus task") }
      let written = try stringArray(
        row["written"]?.arrayValue ?? [],
        context: "knowledgeWiki/ingestQueueStatus written"
      )
      return ArkKnowledgeIngestTask(
        id: id,
        input: input,
        status: status,
        written: written,
        error: row["error"]?.stringValue
      )
    }
    return ArkKnowledgeIngestQueue(tasks: tasks, running: running, cancelled: cancelled)
  }

  private static func modelSelection(from value: JSONValue) throws -> ArkModelSelection {
    guard let provider = value["provider"]?.stringValue,
          let model = value["model"]?.stringValue
    else { throw invalidResponse("model selection") }
    return ArkModelSelection(
      provider: provider,
      model: model,
      reasoningEffort: value["reasoningEffort"]?.stringValue
    )
  }

  private static func modelEffort(from value: JSONValue) throws -> ArkModelReasoningEffort {
    guard let id = value["id"]?.stringValue,
          let name = value["name"]?.stringValue
    else { throw invalidResponse("model reasoning effort") }
    return ArkModelReasoningEffort(
      id: id,
      name: name,
      description: value["description"]?.stringValue
    )
  }

  private static func modelReasoning(from value: JSONValue) throws -> ArkModelReasoning {
    guard let effortValues = value["efforts"]?.arrayValue else {
      throw invalidResponse("model reasoning")
    }
    return ArkModelReasoning(
      efforts: try effortValues.map(modelEffort(from:)),
      defaultEffort: value["defaultEffort"]?.stringValue
    )
  }

  private static func model(from value: JSONValue) throws -> ArkModelCatalogModel {
    guard let id = value["id"]?.stringValue,
          let name = value["name"]?.stringValue
    else { throw invalidResponse("model catalog item") }
    return ArkModelCatalogModel(
      id: id,
      name: name,
      description: value["description"]?.stringValue,
      reasoning: try value["reasoning"].map(modelReasoning(from:))
    )
  }

  private static func modelGroup(from value: JSONValue) throws -> ArkModelProviderGroup {
    guard let id = value["id"]?.stringValue,
          let name = value["name"]?.stringValue,
          let models = value["models"]?.arrayValue
    else { throw invalidResponse("model provider group") }
    return ArkModelProviderGroup(id: id, name: name, models: try models.map(model(from:)))
  }

  private static func modelFailure(from value: JSONValue) throws -> ArkModelCatalogFailure {
    guard let id = value["id"]?.stringValue,
          let name = value["name"]?.stringValue,
          let message = value["message"]?.stringValue
    else { throw invalidResponse("model catalog failure") }
    return ArkModelCatalogFailure(id: id, name: name, message: message)
  }

  private static func knowledgeReview(from value: JSONValue) throws -> ArkKnowledgeReviewItem {
    guard let id = value["id"]?.stringValue,
          let title = value["title"]?.stringValue,
          let type = value["type"]?.stringValue,
          let resolved = value["resolved"]?.boolValue
    else { throw invalidResponse("knowledgeWiki/reviews item") }
    let affectedPages = try stringArray(
      value["affectedPages"]?.arrayValue ?? [],
      context: "knowledgeWiki/reviews affectedPages"
    )
    let actions = try (value["options"]?.arrayValue ?? []).map { action -> ArkKnowledgeReviewAction in
      guard let id = action["action"]?.stringValue,
            let label = action["label"]?.stringValue
      else { throw invalidResponse("knowledgeWiki/reviews option") }
      return ArkKnowledgeReviewAction(action: id, label: label)
    }
    return ArkKnowledgeReviewItem(
      id: id,
      title: title,
      type: type,
      description: value["description"]?.stringValue,
      affectedPages: affectedPages,
      actions: actions,
      resolved: resolved,
      resolvedAction: value["resolvedAction"]?.stringValue
    )
  }

  private static func stringArray(_ values: [JSONValue], context: String) throws -> [String] {
    try values.map { value in
      guard let string = value.stringValue else { throw invalidResponse(context) }
      return string
    }
  }

  private static func nonnegativeInteger(_ value: JSONValue?) -> Int? {
    guard let number = value?.numberValue,
          number.isFinite,
          number >= 0,
          number.rounded(.towardZero) == number,
          number < Double(Int.max)
    else { return nil }
    return Int(number)
  }

  private static func invalidResponse(_ operation: String) -> ArkAPIError {
    ArkAPIError(message: "本机服务返回了无效的 \(operation) 响应")
  }
}

extension ArkAPIClient {
  /// Stop the active turn while retaining the session's queued work.
  public func cancelSession(sessionID: String) async throws {
    let value = try await remoteDomainRequest(
      method: ArkDomainAPIContract.Method.sessionCancel,
      request: ["sessionId": .string(sessionID)]
    )
    guard value["accepted"]?.boolValue == true else {
      throw ArkAPIError(message: "本机服务没有确认停止会话")
    }
  }

  /// Rename one session and return the Host-normalized durable title.
  public func renameSession(sessionID: String, title: String) async throws -> ArkSessionRenameResult {
    let value = try await remoteDomainRequest(
      method: ArkDomainAPIContract.Method.sessionRename,
      request: ["sessionId": .string(sessionID), "title": .string(title)]
    )
    return try ArkDomainAPIContract.sessionRename(from: value)
  }

  /// Fork a session at its latest completed turn, or at one explicit event boundary.
  public func forkSession(sessionID: String, atSequence: Int? = nil) async throws -> String {
    var payload: [String: JSONValue] = ["sessionId": .string(sessionID)]
    if let atSequence { payload["atSeq"] = .number(Double(atSequence)) }
    let value = try await remoteDomainRequest(
      method: ArkDomainAPIContract.Method.sessionFork,
      request: payload
    )
    guard let childID = value["sessionId"]?.stringValue, !childID.isEmpty else {
      throw ArkAPIError(message: "本机服务没有返回分叉会话标识")
    }
    return childID
  }

  /// Search visible user and assistant content without mutating the session list.
  public func searchSessions(query: String) async throws -> ArkSessionSearchPage {
    let value = try await remoteDomainRequest(
      method: ArkDomainAPIContract.Method.sessionSearch,
      request: ["query": .string(query)]
    )
    return try ArkDomainAPIContract.sessionSearch(from: value)
  }

  /// Load the advisory model directory for an ordinary session.
  public func sessionModels(sessionID: String) async throws -> ArkSessionModels {
    let value = try await remoteDomainRequest(
      method: ArkDomainAPIContract.Method.sessionModels,
      request: ["sessionId": .string(sessionID)]
    )
    return try ArkDomainAPIContract.sessionModels(from: value)
  }

  /// Load the host-scoped model directory (llm.models): groups carry the
  /// authoritative reasoning efforts for every registered provider/model.
  public func hostModels() async throws -> [ArkModelProviderGroup] {
    let value = try await remoteCall(method: ArkDomainAPIContract.Method.hostModels)
    return try ArkDomainAPIContract.hostModels(from: value)
  }

  /// Fetch one public web page through the Host's SSRF-safe provider and native Markdown projection.
  public func workbenchWebRead(url: String) async throws -> ArkWorkbenchWebDocument {
    let value = try await remoteRequest(
      method: ArkDomainAPIContract.Method.workbenchWebRead,
      request: ["url": .string(url)]
    )
    return try ArkDomainAPIContract.workbenchWebDocument(from: value)
  }

  /// Select the complete model route used by the session's next assembled request.
  public func selectModel(
    sessionID: String,
    selection: ArkModelSelection
  ) async throws -> ArkModelSelection {
    var payload: [String: JSONValue] = [
      "sessionId": .string(sessionID),
      "provider": .string(selection.provider),
      "model": .string(selection.model),
    ]
    if let effort = selection.reasoningEffort {
      payload["reasoningEffort"] = .string(effort)
    }
    let value = try await remoteDomainRequest(
      method: ArkDomainAPIContract.Method.sessionSelectModel,
      request: payload
    )
    return try ArkDomainAPIContract.selectedModel(from: value)
  }

  /// Archive one session while retaining its durable log and workspace slot.
  @discardableResult
  public func archiveSession(sessionID: String) async throws -> [String] {
    let value = try await remoteDomainRequest(
      method: ArkDomainAPIContract.Method.workspaceArchiveSession,
      request: ["sessionId": .string(sessionID)]
    )
    return try ArkDomainAPIContract.archivedSessionIDs(from: value)
  }

  /// Register an existing local directory as a Workspace.
  @discardableResult
  public func createWorkspace(path: String) async throws -> ArkWorkspace {
    let value = try await remoteDomainRequest(
      method: ArkDomainAPIContract.Method.workspaceCreate,
      request: ["path": .string(path)]
    )
    return try ArkDomainAPIContract.createdWorkspace(from: value)
  }

  /// Rename one registered Workspace without renaming its directory.
  @discardableResult
  public func renameWorkspace(workspaceID: String, title: String) async throws -> ArkWorkspace {
    let value = try await remoteDomainRequest(
      method: ArkDomainAPIContract.Method.workspaceRename,
      request: [
        "workspaceId": .string(workspaceID),
        "title": .string(title),
      ]
    )
    return try ArkDomainAPIContract.renamedWorkspace(from: value)
  }

  /// Remove one Workspace registration. Files and session logs remain untouched.
  @discardableResult
  public func deleteWorkspace(workspaceID: String) async throws -> Bool {
    let value = try await remoteDomainRequest(
      method: ArkDomainAPIContract.Method.workspaceDelete,
      request: ["workspaceId": .string(workspaceID)]
    )
    return try ArkDomainAPIContract.deletedWorkspace(from: value)
  }

  /// Move one Workspace in the durable registry display order.
  @discardableResult
  public func moveWorkspace(
    workspaceID: String,
    beforeWorkspaceID: String? = nil
  ) async throws -> [String] {
    var payload: [String: JSONValue] = ["workspaceId": .string(workspaceID)]
    if let beforeWorkspaceID { payload["beforeWorkspaceId"] = .string(beforeWorkspaceID) }
    let value = try await remoteDomainRequest(
      method: ArkDomainAPIContract.Method.workspaceInsertBefore,
      request: payload
    )
    return try ArkDomainAPIContract.workspaceOrder(from: value)
  }

  /// Move one accounted session within its Workspace's manual order.
  @discardableResult
  public func moveSession(
    sessionID: String,
    inWorkspaceID workspaceID: String,
    beforeSessionID: String? = nil
  ) async throws -> ArkWorkspace {
    var payload: [String: JSONValue] = [
      "workspaceId": .string(workspaceID),
      "sessionId": .string(sessionID),
    ]
    if let beforeSessionID { payload["beforeSessionId"] = .string(beforeSessionID) }
    let value = try await remoteDomainRequest(
      method: ArkDomainAPIContract.Method.workspaceInsertSessionBefore,
      request: payload
    )
    return try ArkDomainAPIContract.movedWorkspace(from: value)
  }

  /// Execute one slash-command without routing its text through the model.
  public func executeCommand(
    sessionID: String,
    line: String,
    images: [ArkPromptImage] = []
  ) async throws -> ArkCommandExecution? {
    let encodedImages: [JSONValue] = images.map { image in
      var value: [String: JSONValue] = [
        "mediaType": .string(image.mediaType.rawValue),
        "data": .string(image.data.base64EncodedString()),
      ]
      if let name = image.name, !name.isEmpty { value["name"] = .string(name) }
      return .object(value)
    }
    let value = try await remoteCall(
      method: ArkDomainAPIContract.Method.commandsExecute,
      args: [
        "agentId": .string(sessionID),
        "line": .string(line),
        "images": .array(encodedImages),
      ]
    )
    return try ArkDomainAPIContract.commandExecution(from: value)
  }

  /// Switch a session's permission preset through the Host-owned `/permission` command.
  @discardableResult
  public func setPermissionPreset(
    sessionID: String,
    preset: String
  ) async throws -> ArkCommandExecution {
    let selected = preset.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !selected.isEmpty else { throw ArkAPIError(message: "权限预设不能为空") }
    guard let execution = try await executeCommand(
      sessionID: sessionID,
      line: "/permission \(selected)"
    ) else {
      throw ArkAPIError(message: "当前会话没有提供权限切换命令")
    }
    guard execution.result == .success else {
      throw ArkAPIError(message: execution.text ?? "权限切换失败")
    }
    return execution
  }

  /// Run hybrid search over the active native knowledge project.
  public func searchKnowledge(
    query: String,
    topK: Int = 8
  ) async throws -> [ArkKnowledgeSearchHit] {
    guard topK > 0 else { throw ArkAPIError(message: "知识检索数量必须大于零") }
    let value = try await remoteCall(
      method: ArkDomainAPIContract.Method.knowledgeSearch,
      args: ["request": .object(["query": .string(query), "topK": .number(Double(topK))])]
    )
    return try ArkDomainAPIContract.knowledgeSearch(from: value)
  }

  /// Create one human-authored canonical page in the active knowledge project.
  public func createKnowledgePage(
    title: String,
    content: String? = nil
  ) async throws -> ArkKnowledgeWriteResult {
    var request: [String: JSONValue] = ["title": .string(title)]
    if let content { request["content"] = .string(content) }
    let value = try await remoteCall(
      method: ArkDomainAPIContract.Method.knowledgeCreatePage,
      args: ["request": .object(request)]
    )
    return try ArkDomainAPIContract.knowledgeWrite(from: value)
  }

  /// Compare-and-swap one existing knowledge page through the Host-owned,
  /// root-confined atomic writer.
  public func writeKnowledgePage(
    path: String,
    content: String,
    expectedContent: String
  ) async throws -> ArkKnowledgeWriteResult {
    let value = try await remoteCall(
      method: ArkDomainAPIContract.Method.knowledgeWritePage,
      args: [
        "request": .object([
          "path": .string(path),
          "content": .string(content),
          "expectedContent": .string(expectedContent),
        ]),
      ]
    )
    return try ArkDomainAPIContract.knowledgeWrite(from: value)
  }

  /// Run the Host-owned deep-research pipeline and return its Candidate pages.
  public func runDeepResearch(topic: String) async throws -> [ArkKnowledgeFinding] {
    let value = try await remoteCall(
      method: ArkDomainAPIContract.Method.knowledgeDeepResearch,
      args: ["request": .object(["topic": .string(topic)])]
    )
    return try ArkDomainAPIContract.knowledgeFindings(from: value)
  }

  /// Load knowledge-governance reviews using the Host's status filter.
  public func knowledgeReviews(
    status: String = "unresolved",
    limit: Int = 100
  ) async throws -> [ArkKnowledgeReviewItem] {
    guard limit > 0 else { throw ArkAPIError(message: "Review 数量必须大于零") }
    let value = try await remoteCall(
      method: ArkDomainAPIContract.Method.knowledgeReviews,
      args: [
        "request": .object([
          "status": .string(status),
          "limit": .number(Double(limit)),
        ]),
      ]
    )
    return try ArkDomainAPIContract.knowledgeReviews(from: value)
  }

  /// Resolve one knowledge-governance review with an optional advertised action.
  @discardableResult
  public func resolveKnowledgeReview(
    reviewID: String,
    action: String? = nil
  ) async throws -> Bool {
    var request: [String: JSONValue] = ["reviewId": .string(reviewID)]
    if let action { request["action"] = .string(action) }
    let value = try await remoteCall(
      method: ArkDomainAPIContract.Method.knowledgeResolveReview,
      args: ["request": .object(request)]
    )
    return try ArkDomainAPIContract.resolvedReview(from: value)
  }

  /// Resolve several knowledge-governance reviews in one Host transaction.
  @discardableResult
  public func resolveKnowledgeReviews(
    reviewIDs: [String],
    action: String? = nil
  ) async throws -> Int {
    var request: [String: JSONValue] = [
      "ids": .array(reviewIDs.map(JSONValue.string)),
    ]
    if let action { request["action"] = .string(action) }
    let value = try await remoteCall(
      method: ArkDomainAPIContract.Method.knowledgeResolveReviews,
      args: ["request": .object(request)]
    )
    return try ArkDomainAPIContract.resolvedReviewCount(from: value)
  }

  /// Enqueue project-relative sources or public http(s) URLs in the Host-owned queue.
  public func enqueueKnowledgeIngest(inputs: [String]) async throws -> ArkKnowledgeIngestQueue {
    let normalized = inputs.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
    guard !normalized.isEmpty else { throw ArkAPIError(message: "知识导入来源不能为空") }
    let value = try await remoteCall(
      method: ArkDomainAPIContract.Method.knowledgeIngestQueueAdd,
      args: ["request": .object(["inputs": .array(normalized.map(JSONValue.string))])]
    )
    return try ArkDomainAPIContract.knowledgeIngestQueue(from: value)
  }

  public func knowledgeIngestQueueStatus() async throws -> ArkKnowledgeIngestQueue {
    let value = try await remoteCall(method: ArkDomainAPIContract.Method.knowledgeIngestQueueStatus)
    return try ArkDomainAPIContract.knowledgeIngestQueue(from: value)
  }

  /// Cancel all pending tasks through the Host queue owner. The running task
  /// remains owned by Host and is allowed to finish safely.
  public func cancelPendingKnowledgeIngests() async throws -> ArkKnowledgeIngestQueue {
    let value = try await remoteCall(method: ArkDomainAPIContract.Method.knowledgeIngestQueueCancel)
    return try ArkDomainAPIContract.knowledgeIngestQueue(from: value)
  }
}
