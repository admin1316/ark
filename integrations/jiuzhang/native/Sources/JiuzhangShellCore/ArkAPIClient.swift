import Foundation

/// JSON values used by the native client to consume the merge-extensible Ark RPC payloads.
public enum JSONValue: Codable, Equatable, Sendable {
  case object([String: JSONValue])
  case array([JSONValue])
  case string(String)
  case number(Double)
  case bool(Bool)
  case null

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() { self = .null }
    else if let value = try? container.decode(Bool.self) { self = .bool(value) }
    else if let value = try? container.decode(Double.self) { self = .number(value) }
    else if let value = try? container.decode(String.self) { self = .string(value) }
    else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
    else { self = .object(try container.decode([String: JSONValue].self)) }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .object(let value): try container.encode(value)
    case .array(let value): try container.encode(value)
    case .string(let value): try container.encode(value)
    case .number(let value): try container.encode(value)
    case .bool(let value): try container.encode(value)
    case .null: try container.encodeNil()
    }
  }

  public subscript(key: String) -> JSONValue? {
    guard case .object(let value) = self else { return nil }
    return value[key]
  }

  public var objectValue: [String: JSONValue]? {
    guard case .object(let value) = self else { return nil }
    return value
  }

  public var arrayValue: [JSONValue]? {
    guard case .array(let value) = self else { return nil }
    return value
  }

  public var stringValue: String? {
    guard case .string(let value) = self else { return nil }
    return value
  }

  public var numberValue: Double? {
    guard case .number(let value) = self else { return nil }
    return value
  }

  public var boolValue: Bool? {
    guard case .bool(let value) = self else { return nil }
    return value
  }
}

/// One workspace shown in the native navigation column.
public struct ArkWorkspace: Identifiable, Equatable, Sendable {
  public let id: String
  public let path: String
  public let title: String
  public let sessionIDs: [String]

  public init(id: String, path: String, title: String, sessionIDs: [String]) {
    self.id = id
    self.path = path
    self.title = title
    self.sessionIDs = sessionIDs
  }
}

/// Reconnect baseline for Workspace grouping and the durable archive set.
public struct ArkWorkspaceList: Equatable, Sendable {
  public let items: [ArkWorkspace]
  public let archivedSessionIDs: Set<String>

  public init(items: [ArkWorkspace], archivedSessionIDs: Set<String>) {
    self.items = items
    self.archivedSessionIDs = archivedSessionIDs
  }
}

/// One session row shown in the native navigation column.
public struct ArkSessionSummary: Identifiable, Equatable, Sendable {
  public let id: String
  public let title: String
  public let updatedAt: Date
  public let running: Bool
  public let blank: Bool
  public let cwd: String?
  public let agentPreset: String?
  public let permissionPreset: String?
  public let parentSessionID: String?
  public let origin: String?

  public init(
    id: String,
    title: String,
    updatedAt: Date,
    running: Bool,
    blank: Bool,
    cwd: String?,
    agentPreset: String?,
    permissionPreset: String?,
    parentSessionID: String?,
    origin: String?
  ) {
    self.id = id
    self.title = title
    self.updatedAt = updatedAt
    self.running = running
    self.blank = blank
    self.cwd = cwd
    self.agentPreset = agentPreset
    self.permissionPreset = permissionPreset
    self.parentSessionID = parentSessionID
    self.origin = origin
  }

  /// Preserve the Host list order and retain its first row when a malformed
  /// response repeats one opaque Session identity.
  public static func uniquePreservingFirst(_ rows: [ArkSessionSummary]) -> [ArkSessionSummary] {
    var seen = Set<String>()
    return rows.filter { seen.insert($0.id).inserted }
  }
}

/// One raw event returned by session.history.
public struct ArkHistoryEvent: Identifiable, Equatable, Sendable {
  public let id: Int
  public let type: String
  public let time: Date
  public let data: JSONValue
  public let view: JSONValue?

  public init(id: Int, type: String, time: Date, data: JSONValue, view: JSONValue?) {
    self.id = id
    self.type = type
    self.time = time
    self.data = data
    self.view = view
  }
}

/// One backward history page and its continuation boundary.
public struct ArkHistoryPage: Equatable, Sendable {
  public let events: [ArkHistoryEvent]
  public let hasMore: Bool
  public let beforeSequence: Int?
  public let projections: [String: JSONValue]

  public init(
    events: [ArkHistoryEvent],
    hasMore: Bool,
    beforeSequence: Int?,
    projections: [String: JSONValue] = [:]
  ) {
    self.events = events
    self.hasMore = hasMore
    self.beforeSequence = beforeSequence
    self.projections = projections
  }
}

/// A text message projected from the raw session history.
public enum ArkMessageBlock: Equatable, Sendable {
  case text(String)
  case reasoning(String)
  case image(String)
  case unknown(type: String, value: JSONValue)
}

public struct ArkMessageDocumentReference: Identifiable, Equatable, Sendable {
  public let id: String
  public let name: String
  public let sourceBytes: Int
  public let extractedCharacters: Int

  public init(id: String, name: String, sourceBytes: Int, extractedCharacters: Int) {
    self.id = id
    self.name = name
    self.sourceBytes = sourceBytes
    self.extractedCharacters = extractedCharacters
  }
}

public struct ArkMessage: Identifiable, Equatable, Sendable {
  public enum Role: String, Sendable {
    case user
    case assistant
    case system
  }

  public let id: Int
  public let role: Role
  public let text: String
  public let reasoning: String?
  public let attachmentIDs: [String]
  public let documentReferences: [ArkMessageDocumentReference]
  public let messageID: String?
  public let source: JSONValue?
  public let sourceKind: String?
  public let sourceForm: String?
  public let sourceSummary: String?
  public let turn: Int?
  public let step: Int?
  public let interrupted: Bool
  public let blocks: [ArkMessageBlock]
  public let time: Date

  public init(
    id: Int,
    role: Role,
    text: String,
    reasoning: String? = nil,
    attachmentIDs: [String] = [],
    documentReferences: [ArkMessageDocumentReference] = [],
    messageID: String? = nil,
    source: JSONValue? = nil,
    sourceKind: String? = nil,
    sourceForm: String? = nil,
    sourceSummary: String? = nil,
    turn: Int? = nil,
    step: Int? = nil,
    interrupted: Bool = false,
    blocks: [ArkMessageBlock] = [],
    time: Date
  ) {
    self.id = id
    self.role = role
    self.text = text
    self.reasoning = reasoning
    self.attachmentIDs = attachmentIDs
    self.documentReferences = documentReferences
    self.messageID = messageID
    self.source = source
    self.sourceKind = sourceKind
    self.sourceForm = sourceForm
    self.sourceSummary = sourceSummary
    self.turn = turn
    self.step = step
    self.interrupted = interrupted
    self.blocks = blocks
    self.time = time
  }
}

/// Incremental chat projection used by the native event pump.
///
/// A live text delta updates only its active assistant row. The UI may then
/// publish snapshots at display cadence instead of rebuilding thousands of
/// history events for every token.
public struct ArkMessageProjection: Sendable {
  private var rows: [ArkMessage] = []
  private var partialIndex: [String: Int] = [:]
  private var partialBlocks: [String: [Int: ArkMessageBlock]] = [:]
  private var finalized = Set<String>()

  public init(events: [ArkHistoryEvent] = []) {
    reset(events: events)
  }

  public var messages: [ArkMessage] { rows }

  public mutating func reset(events: [ArkHistoryEvent]) {
    rows = []
    partialIndex = [:]
    partialBlocks = [:]
    finalized = []
    for event in events.sorted(by: { $0.id < $1.id }) {
      _ = append(event)
    }
  }

  @discardableResult
  public mutating func append(_ event: ArkHistoryEvent) -> Bool {
    if event.type == "llm/retry" {
      let key = Self.stepKey(event.data)
      finalized.remove(key)
      partialBlocks.removeValue(forKey: key)
      guard let index = partialIndex.removeValue(forKey: key), rows.indices.contains(index) else {
        return false
      }
      rows.remove(at: index)
      for (partialKey, partialRow) in Array(partialIndex) where partialRow > index {
        partialIndex[partialKey] = partialRow - 1
      }
      return true
    }
    if event.type == "assistant/chunk",
       let chunkType = event.data["chunk"]?["type"]?.stringValue,
       chunkType == "text-delta" || chunkType == "reasoning-delta",
       let text = event.data["chunk"]?["text"]?.stringValue,
       !text.isEmpty
    {
      let key = Self.stepKey(event.data)
      // Older/replayed stream frames may omit the content-block index. Keep
      // reasoning and visible text in separate deterministic fallback slots
      // instead of letting the later kind overwrite the earlier one.
      let blockIndex = event.data["chunk"]?["index"]?.numberValue.map(Int.init)
        ?? (chunkType == "reasoning-delta" ? 0 : 1)
      guard !finalized.contains(key) else { return false }
      var blocks = partialBlocks[key] ?? [:]
      switch chunkType {
      case "text-delta":
        let previous = blocks[blockIndex]
        let prefix = if case .text(let value) = previous { value } else { "" }
        blocks[blockIndex] = .text(prefix + text)
      case "reasoning-delta":
        let previous = blocks[blockIndex]
        let prefix = if case .reasoning(let value) = previous { value } else { "" }
        blocks[blockIndex] = .reasoning(prefix + text)
      default:
        break
      }
      partialBlocks[key] = blocks
      let orderedBlocks = blocks.keys.sorted().compactMap { blocks[$0] }
      let visibleText = orderedBlocks.compactMap { block -> String? in
        if case .text(let value) = block { return value }
        return nil
      }.joined()
      let visibleReasoning = orderedBlocks.compactMap { block -> String? in
        if case .reasoning(let value) = block { return value }
        return nil
      }.joined()
      if let index = partialIndex[key], rows.indices.contains(index) {
        let current = rows[index]
        rows[index] = ArkMessage(
          id: current.id,
          role: .assistant,
          text: visibleText,
          reasoning: visibleReasoning.isEmpty ? nil : visibleReasoning,
          attachmentIDs: current.attachmentIDs,
          documentReferences: current.documentReferences,
          messageID: current.messageID,
          source: current.source,
          sourceKind: current.sourceKind,
          sourceForm: current.sourceForm,
          sourceSummary: current.sourceSummary,
          turn: current.turn,
          step: current.step,
          interrupted: current.interrupted,
          blocks: orderedBlocks,
          time: current.time
        )
      } else {
        partialIndex[key] = rows.count
        rows.append(ArkMessage(
          id: event.id,
          role: .assistant,
          text: visibleText,
          reasoning: visibleReasoning.isEmpty ? nil : visibleReasoning,
          turn: Int(event.data["turn"]?.numberValue ?? -1),
          step: Int(event.data["step"]?.numberValue ?? -1),
          blocks: orderedBlocks,
          time: event.time
        ))
      }
      return true
    }

    guard event.type.contains("message") else { return false }
    // A compaction checkpoint is model-facing replacement material, not a
    // human/context message. Chat renders its lifecycle marker separately.
    if event.type == "user/message" {
      let value = event.data["message"] ?? event.data
      let source = value["source"]
      if source?["kind"]?.stringValue == "plugin",
         source?["plugin"]?.stringValue == "compact",
         source?["compactionId"]?.stringValue != nil
      {
        return false
      }
    }
    let rawText = ArkAPIClient.textContent(in: event.data) ?? ""
    let reasoning = ArkAPIClient.reasoningContent(in: event.data)
    let attachmentIDs = ArkAPIClient.imageAttachmentIDs(in: event.data)
    let messageValue = event.data["message"] ?? event.data
    var blocks = ArkAPIClient.messageBlocks(in: messageValue)

    let role: ArkMessage.Role
    if event.type.hasPrefix("user/") { role = .user }
    else if event.type.hasPrefix("assistant/") { role = .assistant }
    else { role = .system }
    let documentEnvelope = role == .user ? ArkDocumentMessageEnvelope.parse(rawText) : nil
    let text = documentEnvelope?.displayText ?? rawText
    if documentEnvelope != nil {
      blocks = text.isEmpty ? [] : [.text(text)]
    }
    let documentReferences = documentEnvelope?.documents ?? []
    guard !text.isEmpty || reasoning?.isEmpty == false || !attachmentIDs.isEmpty
      || !documentReferences.isEmpty
    else { return false }
    let message = ArkMessage(
      id: event.id,
      role: role,
      text: text,
      reasoning: reasoning,
      attachmentIDs: attachmentIDs,
      documentReferences: documentReferences,
      messageID: messageValue["id"]?.stringValue,
      source: messageValue["source"],
      sourceKind: messageValue["source"]?["kind"]?.stringValue,
      sourceForm: messageValue["source"]?["form"]?.stringValue,
      sourceSummary: messageValue["source"]?["summary"]?.stringValue,
      turn: event.data["turn"]?.numberValue.map(Int.init),
      step: event.data["step"]?.numberValue.map(Int.init),
      interrupted: event.data["interrupted"]?.boolValue == true,
      blocks: blocks,
      time: event.time
    )

    if role == .assistant {
      let key = Self.stepKey(event.data)
      finalized.insert(key)
      partialBlocks.removeValue(forKey: key)
      if let index = partialIndex.removeValue(forKey: key), rows.indices.contains(index) {
        rows[index] = message
        return true
      }
    }
    rows.append(message)
    return true
  }

  private static func stepKey(_ value: JSONValue) -> String {
    let turn = Int(value["turn"]?.numberValue ?? -1)
    let step = Int(value["step"]?.numberValue ?? -1)
    return "\(turn):\(step)"
  }
}

private enum ArkDocumentMessageEnvelope {
  private static let prefix = "[[ARK_DOCUMENT_CONTEXT_V1:"
  private static let suffix = "]]"
  private static let oversizedPlainTextThreshold = 8_000

  struct Value {
    let displayText: String
    let documents: [ArkMessageDocumentReference]
  }

  private struct Payload: Decodable {
    struct Reference: Decodable {
      let id: String
      let name: String
      let sourceBytes: Int
      let extractedCharacters: Int
    }

    let displayText: String
    let documents: [Reference]
  }

  static func parse(_ text: String) -> Value? {
    if let value = parseVersionOne(text) { return value }
    if let value = parseLegacy(text) { return value }
    return parseOversizedPlainText(text)
  }

  private static func parseVersionOne(_ text: String) -> Value? {
    guard let marker = text.split(separator: "\n", omittingEmptySubsequences: false)
      .map(String.init)
      .first(where: { $0.hasPrefix(prefix) && $0.hasSuffix(suffix) })
    else { return nil }
    let start = marker.index(marker.startIndex, offsetBy: prefix.count)
    let end = marker.index(marker.endIndex, offsetBy: -suffix.count)
    let encoded = String(marker[start..<end])
    guard encoded.count <= 64_000,
          let data = Data(base64Encoded: encoded),
          let payload = try? JSONDecoder().decode(Payload.self, from: data),
          payload.displayText.count <= 100_000,
          !payload.documents.isEmpty,
          payload.documents.count <= 8
    else { return nil }
    let references = payload.documents.compactMap { reference -> ArkMessageDocumentReference? in
      guard reference.id.range(of: #"^sha256:[0-9a-f]{64}$"#, options: .regularExpression) != nil,
            !reference.name.isEmpty,
            reference.name.count <= 512,
            reference.sourceBytes > 0,
            reference.extractedCharacters > 0
      else { return nil }
      return ArkMessageDocumentReference(
        id: reference.id,
        name: reference.name,
        sourceBytes: reference.sourceBytes,
        extractedCharacters: reference.extractedCharacters
      )
    }
    guard references.count == payload.documents.count else { return nil }
    return Value(displayText: payload.displayText, documents: references)
  }

  private static func parseLegacy(_ text: String) -> Value? {
    let marker = "[Local document: "
    guard let markerRange = text.range(of: marker),
          let lineEnd = text[markerRange.lowerBound...].firstIndex(of: "\n")
    else { return nil }
    let header = String(text[markerRange.lowerBound..<lineEnd])
    guard header.hasSuffix("]") else { return nil }
    let bodyStart = header.index(header.startIndex, offsetBy: marker.count)
    let bodyEnd = header.index(before: header.endIndex)
    let body = String(header[bodyStart..<bodyEnd])
    guard let digestSeparator = body.range(of: " · sha256:") else { return nil }
    let name = String(body[..<digestSeparator.lowerBound])
    let digest = String(body[digestSeparator.upperBound...])
    guard !name.isEmpty,
          name.count <= 512,
          digest.range(of: #"^[0-9a-f]{12,64}$"#, options: .regularExpression) != nil
    else { return nil }
    let visible = String(text[..<markerRange.lowerBound])
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return Value(
      displayText: visible,
      documents: [ArkMessageDocumentReference(
        id: "legacy-sha256:\(digest)",
        name: name,
        sourceBytes: text.utf8.count,
        extractedCharacters: text.count
      )]
    )
  }

  /// Old candidates could submit a long paste before the document envelope
  /// was installed. Keep that history usable without laying out the complete
  /// payload as one giant chat row.
  private static func parseOversizedPlainText(_ text: String) -> Value? {
    guard text.utf8.count >= oversizedPlainTextThreshold else { return nil }
    var digest: UInt64 = 14_695_981_039_346_656_037
    for byte in text.utf8 {
      digest ^= UInt64(byte)
      digest &*= 1_099_511_628_211
    }
    return Value(
      displayText: "",
      documents: [ArkMessageDocumentReference(
        id: String(format: "legacy-long:%016llx", digest),
        name: "",
        sourceBytes: text.utf8.count,
        extractedCharacters: text.count
      )]
    )
  }
}

/// Transport or host failure returned by the local Ark RPC service.
public struct ArkAPIError: LocalizedError, Sendable {
  public let message: String
  public let code: String?
  public let details: JSONValue?

  public init(message: String, code: String? = nil, details: JSONValue? = nil) {
    self.message = message
    self.code = code
    self.details = details
  }

  public var errorDescription: String? { message }
}

/// Bearer-authenticated client for the loopback RPC service owned by Ark.app.
public actor ArkAPIClient {
  private let baseURL: URL
  private let apiToken: String
  private let session: URLSession

  public init(baseURL: URL, apiToken: String, session: URLSession = .shared) {
    self.baseURL = baseURL
    self.apiToken = apiToken
    self.session = session
  }

  public static func endpointURL(baseURL: URL, method: String) -> URL {
    baseURL.appendingPathComponent("api/\(method)")
  }

  /// Call one `/api/<method>` endpoint and return its successful value.
  public func call(method: String, payload: JSONValue = .object([:])) async throws -> JSONValue {
    let rpcID = UUID().uuidString.lowercased()
    let body: JSONValue = .object([
      "type": .string("client-request"),
      "rpcId": .string(rpcID),
      "method": .string(method),
      "payload": payload,
    ])
    var request = URLRequest(url: Self.endpointURL(baseURL: baseURL, method: method))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(apiToken)", forHTTPHeaderField: "Authorization")
    request.httpBody = try JSONEncoder().encode(body)

    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let status = (response as? HTTPURLResponse)?.statusCode ?? -1
      throw ArkAPIError(message: "本机服务请求失败（HTTP \(status)）")
    }
    let envelope = try JSONDecoder().decode(JSONValue.self, from: data)
    guard envelope["type"]?.stringValue == "server-response",
          envelope["rpcId"]?.stringValue == rpcID,
          let result = envelope["result"]
    else {
      throw ArkAPIError(message: "本机服务返回了无效响应")
    }
    if result["ok"]?.boolValue == true, let value = result["value"] {
      return value
    }
    let error = result["error"]
    let message = error?["message"]?.stringValue
      ?? error?["code"]?.stringValue
      ?? "本机服务拒绝了请求"
    throw ArkAPIError(
      message: message,
      code: error?["code"]?.stringValue,
      details: error?["details"]
    )
  }

  public func workspaceList() async throws -> ArkWorkspaceList {
    let value = try await remoteDomainCall(method: "workspace/list")
    return ArkWorkspaceList(
      items: value["items"]?.arrayValue?.compactMap(Self.workspace(from:)) ?? [],
      archivedSessionIDs: Set(value["archivedSessionIds"]?.arrayValue?.compactMap(\.stringValue) ?? [])
    )
  }

  public func sessions() async throws -> [ArkSessionSummary] {
    let value = try await remoteDomainRequest(method: "session/list", request: [:])
    return ArkSessionSummary.uniquePreservingFirst(
      value["items"]?.arrayValue?.compactMap(Self.session(from:)) ?? []
    )
  }

  public func historyPage(
    sessionID: String,
    beforeSequence: Int? = nil,
    maxMessages: Int = 100
  ) async throws -> ArkHistoryPage {
    var request: [String: JSONValue] = [
      "sessionId": .string(sessionID),
      "maxMessages": .number(Double(maxMessages)),
    ]
    if let beforeSequence { request["beforeSeq"] = .number(Double(beforeSequence)) }
    let value = try await remoteDomainRequest(method: "session/history", request: request)
    return try Self.validatedHistoryPage(from: value, context: "会话历史")
  }

  public func createSession(workspaceID: String?, agentPreset: String? = nil) async throws -> String {
    var payload: [String: JSONValue] = [:]
    if let workspaceID { payload["workspaceId"] = .string(workspaceID) }
    if let agentPreset { payload["agentPreset"] = .string(agentPreset) }
    let value = try await remoteDomainRequest(method: "session/create", request: payload)
    guard let sessionID = value["sessionId"]?.stringValue else {
      throw ArkAPIError(message: "本机服务没有返回会话标识")
    }
    return sessionID
  }

  public func modelLabel(sessionID: String) async throws -> String {
    let value = try await remoteDomainRequest(
      method: "session/models",
      request: ["sessionId": .string(sessionID)]
    )
    guard let current = value["current"],
          current["provider"]?.stringValue != nil,
          let model = current["model"]?.stringValue
    else { return "未配置模型" }
    // 展示标签不含 provider 前缀；provider identity 仍由路由与持久化选择持有。
    let effort = current["reasoningEffort"]?.stringValue
    return [model, effort].compactMap { $0 }.joined(separator: " · ")
  }

  /// Decode exactly one Typert Gateway `RemoteResult` layer. A successful
  /// business value may itself contain an `ok` field and must remain intact
  /// for its domain decoder (for example a Wiki compare-and-swap conflict).
  public static func remoteValue(from result: JSONValue) throws -> JSONValue {
    guard let succeeded = result["ok"]?.boolValue else {
      throw ArkAPIError(message: "本机能力返回了无效响应")
    }
    if succeeded {
      guard let value = result["value"] else {
        throw ArkAPIError(message: "本机能力返回了无效响应")
      }
      return value
    }
    let error = result["error"]
    throw ArkAPIError(
      message: error?.stringValue
        ?? error?["message"]?.stringValue
        ?? error?["code"]?.stringValue
        ?? "本机能力拒绝了请求",
      code: error?["code"]?.stringValue,
      details: error?["details"]
    )
  }

  /// Call one Typert Remote method and unwrap exactly its Gateway result.
  public func remoteCall(method: String, args: [String: JSONValue] = [:]) async throws -> JSONValue {
    let result = try await call(
      method: method,
      payload: .object(["args": .object(args)])
    )
    let value = try Self.remoteValue(from: result)
    if method == "subagent/history" {
      _ = try Self.validatedHistoryPage(from: value, context: "子代理历史")
    }
    return value
  }

  /// Call one strict Remote whose first named argument is a request object.
  public func remoteRequest(
    method: String,
    request: [String: JSONValue]
  ) async throws -> JSONValue {
    try await remoteCall(method: method, args: ["request": .object(request)])
  }

  /// Unwrap one domain-owned business result nested inside the Typert result.
  public func remoteDomainCall(
    method: String,
    args: [String: JSONValue] = [:]
  ) async throws -> JSONValue {
    let result = try await remoteCall(method: method, args: args)
    if result["ok"]?.boolValue == true, let value = result["value"] { return value }
    if result["ok"]?.boolValue == false {
      let error = result["error"]
      throw ArkAPIError(
        message: error?["message"]?.stringValue
          ?? error?["code"]?.stringValue
          ?? "本机领域能力拒绝了请求",
        code: error?["code"]?.stringValue,
        details: error?["details"]
      )
    }
    throw ArkAPIError(message: "本机领域能力返回了无效响应")
  }

  /// Call one domain Remote whose first named argument is a request object.
  public func remoteDomainRequest(
    method: String,
    request: [String: JSONValue]
  ) async throws -> JSONValue {
    try await remoteDomainCall(method: method, args: ["request": .object(request)])
  }

  public static func messages(from events: [ArkHistoryEvent]) -> [ArkMessage] {
    ArkMessageProjection(events: events).messages
  }

  public static func event(fromWire value: JSONValue, view: JSONValue? = nil) -> ArkHistoryEvent? {
    var wrapper: [String: JSONValue] = ["event": value]
    if let view { wrapper["view"] = view }
    return historyEvent(from: .object(wrapper))
  }

  /// Decode one complete history page without dropping, reordering, or
  /// coercing malformed rows. The first event sequence is the exclusive cursor
  /// for the next older request whenever `hasMore` is true.
  static func validatedHistoryPage(
    from value: JSONValue,
    context: String
  ) throws -> ArkHistoryPage {
    guard let rows = value["events"]?.arrayValue,
          let hasMore = value["hasMore"]?.boolValue
    else { throw ArkAPIError(message: "\(context)响应缺少分页字段") }
    var events: [ArkHistoryEvent] = []
    events.reserveCapacity(rows.count)
    var previousSequence: Int?
    for (index, row) in rows.enumerated() {
      guard let event = historyEvent(from: row) else {
        throw ArkAPIError(message: "\(context)第 \(index + 1) 条事件无效")
      }
      if let previousSequence {
        guard event.id == previousSequence + 1 else {
          throw ArkAPIError(
            message: "\(context)事件序号不连续（应为 \(previousSequence + 1)，实际为 \(event.id)）"
          )
        }
      }
      previousSequence = event.id
      events.append(event)
    }
    if hasMore && events.isEmpty {
      throw ArkAPIError(message: "\(context)返回了无法推进的空分页")
    }
    if !hasMore, let first = events.first?.id, first != 0 {
      throw ArkAPIError(message: "\(context)缺少起始事件 0")
    }
    var projections: [String: JSONValue] = [:]
    if let projectionValue = value["projections"] {
      guard safeJSONInteger(projectionValue["asOfSeq"], minimum: -1) != nil,
            let values = projectionValue["values"]?.objectValue
      else { throw ArkAPIError(message: "\(context)投影基线无效") }
      projections = values
    }
    return ArkHistoryPage(
      events: events,
      hasMore: hasMore,
      beforeSequence: events.first?.id,
      projections: projections
    )
  }

  private static func workspace(from value: JSONValue) -> ArkWorkspace? {
    guard let id = value["workspaceId"]?.stringValue,
          let path = value["path"]?.stringValue,
          let title = value["title"]?.stringValue
    else { return nil }
    let sessionIDs = value["sessionIds"]?.arrayValue?.compactMap(\.stringValue) ?? []
    return ArkWorkspace(id: id, path: path, title: title, sessionIDs: sessionIDs)
  }

  private static func session(from value: JSONValue) -> ArkSessionSummary? {
    guard let id = value["sessionId"]?.stringValue,
          let updatedAt = value["updatedAt"]?.numberValue,
          let running = value["running"]?.boolValue,
          let blank = value["blank"]?.boolValue
    else { return nil }
    let cwd = value["cwd"]?.stringValue
    let projectedTitle = value["projections"]?["values"]?["title"]?.stringValue
    let fallback = cwd.map { URL(fileURLWithPath: $0).lastPathComponent }.flatMap { $0.isEmpty ? nil : $0 }
    return ArkSessionSummary(
      id: id,
      title: projectedTitle ?? fallback ?? "未命名会话",
      updatedAt: Date(timeIntervalSince1970: updatedAt / 1000),
      running: running,
      blank: blank,
      cwd: cwd,
      agentPreset: value["agentPreset"]?.stringValue,
      permissionPreset: value["projections"]?["values"]?["permissions"]?["currentValue"]?.stringValue,
      parentSessionID: value["parentSessionId"]?.stringValue,
      origin: value["origin"]?.stringValue
    )
  }

  static func historyEvent(from value: JSONValue) -> ArkHistoryEvent? {
    guard let event = value["event"],
          let seq = safeJSONInteger(event["seq"]),
          let type = event["type"]?.stringValue,
          !type.isEmpty,
          let time = event["time"]?.numberValue,
          time.isFinite,
          let data = event["data"]
    else { return nil }
    return ArkHistoryEvent(
      id: seq,
      type: type,
      time: Date(timeIntervalSince1970: time / 1000),
      data: data,
      view: value["view"]
    )
  }

  private static func safeJSONInteger(_ value: JSONValue?, minimum: Int = 0) -> Int? {
    guard let number = value?.numberValue,
          number.isFinite,
          number.rounded(.towardZero) == number,
          abs(number) <= 9_007_199_254_740_991,
          number >= Double(minimum),
          number >= Double(Int.min),
          number <= Double(Int.max)
    else { return nil }
    return Int(number)
  }

  fileprivate static func textContent(in value: JSONValue) -> String? {
    if let text = value["text"]?.stringValue { return text }
    if let content = value["content"]?.arrayValue {
      let text = content.compactMap { block -> String? in
        guard block["type"]?.stringValue == "text" else { return nil }
        return block["text"]?.stringValue
      }.joined(separator: "\n")
      if !text.isEmpty { return text }
    }
    if let message = value["message"] { return textContent(in: message) }
    return nil
  }

  fileprivate static func reasoningContent(in value: JSONValue) -> String? {
    if let content = value["content"]?.arrayValue {
      let text = content.compactMap { block -> String? in
        guard block["type"]?.stringValue == "reasoning" else { return nil }
        return block["text"]?.stringValue
      }.joined(separator: "\n")
      if !text.isEmpty { return text }
    }
    if let message = value["message"] { return reasoningContent(in: message) }
    return nil
  }

  fileprivate static func imageAttachmentIDs(in value: JSONValue) -> [String] {
    if let content = value["content"]?.arrayValue {
      var ids: [String] = []
      for block in content {
        if block["type"]?.stringValue == "image",
           let id = block["attachment"]?["attachmentId"]?.stringValue {
          ids.append(id)
        } else {
          ids.append(contentsOf: imageAttachmentIDs(in: block))
        }
      }
      if !ids.isEmpty { return ids }
    }
    if let message = value["message"] { return imageAttachmentIDs(in: message) }
    return []
  }

  fileprivate static func messageBlocks(in value: JSONValue) -> [ArkMessageBlock] {
    guard let content = value["content"]?.arrayValue else {
      if let message = value["message"] { return messageBlocks(in: message) }
      return []
    }
    return content.compactMap { block in
      let type = block["type"]?.stringValue ?? "unknown"
      switch type {
      case "text":
        return block["text"]?.stringValue.map(ArkMessageBlock.text)
      case "reasoning":
        return block["text"]?.stringValue.map(ArkMessageBlock.reasoning)
      case "image":
        return block["attachment"]?["attachmentId"]?.stringValue.map(ArkMessageBlock.image)
      case "tool-call":
        return nil
      default:
        return .unknown(type: type, value: block)
      }
    }
  }
}
