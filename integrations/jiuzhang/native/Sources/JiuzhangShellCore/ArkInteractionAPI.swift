import Foundation

/// Delivery policy for one native prompt submission.
public enum ArkPromptDeliveryMode: String, Equatable, Sendable {
  case queue
  case steer
}

/// Raster media types accepted by the Host prompt protocol.
public enum ArkImageMediaType: String, Equatable, Sendable {
  case png = "image/png"
  case jpeg = "image/jpeg"
  case webp = "image/webp"
  case gif = "image/gif"
}

/// One browser-free image submission carried inline by `session.prompt`.
public struct ArkPromptImage: Equatable, Sendable {
  public let mediaType: ArkImageMediaType
  public let data: Data
  public let name: String?

  public init(mediaType: ArkImageMediaType, data: Data, name: String? = nil) {
    self.mediaType = mediaType
    self.data = data
    self.name = name
  }
}

/// One durable image loaded through the session-authorized attachment endpoint.
public struct ArkSessionImage: Equatable, Sendable {
  public let attachmentID: String
  public let mediaType: ArkImageMediaType
  public let bytes: Int
  public let width: Int
  public let height: Int
  public let name: String?
  public let data: Data

  public init(
    attachmentID: String,
    mediaType: ArkImageMediaType,
    bytes: Int,
    width: Int,
    height: Int,
    name: String? = nil,
    data: Data
  ) {
    self.attachmentID = attachmentID
    self.mediaType = mediaType
    self.bytes = bytes
    self.width = width
    self.height = height
    self.name = name
    self.data = data
  }
}

/// One approval request that can be answered only with its original event correlation id.
public struct ArkApprovalRequest: Identifiable, Equatable, Sendable {
  public let rpcID: String
  public let sessionID: String
  public let approvalID: String
  public let toolName: String
  public let callID: String?
  public let reason: String?

  public var id: String { rpcID }

  public init(
    rpcID: String,
    sessionID: String,
    approvalID: String,
    toolName: String,
    callID: String? = nil,
    reason: String? = nil
  ) {
    self.rpcID = rpcID
    self.sessionID = sessionID
    self.approvalID = approvalID
    self.toolName = toolName
    self.callID = callID
    self.reason = reason
  }
}

/// The two decisions a client may return for a pending approval.
public enum ArkApprovalDecision: String, Equatable, Sendable {
  case allowOnce = "allowed-once"
  case reject = "rejected"
}

/// One selectable answer advertised by a Host question.
public struct ArkQuestionOption: Equatable, Sendable {
  public let label: String
  public let description: String?

  public init(label: String, description: String? = nil) {
    self.label = label
    self.description = description
  }
}

/// Presentation intent attached to a Host question without changing its answer protocol.
public enum ArkQuestionIntent: Equatable, Sendable {
  case planReview(approveLabel: String)
}

/// A single binary plan decision projected from a typed Host question request.
///
/// This changes presentation only. Every action still answers with the exact
/// option labels supplied by the Host question protocol.
public struct ArkPlanReview: Equatable, Sendable {
  public let questionID: String
  public let question: String
  public let plan: String
  public let approve: ArkQuestionOption
  public let decline: ArkQuestionOption?

  public init(
    questionID: String,
    question: String,
    plan: String,
    approve: ArkQuestionOption,
    decline: ArkQuestionOption? = nil
  ) {
    self.questionID = questionID
    self.question = question
    self.plan = plan
    self.approve = approve
    self.decline = decline
  }
}

/// One question inside an atomic Host question batch.
public struct ArkQuestion: Identifiable, Equatable, Sendable {
  public let id: String
  public let question: String
  public let detail: String?
  public let header: String?
  public let options: [ArkQuestionOption]
  public let multiSelect: Bool
  public let intent: ArkQuestionIntent?

  public init(
    id: String,
    question: String,
    detail: String? = nil,
    header: String? = nil,
    options: [ArkQuestionOption] = [],
    multiSelect: Bool = false,
    intent: ArkQuestionIntent? = nil
  ) {
    self.id = id
    self.question = question
    self.detail = detail
    self.header = header
    self.options = options
    self.multiSelect = multiSelect
    self.intent = intent
  }
}

/// One answer in the ordered batch returned for a Host question request.
public struct ArkQuestionAnswer: Equatable, Sendable {
  public let id: String
  public let selected: [String]
  public let custom: String?

  public init(id: String, selected: [String] = [], custom: String? = nil) {
    self.id = id
    self.selected = selected
    self.custom = custom
  }
}

/// One answerable question batch correlated to its original server request.
public struct ArkQuestionRequest: Identifiable, Equatable, Sendable {
  public let rpcID: String
  public let sessionID: String
  public let questions: [ArkQuestion]

  public var id: String { rpcID }

  public init(rpcID: String, sessionID: String, questions: [ArkQuestion]) {
    self.rpcID = rpcID
    self.sessionID = sessionID
    self.questions = questions
  }
}

/// One still-pending queue occurrence projected from a `session/queue` event.
public struct ArkQueuedPrompt: Identifiable, Equatable, Sendable {
  public enum Placement: String, Equatable, Sendable {
    case queued
    case steering
    case context
  }

  public let id: String
  public let placement: Placement
  public let text: String?
  public let hasNonTextContent: Bool

  public init(id: String, placement: Placement, text: String?, hasNonTextContent: Bool) {
    self.id = id
    self.placement = placement
    self.text = text
    self.hasNonTextContent = hasNonTextContent
  }
}

/// Complete transient queue state for one session.
public struct ArkQueueSnapshot: Equatable, Sendable {
  public let sessionID: String
  public let items: [ArkQueuedPrompt]

  public init(sessionID: String, items: [ArkQueuedPrompt]) {
    self.sessionID = sessionID
    self.items = items
  }
}

/// Safe native mutations supported for one pending queue occurrence.
public enum ArkQueueMutation: Equatable, Sendable {
  case editText(String)
  case remove
  case steer
}

/// Result of atomically placing one downloaded session archive at its destination.
public struct ArkSessionExport: Equatable, Sendable {
  public let fileURL: URL
  public let bytes: UInt64

  public init(fileURL: URL, bytes: UInt64) {
    self.fileURL = fileURL
    self.bytes = bytes
  }
}

/// Pure wire builders and decoders for native interaction surfaces.
public enum ArkInteractionAPIContract {
  public enum Method {
    public static let prompt = "session/prompt"
    public static let attachment = "session/attachment"
    public static let updateQueue = "session/updateQueue"
  }

  public static func respondURL(baseURL: URL) -> URL {
    baseURL.appendingPathComponent("api/respond")
  }

  public static func sessionExportURL(
    baseURL: URL,
    sessionID: String,
    includeDescendants: Bool
  ) throws -> URL {
    let endpoint = baseURL.appendingPathComponent("api/session/export")
    guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else {
      throw ArkAPIError(message: "无法构造会话导出地址")
    }
    components.queryItems = [
      URLQueryItem(name: "sessionId", value: sessionID),
      URLQueryItem(name: "includeDescendants", value: includeDescendants ? "true" : "false"),
    ]
    guard let url = components.url else {
      throw ArkAPIError(message: "无法构造会话导出地址")
    }
    return url
  }

  public static func sessionExportFilename(sessionID: String) -> String {
    let safe = sessionID.map { character -> Character in
      character.isASCII && (character.isLetter || character.isNumber || character == "_" || character == "-")
        ? character
        : "_"
    }
    return "dsh-session-\(String(safe)).zip"
  }

  public static func approvalRequest(from frame: ArkEventFrame) -> ArkApprovalRequest? {
    guard frame.channel == .mux,
          frame.method == "approval/requested",
          let sessionID = frame.payload["sessionId"]?.stringValue,
          !sessionID.isEmpty,
          let approvalID = frame.payload["approvalId"]?.stringValue,
          !approvalID.isEmpty,
          let toolName = frame.payload["toolName"]?.stringValue
    else { return nil }
    return ArkApprovalRequest(
      rpcID: frame.rpcID,
      sessionID: sessionID,
      approvalID: approvalID,
      toolName: toolName,
      callID: frame.payload["callId"]?.stringValue,
      reason: frame.payload["reason"]?.stringValue
    )
  }

  public static func questionRequest(from frame: ArkEventFrame) -> ArkQuestionRequest? {
    guard frame.channel == .mux,
          frame.method == "question/requested",
          let sessionID = frame.payload["sessionId"]?.stringValue,
          !sessionID.isEmpty,
          let values = frame.payload["questions"]?.arrayValue,
          !values.isEmpty
    else { return nil }
    let questions = values.compactMap(question(from:))
    guard questions.count == values.count else { return nil }
    return ArkQuestionRequest(rpcID: frame.rpcID, sessionID: sessionID, questions: questions)
  }

  /// Narrow one request to the dedicated plan-review presentation.
  ///
  /// Any request the binary decision card cannot answer completely remains on
  /// the generic question flow: batches, multi-select questions, or questions
  /// with more than one non-approval option.
  public static func planReview(from request: ArkQuestionRequest) -> ArkPlanReview? {
    guard request.questions.count == 1, let question = request.questions.first else { return nil }
    guard let intent = question.intent, let plan = question.detail, !question.multiSelect else {
      return nil
    }
    let approveLabel: String
    switch intent {
    case .planReview(let label): approveLabel = label
    }
    guard question.options.count <= 2,
          let approve = question.options.first(where: { $0.label == approveLabel })
    else { return nil }
    return ArkPlanReview(
      questionID: question.id,
      question: question.question,
      plan: plan,
      approve: approve,
      decline: question.options.first(where: { $0.label != approveLabel })
    )
  }

  public static func queueSnapshot(from frame: ArkEventFrame) -> ArkQueueSnapshot? {
    guard frame.channel == .mux,
          frame.method == "session/queue",
          let sessionID = frame.payload["sessionId"]?.stringValue,
          !sessionID.isEmpty,
          let values = frame.payload["items"]?.arrayValue
    else { return nil }
    let items = values.compactMap(queuedPrompt(from:))
    guard items.count == values.count else { return nil }
    return ArkQueueSnapshot(sessionID: sessionID, items: items)
  }

  public static func promptPayload(
    sessionID: String,
    invocationID: String,
    text: String,
    images: [ArkPromptImage],
    mode: ArkPromptDeliveryMode,
    timeZone: String
  ) throws -> JSONValue {
    var content: [JSONValue] = try images.map { image in
      guard !image.data.isEmpty else { throw ArkAPIError(message: "不能发送空图片") }
      var value: [String: JSONValue] = [
        "type": .string("image"),
        "mediaType": .string(image.mediaType.rawValue),
        "data": .string(image.data.base64EncodedString()),
      ]
      if let name = image.name, !name.isEmpty { value["name"] = .string(name) }
      return .object(value)
    }
    if !text.isEmpty {
      content.append(.object(["type": .string("text"), "text": .string(text)]))
    }
    guard !content.isEmpty else { throw ArkAPIError(message: "消息内容不能为空") }
    return .object([
      "sessionId": .string(sessionID),
      "invocationId": .string(invocationID),
      "mode": .string(mode.rawValue),
      "content": .array(content),
      "clientTimeZone": .string(timeZone),
    ])
  }

  public static func queueMutationPayload(
    sessionID: String,
    itemID: String,
    mutation: ArkQueueMutation
  ) -> JSONValue {
    let action: JSONValue
    switch mutation {
    case .editText(let text):
      action = .object([
        "kind": .string("edit"),
        "content": .array([.object(["type": .string("text"), "text": .string(text)])]),
      ])
    case .remove:
      action = .object(["kind": .string("remove")])
    case .steer:
      action = .object(["kind": .string("steer")])
    }
    return .object([
      "sessionId": .string(sessionID),
      "itemId": .string(itemID),
      "action": action,
    ])
  }

  public static func approvalResponseBody(
    request: ArkApprovalRequest,
    decision: ArkApprovalDecision
  ) -> JSONValue {
    .object([
      "type": .string("client-response"),
      "rpcId": .string(request.rpcID),
      "result": .object([
        "ok": .bool(true),
        "value": .object([
          "sessionId": .string(request.sessionID),
          "approvalId": .string(request.approvalID),
          "outcome": .string(decision.rawValue),
        ]),
      ]),
    ])
  }

  public static func questionResponseBody(
    request: ArkQuestionRequest,
    answers: [ArkQuestionAnswer]
  ) throws -> JSONValue {
    try validate(answers: answers, for: request.questions)
    return .object([
      "type": .string("client-response"),
      "rpcId": .string(request.rpcID),
      "result": .object([
        "ok": .bool(true),
        "value": .object([
          "sessionId": .string(request.sessionID),
          "answer": .object([
            "answers": .array(answers.map { answer in
              var value: [String: JSONValue] = [
                "id": .string(answer.id),
                "selected": .array(answer.selected.map(JSONValue.string)),
              ]
              if let custom = answer.custom { value["custom"] = .string(custom) }
              return .object(value)
            }),
          ]),
        ]),
      ]),
    ])
  }

  public static func questionCancellationBody(request: ArkQuestionRequest) -> JSONValue {
    .object([
      "type": .string("client-response"),
      "rpcId": .string(request.rpcID),
      "result": .object([
        "ok": .bool(false),
        "error": .object([
          "code": .string("cancelled"),
          "message": .string("the user closed this question request"),
          "details": .object([:]),
        ]),
      ]),
    ])
  }

  public static func sessionImage(from value: JSONValue) throws -> ArkSessionImage {
    guard let attachmentID = value["attachment"]?["attachmentId"]?.stringValue,
          !attachmentID.isEmpty,
          let rawMediaType = value["attachment"]?["mediaType"]?.stringValue,
          let mediaType = ArkImageMediaType(rawValue: rawMediaType),
          let bytes = positiveInteger(value["attachment"]?["bytes"]),
          let width = positiveInteger(value["attachment"]?["width"]),
          let height = positiveInteger(value["attachment"]?["height"]),
          let encoded = value["data"]?.stringValue,
          let data = Data(base64Encoded: encoded),
          data.count == bytes
    else { throw ArkAPIError(message: "本机服务返回了无效的附件响应") }
    return ArkSessionImage(
      attachmentID: attachmentID,
      mediaType: mediaType,
      bytes: bytes,
      width: width,
      height: height,
      name: value["attachment"]?["name"]?.stringValue,
      data: data
    )
  }

  private static func question(from value: JSONValue) -> ArkQuestion? {
    guard let id = value["id"]?.stringValue,
          let prompt = value["question"]?.stringValue
    else { return nil }
    let optionValues = value["options"]?.arrayValue ?? []
    let options = optionValues.compactMap { option -> ArkQuestionOption? in
      guard let label = option["label"]?.stringValue else { return nil }
      return ArkQuestionOption(label: label, description: option["description"]?.stringValue)
    }
    guard options.count == optionValues.count else { return nil }
    let intent: ArkQuestionIntent?
    if let rawIntent = value["intent"] {
      guard rawIntent["kind"]?.stringValue == "plan-review",
            let approve = rawIntent["approve"]?.stringValue
      else { return nil }
      intent = .planReview(approveLabel: approve)
    } else {
      intent = nil
    }
    return ArkQuestion(
      id: id,
      question: prompt,
      detail: value["detail"]?.stringValue,
      header: value["header"]?.stringValue,
      options: options,
      multiSelect: value["multiSelect"]?.boolValue ?? false,
      intent: intent
    )
  }

  private static func queuedPrompt(from value: JSONValue) -> ArkQueuedPrompt? {
    guard let id = value["id"]?.stringValue,
          !id.isEmpty,
          let rawPlacement = value["placement"]?.stringValue,
          let placement = ArkQueuedPrompt.Placement(rawValue: rawPlacement),
          let blocks = value["message"]?["content"]?.arrayValue
    else { return nil }
    let texts = blocks.compactMap { block -> String? in
      guard block["type"]?.stringValue == "text" else { return nil }
      return block["text"]?.stringValue
    }
    return ArkQueuedPrompt(
      id: id,
      placement: placement,
      text: texts.isEmpty ? nil : texts.joined(separator: "\n"),
      hasNonTextContent: blocks.contains { $0["type"]?.stringValue != "text" }
    )
  }

  private static func validate(
    answers: [ArkQuestionAnswer],
    for questions: [ArkQuestion]
  ) throws {
    guard answers.count == questions.count else {
      throw ArkAPIError(message: "问题答案数量与请求不一致")
    }
    for (answer, question) in zip(answers, questions) {
      guard answer.id == question.id else {
        throw ArkAPIError(message: "问题答案顺序与请求不一致")
      }
      guard Set(answer.selected).count == answer.selected.count else {
        throw ArkAPIError(message: "同一选项不能重复选择")
      }
      let labels = Set(question.options.map(\.label))
      guard answer.selected.allSatisfy(labels.contains) else {
        throw ArkAPIError(message: "答案包含未提供的选项")
      }
      if let custom = answer.custom,
         custom.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      {
        throw ArkAPIError(message: "自定义答案不能为空")
      }
      if !question.multiSelect {
        guard answer.selected.count <= 1 else {
          throw ArkAPIError(message: "单选问题只能选择一个选项")
        }
        guard answer.custom == nil || answer.selected.isEmpty else {
          throw ArkAPIError(message: "单选问题不能同时选择选项和填写自定义答案")
        }
      }
    }
  }

  private static func positiveInteger(_ value: JSONValue?) -> Int? {
    guard let number = value?.numberValue,
          number.isFinite,
          number > 0,
          number.rounded(.towardZero) == number,
          number < Double(Int.max)
    else { return nil }
    return Int(number)
  }
}

/// Authenticated native client for user-paced Host interactions and binary transfers.
public actor ArkInteractionAPI {
  private let baseURL: URL
  private let apiToken: String
  private let session: URLSession
  private let rpc: ArkAPIClient

  public init(baseURL: URL, apiToken: String, session: URLSession = .shared) {
    self.baseURL = baseURL
    self.apiToken = apiToken
    self.session = session
    rpc = ArkAPIClient(baseURL: baseURL, apiToken: apiToken, session: session)
  }

  /// IANA-safe client zone: Foundation names the `TZ=UTC` fallback zone
  /// "GMT" — neither an IANA Area/Location nor the contract's literal "UTC",
  /// so the backend rejects it. That zone IS UTC; report it under the
  /// contract-legal name and pass every other identifier through unchanged.
  static func launchTimeZoneIdentifier() -> String {
    let identifier = TimeZone.current.identifier
    return identifier == "GMT" ? "UTC" : identifier
  }

  /// Send text and inline image bytes through the Host's single prompt admission.
  public func sendPrompt(
    sessionID: String,
    text: String,
    images: [ArkPromptImage] = [],
    mode: ArkPromptDeliveryMode = .queue
  ) async throws {
    let invocationID = UUID().uuidString.lowercased()
    let payload = try ArkInteractionAPIContract.promptPayload(
      sessionID: sessionID,
      invocationID: invocationID,
      text: text,
      images: images,
      mode: mode,
      timeZone: Self.launchTimeZoneIdentifier()
    )
    guard let request = payload.objectValue else { throw ArkAPIError(message: "消息请求无效") }

    let value = try await rpc.remoteDomainRequest(
      method: ArkInteractionAPIContract.Method.prompt,
      request: request
    )
    guard value["accepted"]?.boolValue == true else {
      throw ArkAPIError(message: "本机服务没有确认消息提交")
    }
  }

  /// Apply one safe edit, remove, or strict-steer operation to a pending queue item.
  public func updateQueue(
    sessionID: String,
    itemID: String,
    mutation: ArkQueueMutation
  ) async throws {
    let payload = ArkInteractionAPIContract.queueMutationPayload(
      sessionID: sessionID,
      itemID: itemID,
      mutation: mutation
    )
    guard let request = payload.objectValue else { throw ArkAPIError(message: "队列请求无效") }
    let value = try await rpc.remoteDomainRequest(
      method: ArkInteractionAPIContract.Method.updateQueue,
      request: request
    )
    guard value["accepted"]?.boolValue == true else {
      throw ArkAPIError(message: "本机服务没有确认队列操作")
    }
  }

  /// Resolve an image only when the owning session's durable log authorizes its id.
  public func readImage(sessionID: String, attachmentID: String) async throws -> ArkSessionImage {
    let value = try await rpc.remoteDomainRequest(
      method: ArkInteractionAPIContract.Method.attachment,
      request: [
        "sessionId": .string(sessionID),
        "attachmentId": .string(attachmentID),
      ]
    )
    return try ArkInteractionAPIContract.sessionImage(from: value)
  }

  /// Answer one pending approval by echoing its original server-request correlation.
  public func answerApproval(
    _ request: ArkApprovalRequest,
    decision: ArkApprovalDecision
  ) async throws {
    try await respond(body: ArkInteractionAPIContract.approvalResponseBody(
      request: request,
      decision: decision
    ))
  }

  /// Answer a complete Host question batch in its original order.
  public func answerQuestions(
    _ request: ArkQuestionRequest,
    answers: [ArkQuestionAnswer]
  ) async throws {
    try await respond(body: ArkInteractionAPIContract.questionResponseBody(
      request: request,
      answers: answers
    ))
  }

  /// Cancel one pending Host question batch through its only admitted error branch.
  public func cancelQuestions(_ request: ArkQuestionRequest) async throws {
    try await respond(body: ArkInteractionAPIContract.questionCancellationBody(request: request))
  }

  /// Download a session ZIP and atomically place it at a caller-selected file URL.
  public func exportSession(
    sessionID: String,
    includeDescendants: Bool = true,
    to destinationURL: URL
  ) async throws -> ArkSessionExport {
    guard destinationURL.isFileURL else {
      throw ArkAPIError(message: "会话导出目标必须是本地文件")
    }
    let destination = destinationURL.standardizedFileURL
    let fileManager = FileManager.default
    let destinationExists = fileManager.fileExists(atPath: destination.path)
    let parent = destination.deletingLastPathComponent()
    var isDirectory: ObjCBool = false
    guard fileManager.fileExists(atPath: parent.path, isDirectory: &isDirectory), isDirectory.boolValue else {
      throw ArkAPIError(message: "会话导出目录不存在")
    }

    let url = try ArkInteractionAPIContract.sessionExportURL(
      baseURL: baseURL,
      sessionID: sessionID,
      includeDescendants: includeDescendants
    )
    var preflight = URLRequest(url: url)
    preflight.httpMethod = "HEAD"
    preflight.setValue("Bearer \(apiToken)", forHTTPHeaderField: "Authorization")
    let (_, preflightResponse) = try await session.data(for: preflight)
    guard let preflightHTTP = preflightResponse as? HTTPURLResponse,
          (200..<300).contains(preflightHTTP.statusCode)
    else {
      let status = (preflightResponse as? HTTPURLResponse)?.statusCode ?? -1
      throw ArkAPIError(message: "会话导出预检查失败（HTTP \(status)）")
    }
    guard preflightHTTP.value(forHTTPHeaderField: "Content-Type")?
      .lowercased().hasPrefix("application/zip") == true
    else {
      throw ArkAPIError(message: "本机服务没有提供有效的会话导出文件")
    }

    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.setValue("Bearer \(apiToken)", forHTTPHeaderField: "Authorization")
    let (temporaryURL, response) = try await session.download(for: request)
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let status = (response as? HTTPURLResponse)?.statusCode ?? -1
      throw ArkAPIError(message: "会话导出失败（HTTP \(status)）")
    }
    guard http.value(forHTTPHeaderField: "Content-Type")?.lowercased().hasPrefix("application/zip") == true else {
      throw ArkAPIError(message: "本机服务返回了无效的会话导出文件")
    }

    let staged = parent.appendingPathComponent(
      ".\(destination.lastPathComponent).ark-download-\(UUID().uuidString.lowercased())"
    )
    defer { try? fileManager.removeItem(at: staged) }
    try fileManager.copyItem(at: temporaryURL, to: staged)
    if destinationExists {
      _ = try fileManager.replaceItemAt(
        destination,
        withItemAt: staged,
        backupItemName: nil,
        options: .usingNewMetadataOnly
      )
    } else {
      try fileManager.moveItem(at: staged, to: destination)
    }
    let attributes = try fileManager.attributesOfItem(atPath: destination.path)
    let bytes = (attributes[.size] as? NSNumber)?.uint64Value ?? 0
    return ArkSessionExport(fileURL: destination, bytes: bytes)
  }

  private func respond(body: JSONValue) async throws {
    var request = URLRequest(url: ArkInteractionAPIContract.respondURL(baseURL: baseURL))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(apiToken)", forHTTPHeaderField: "Authorization")
    request.httpBody = try JSONEncoder().encode(body)
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let status = (response as? HTTPURLResponse)?.statusCode ?? -1
      throw ArkAPIError(message: "交互响应提交失败（HTTP \(status)）")
    }
    let receipt = try JSONDecoder().decode(JSONValue.self, from: data)
    guard let accepted = receipt["accepted"]?.boolValue else {
      throw ArkAPIError(message: "本机服务返回了无效的交互响应回执")
    }
    guard accepted else {
      let reason = receipt["reason"]?.stringValue ?? "unknown"
      throw ArkAPIError(message: "交互响应未被接受（\(reason)）")
    }
  }
}
