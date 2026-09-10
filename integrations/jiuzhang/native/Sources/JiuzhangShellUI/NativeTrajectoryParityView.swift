import AppKit
import Combine
import JiuzhangShellCore
import SwiftUI

/// Fixed geometry inherited from the legacy Trajectory surface.
public enum ArkTrajectoryMetrics {
  public static let toolbarHeight: CGFloat = 32
  public static let overviewHeight: CGFloat = 50
  public static let tableHeaderHeight: CGFloat = 30
  public static let tableRowHeight: CGFloat = 30
  public static let eventColumnWidth: CGFloat = 122
  public static let inspectorMinimumWidth: CGFloat = 300
  public static let inspectorMaximumWidth: CGFloat = 520
}

/// The semantic row kinds rendered by Trajectory. Token-level stream events
/// deliberately do not become rows.
public enum ArkTrajectorySemanticKind: String, CaseIterable, Identifiable, Sendable {
  case system
  case user
  case context
  case message
  case tool
  case subtool
  case compacted

  public var id: String { rawValue }

  public func label(_ language: ArkLanguagePreference) -> String {
    switch self {
    case .system: return ArkL10n.text(.trajectoryKindSystem, language)
    case .user: return ArkL10n.text(.trajectoryKindUser, language)
    case .context: return ArkL10n.text(.trajectoryKindContext, language)
    case .message: return ArkL10n.text(.trajectoryKindAssistant, language)
    case .tool: return ArkL10n.text(.trajectoryKindTool, language)
    case .subtool: return ArkL10n.text(.trajectoryKindSubtool, language)
    case .compacted: return ArkL10n.text(.trajectoryKindCompacted, language)
    }
  }

  public var label: String { label(.en) }

  fileprivate var lane: Int {
    switch self {
    case .system, .user, .context: return 0
    case .message, .compacted: return 1
    case .tool, .subtool: return 2
    }
  }
}

public struct ArkTrajectoryUsage: Equatable, Sendable {
  public let input: Int?
  public let cacheRead: Int?
  public let cacheWrite: Int?
  public let output: Int?
  public let reasoning: Int?

  public init(
    input: Int? = nil,
    cacheRead: Int? = nil,
    cacheWrite: Int? = nil,
    output: Int? = nil,
    reasoning: Int? = nil
  ) {
    self.input = input
    self.cacheRead = cacheRead
    self.cacheWrite = cacheWrite
    self.output = output
    self.reasoning = reasoning
  }

  public var isEmpty: Bool {
    input == nil && cacheRead == nil && cacheWrite == nil && output == nil && reasoning == nil
  }

  public func summary(_ language: ArkLanguagePreference) -> String {
    [
      input.map { "\(ArkL10n.text(.fieldInput, language)) \($0)" },
      cacheRead.map { "\(ArkL10n.text(.fieldCached, language)) \($0)" },
      cacheWrite.map { "\(ArkL10n.text(.fieldCacheCreated, language)) \($0)" },
      output.map { "\(ArkL10n.text(.fieldOutput, language)) \($0)" },
      reasoning.map { "\(ArkL10n.text(.fieldReasoning, language)) \($0)" },
    ]
    .compactMap { $0 }
    .joined(separator: " · ")
  }

  public var summary: String { summary(.en) }
}

public struct ArkTrajectoryRetry: Equatable, Sendable {
  public let attempt: Int?
  public let maximum: Int?
  public let delayMs: Double?
  public let failure: String?

  public init(
    attempt: Int? = nil,
    maximum: Int? = nil,
    delayMs: Double? = nil,
    failure: String? = nil
  ) {
    self.attempt = attempt
    self.maximum = maximum
    self.delayMs = delayMs
    self.failure = failure
  }

  public var isEmpty: Bool {
    attempt == nil && maximum == nil && delayMs == nil && failure == nil
  }

  public func summary(_ language: ArkLanguagePreference) -> String {
    let retry: String?
    if let attempt, let maximum {
      retry = "\(ArkL10n.text(.fieldRetry, language)) \(attempt)/\(maximum)"
    } else if let attempt {
      retry = "\(ArkL10n.text(.fieldRetry, language)) \(attempt)"
    } else if let maximum {
      retry = ArkL10n.format(.trajectoryMaxRetry, language, arguments: ["\(maximum)"])
    } else {
      retry = nil
    }
    return [
      retry,
      delayMs.map {
        ArkL10n.format(
          .trajectoryDelay,
          language,
          arguments: [ArkTrajectoryFormat.duration($0)]
        )
      },
      failure.map { ArkTrajectoryFormat.truncate($0, limit: 80) },
    ]
    .compactMap { $0 }
    .joined(separator: " · ")
  }

  public var summary: String { summary(.en) }
}

/// One legacy-equivalent, user-readable Trajectory row.
public struct ArkTrajectorySemanticRecord: Identifiable, Equatable, Sendable {
  public let id: String
  public let sequence: Int
  public let endSequence: Int
  public let eventType: String
  public let time: Date
  public let completedAt: Date?
  public let turn: Int?
  public let step: Int?
  public let kind: ArkTrajectorySemanticKind
  public let title: String
  public let preview: String
  public let input: String?
  public let output: String?
  public let provider: String?
  public let model: String?
  public let usage: ArkTrajectoryUsage?
  public let retry: ArkTrajectoryRetry?
  public let compaction: String?
  public let isError: Bool
  public let events: [ArkHistoryEvent]

  /// Durable image references carried by user, assistant, or tool-result
  /// content in this record. The raw event list remains authoritative; this
  /// derived view keeps the table projection lossless without copying image
  /// bytes into the trajectory model.
  public var attachmentIDs: [String] {
    var seen = Set<String>()
    var result: [String] = []
    for event in events {
      for attachmentID in ArkTrajectoryProjection.imageAttachmentIDs(in: event.data)
        where seen.insert(attachmentID).inserted
      {
        result.append(attachmentID)
      }
    }
    return result
  }

  public var durationMs: Double? {
    guard let completedAt else { return nil }
    return max(0, completedAt.timeIntervalSince(time) * 1_000)
  }

  public var groupKey: String {
    if kind == .compacted, turn == nil { return "between-turns:\(sequence)" }
    if let turn, let step, step > 0 { return "turn:\(turn):step:\(step)" }
    if let turn { return "turn:\(turn):message" }
    return "session"
  }

  public func groupTitle(_ language: ArkLanguagePreference) -> String {
    if kind == .compacted, turn == nil {
      return ArkL10n.text(.trajectoryBetweenTurns, language)
    }
    if let step, step > 0 {
      return ArkL10n.format(.trajectoryStep, language, arguments: ["\(step)"])
    }
    return ArkL10n.text(.trajectoryMessage, language)
  }

  public var groupTitle: String { groupTitle(.en) }

  public func location(_ language: ArkLanguagePreference) -> String {
    if kind == .compacted, turn == nil {
      return ArkL10n.text(.trajectoryBetweenTurns, language)
    }
    if let turn, let step, step > 0 {
      return ArkL10n.format(
        .trajectoryTurnStep,
        language,
        arguments: ["\(turn)", "\(step)"]
      )
    }
    if let turn {
      return ArkL10n.format(.trajectoryTurnMessage, language, arguments: ["\(turn)"])
    }
    return ArkL10n.text(.trajectorySession, language)
  }

  public var location: String { location(.en) }

  public func metadataSummary(_ language: ArkLanguagePreference) -> String {
    var values: [String] = []
    if let provider, let model { values.append("\(provider) / \(model)") }
    else if let provider { values.append(provider) }
    else if let model { values.append(model) }
    if let durationMs { values.append(ArkTrajectoryFormat.duration(durationMs)) }
    if let usage, !usage.isEmpty { values.append(usage.summary(language)) }
    if let retry, !retry.isEmpty { values.append(retry.summary(language)) }
    if let compaction { values.append(compaction) }
    return values.joined(separator: " · ")
  }

  public var metadataSummary: String { metadataSummary(.en) }

  public func searchText(_ language: ArkLanguagePreference) -> String {
    [
      kind.rawValue, kind.label(language), eventType, title, preview, input, output,
      provider, model, usage?.summary(language), retry?.summary(language), compaction,
      ArkTrajectoryProjection.detailJSON(for: self),
    ]
    .compactMap { $0 }
    .joined(separator: "\n")
    .lowercased()
  }

  public var searchText: String { searchText(.en) }
}

private struct ArkTrajectoryRequestMetadata {
  var provider: String?
  var model: String?
  var retry: ArkTrajectoryRetry?
  var headerEvent: ArkHistoryEvent?
  var contextEvent: ArkHistoryEvent?
}

private struct ArkTrajectoryRecordBuilder {
  var id: String
  var sequence: Int
  var endSequence: Int
  var eventType: String
  var time: Date
  var completedAt: Date?
  var turn: Int?
  var step: Int?
  var kind: ArkTrajectorySemanticKind
  var title: String
  var preview: String
  var input: String?
  var output: String?
  var provider: String?
  var model: String?
  var usage: ArkTrajectoryUsage?
  var retry: ArkTrajectoryRetry?
  var compaction: String?
  var isError = false
  var events: [ArkHistoryEvent]

  func build() -> ArkTrajectorySemanticRecord {
    ArkTrajectorySemanticRecord(
      id: id,
      sequence: sequence,
      endSequence: endSequence,
      eventType: eventType,
      time: time,
      completedAt: completedAt,
      turn: turn,
      step: step,
      kind: kind,
      title: title,
      preview: preview,
      input: input,
      output: output,
      provider: provider,
      model: model,
      usage: usage,
      retry: retry,
      compaction: compaction,
      isError: isError,
      events: events
    )
  }
}

/// Fold the raw durable event stream into the semantic records used by the
/// original Trajectory ledger.
public enum ArkTrajectoryProjection {
  public static func records(from sourceEvents: [ArkHistoryEvent]) -> [ArkTrajectorySemanticRecord] {
    let events = sourceEvents.sorted { $0.id < $1.id }
    var builders: [ArkTrajectoryRecordBuilder] = []
    var indexByID: [String: Int] = [:]
    var requestByStep: [String: ArkTrajectoryRequestMetadata] = [:]
    var stepStart: [String: Date] = [:]
    var compactionStart: [String: (Date, Int?)] = [:]
    var currentTurn: Int?
    var currentStep: Int?

    func stepKey(_ turn: Int?, _ step: Int?) -> String? {
      guard let turn, let step else { return nil }
      return "\(turn):\(step)"
    }

    func append(_ builder: ArkTrajectoryRecordBuilder) {
      indexByID[builder.id] = builders.count
      builders.append(builder)
    }

    func replace(_ builder: ArkTrajectoryRecordBuilder) {
      if let index = indexByID[builder.id], builders.indices.contains(index) {
        builders[index] = builder
      } else {
        append(builder)
      }
    }

    for event in events {
      let explicitTurn = integer(in: event.data, key: "turn")
      let explicitStep = integer(in: event.data, key: "step")
      if let explicitTurn { currentTurn = explicitTurn }
      if let explicitStep { currentStep = explicitStep }

      switch event.type {
      case "turn/start":
        if let turn = explicitTurn {
          currentTurn = turn
          currentStep = nil
        }

      case "step/start":
        if let turn = explicitTurn, let step = explicitStep {
          currentTurn = turn
          currentStep = step
          stepStart["\(turn):\(step)"] = event.time
        }

      case "step/end":
        currentStep = nil

      case "turn/end":
        currentStep = nil
        currentTurn = nil

      case "request/header":
        let key = stepKey(explicitTurn ?? currentTurn, explicitStep ?? currentStep)
        let provider = string(in: event.data, keys: ["provider"])
        let model = string(in: event.data["header"] ?? event.data, keys: ["model"])
        if let key {
          var metadata = requestByStep[key] ?? ArkTrajectoryRequestMetadata()
          metadata.provider = provider ?? metadata.provider
          metadata.model = model ?? metadata.model
          metadata.headerEvent = event
          requestByStep[key] = metadata
        }
        let reason = event.data["reason"]?.stringValue
        if reason == "initial" || reason == "change" {
          let system = event.data["header"]?["system"]?.stringValue
          let prompt = system ?? "Request header"
          append(ArkTrajectoryRecordBuilder(
            id: "system:\(event.id)",
            sequence: event.id,
            endSequence: event.id,
            eventType: event.type,
            time: event.time,
            completedAt: event.time,
            turn: explicitTurn ?? currentTurn,
            step: nil,
            kind: .system,
            title: reason == "change" ? "System Prompt Changed" : "System Prompt",
            preview: ArkTrajectoryFormat.preview(prompt),
            input: prompt,
            output: nil,
            provider: provider,
            model: model,
            usage: nil,
            retry: nil,
            compaction: nil,
            events: [event]
          ))
        }

      case "request/context":
        if let key = stepKey(explicitTurn ?? currentTurn, explicitStep ?? currentStep) {
          var metadata = requestByStep[key] ?? ArkTrajectoryRequestMetadata()
          metadata.provider = string(in: event.data, keys: ["provider"]) ?? metadata.provider
          metadata.model = string(in: event.data, keys: ["model"]) ?? metadata.model
          metadata.contextEvent = event
          requestByStep[key] = metadata
        }

      case "llm/retry":
        if let key = stepKey(explicitTurn ?? currentTurn, explicitStep ?? currentStep) {
          var metadata = requestByStep[key] ?? ArkTrajectoryRequestMetadata()
          metadata.provider = event.data["provider"]?.stringValue ?? metadata.provider
          metadata.retry = ArkTrajectoryRetry(
            attempt: integer(in: event.data, key: "retry"),
            maximum: integer(in: event.data, key: "maxRetries"),
            delayMs: number(in: event.data, keys: ["delayMs", "retryDelayMs"]),
            failure: string(in: event.data["failure"] ?? event.data, keys: ["message", "reason"])
          )
          requestByStep[key] = metadata
        }

      case "user/message":
        let message = event.data["message"] ?? event.data
        let source = message["source"]
        if source?["kind"]?.stringValue == "plugin",
          source?["plugin"]?.stringValue == "compact",
          source?["compactionId"]?.stringValue != nil
        {
          break
        }
        let text = contentText(in: message) ?? "User message"
        let sourceKind = source?["kind"]?.stringValue
        let kind: ArkTrajectorySemanticKind =
          sourceKind == "user" || sourceKind == nil ? .user : .context
        append(ArkTrajectoryRecordBuilder(
          id: "message:\(message["id"]?.stringValue ?? String(event.id))",
          sequence: event.id,
          endSequence: event.id,
          eventType: event.type,
          time: event.time,
          completedAt: event.time,
          turn: explicitTurn ?? currentTurn,
          step: explicitStep ?? currentStep,
          kind: kind,
          title: kind == .user ? "User" : "Context",
          preview: ArkTrajectoryFormat.preview(text),
          input: text,
          output: nil,
          provider: nil,
          model: nil,
          usage: nil,
          retry: nil,
          compaction: nil,
          events: [event]
        ))

      case "assistant/chunk":
        guard let turn = explicitTurn ?? currentTurn, let step = explicitStep ?? currentStep else {
          break
        }
        let id = "assistant:\(turn):\(step)"
        let chunk = event.data["chunk"]
        let chunkType = chunk?["type"]?.stringValue
        let delta = chunk?["text"]?.stringValue ?? ""
        if let index = indexByID[id], builders.indices.contains(index) {
          var builder = builders[index]
          builder.endSequence = event.id
          builder.eventType = event.type
          builder.completedAt = nil
          builder.events.append(event)
          if chunkType == "text-delta" {
            builder.output = (builder.output ?? "") + delta
          } else if chunkType == "reasoning-delta" {
            builder.input = (builder.input ?? "") + delta
          }
          builder.preview = ArkTrajectoryFormat.preview(
            builder.output?.isEmpty == false ? builder.output! : builder.input ?? "Streaming response…"
          )
          builders[index] = builder
        } else {
          let started = stepStart["\(turn):\(step)"] ?? event.time
          let output = chunkType == "text-delta" ? delta : nil
          let reasoning = chunkType == "reasoning-delta" ? delta : nil
          append(ArkTrajectoryRecordBuilder(
            id: id,
            sequence: event.id,
            endSequence: event.id,
            eventType: event.type,
            time: started,
            completedAt: nil,
            turn: turn,
            step: step,
            kind: .message,
            title: "Assistant",
            preview: ArkTrajectoryFormat.preview(output ?? reasoning ?? "Streaming response…"),
            input: reasoning,
            output: output,
            provider: nil,
            model: nil,
            usage: nil,
            retry: nil,
            compaction: nil,
            events: [event]
          ))
        }

      case "assistant/message":
        guard let turn = explicitTurn ?? currentTurn, let step = explicitStep ?? currentStep else {
          break
        }
        let id = "assistant:\(turn):\(step)"
        let message = event.data["message"] ?? event.data
        let text = contentText(in: message, kinds: ["text"])
        let reasoning = contentText(in: message, kinds: ["reasoning", "thinking"])
        let prior = indexByID[id].flatMap { builders.indices.contains($0) ? builders[$0] : nil }
        replace(ArkTrajectoryRecordBuilder(
          id: id,
          sequence: prior?.sequence ?? event.id,
          endSequence: event.id,
          eventType: event.type,
          time: stepStart["\(turn):\(step)"] ?? prior?.time ?? event.time,
          completedAt: event.time,
          turn: turn,
          step: step,
          kind: .message,
          title: event.data["interrupted"]?.boolValue == true ? "Assistant · Interrupted" : "Assistant",
          preview: ArkTrajectoryFormat.preview(text ?? reasoning ?? "Tool call only"),
          input: reasoning,
          output: text,
          provider: prior?.provider,
          model: prior?.model,
          usage: usage(in: event.data),
          retry: prior?.retry,
          compaction: nil,
          isError: false,
          events: (prior?.events ?? []) + [event]
        ))

      case "tool/call":
        guard let callID = event.data["callId"]?.stringValue else { break }
        let name = event.data["name"]?.stringValue ?? "tool"
        let arguments = event.data["arguments"]?.stringValue ?? json(event.data["arguments"], pretty: true)
        append(ArkTrajectoryRecordBuilder(
          id: "tool:\(callID)",
          sequence: event.id,
          endSequence: event.id,
          eventType: event.type,
          time: event.time,
          completedAt: nil,
          turn: explicitTurn ?? currentTurn,
          step: explicitStep ?? currentStep,
          kind: .tool,
          title: name,
          preview: ArkTrajectoryFormat.preview(arguments.isEmpty ? name : "\(name)  \(arguments)"),
          input: arguments,
          output: nil,
          provider: nil,
          model: nil,
          usage: nil,
          retry: nil,
          compaction: nil,
          events: [event]
        ))

      case "tool/result":
        let callID = event.data["message"]?["source"]?["callId"]?.stringValue
          ?? event.data["callId"]?.stringValue
        guard let callID else { break }
        let id = "tool:\(callID)"
        let output = contentText(in: event.data) ?? json(event.data, pretty: true)
        let error = event.data["isError"]?.boolValue == true || event.data["error"] != nil
          || event.data["message"]?["content"]?.arrayValue?.contains(where: {
            $0["isError"]?.boolValue == true
          }) == true
        if let index = indexByID[id], builders.indices.contains(index) {
          var builder = builders[index]
          builder.endSequence = event.id
          builder.eventType = event.type
          builder.completedAt = event.time
          builder.output = output
          builder.isError = error
          builder.events.append(event)
          builders[index] = builder
        } else {
          append(ArkTrajectoryRecordBuilder(
            id: id,
            sequence: event.id,
            endSequence: event.id,
            eventType: event.type,
            time: event.time,
            completedAt: event.time,
            turn: explicitTurn ?? currentTurn,
            step: explicitStep ?? currentStep,
            kind: .tool,
            title: "tool",
            preview: ArkTrajectoryFormat.preview(output),
            input: nil,
            output: output,
            provider: nil,
            model: nil,
            usage: nil,
            retry: nil,
            compaction: nil,
            isError: error,
            events: [event]
          ))
        }

      case "tool/code-dispatch-start":
        guard let subCallID = event.data["subCallId"]?.stringValue else { break }
        let name = event.data["name"]?.stringValue ?? "tool"
        let arguments = json(event.data["arguments"], pretty: true)
        append(ArkTrajectoryRecordBuilder(
          id: "subtool:\(subCallID)",
          sequence: event.id,
          endSequence: event.id,
          eventType: event.type,
          time: event.time,
          completedAt: nil,
          turn: explicitTurn ?? currentTurn,
          step: explicitStep ?? currentStep,
          kind: .subtool,
          title: name,
          preview: ArkTrajectoryFormat.preview(arguments.isEmpty ? name : "\(name)  \(arguments)"),
          input: arguments,
          output: nil,
          provider: nil,
          model: nil,
          usage: nil,
          retry: nil,
          compaction: nil,
          events: [event]
        ))

      case "tool/code-dispatch":
        guard let subCallID = event.data["subCallId"]?.stringValue else { break }
        let id = "subtool:\(subCallID)"
        let output = contentText(in: event.data) ?? json(event.data["content"], pretty: true)
        let error = event.data["isError"]?.boolValue == true
        if let index = indexByID[id], builders.indices.contains(index) {
          var builder = builders[index]
          builder.endSequence = event.id
          builder.eventType = event.type
          builder.completedAt = event.time
          builder.output = output
          builder.isError = error
          builder.events.append(event)
          builders[index] = builder
        }

      case "compaction/start":
        if let id = event.data["compactionId"]?.stringValue {
          compactionStart[id] = (event.time, explicitTurn)
        }

      case "compaction/summary":
        let compactionID = event.data["compactionId"]?.stringValue ?? String(event.id)
        let start = compactionStart[compactionID]
        let summary = contentText(in: event.data["summary"] ?? event.data) ?? "Context compacted"
        append(ArkTrajectoryRecordBuilder(
          id: "compaction:\(compactionID)",
          sequence: event.id,
          endSequence: event.id,
          eventType: event.type,
          time: start?.0 ?? event.time,
          completedAt: event.time,
          turn: explicitTurn ?? start?.1,
          step: nil,
          kind: .compacted,
          title: "Context compacted",
          preview: ArkTrajectoryFormat.preview(summary),
          input: event.data["rawOutput"].map { contentText(in: $0) ?? json($0, pretty: true) },
          output: summary,
          provider: event.data["provider"]?.stringValue,
          model: event.data["model"]?.stringValue,
          usage: usage(in: event.data),
          retry: nil,
          compaction: event.data["shadowedTokenCount"]?.numberValue.map {
            "Shadowed \(Int($0)) tokens"
          },
          events: [event]
        ))

      case "compaction/end":
        guard let compactionID = event.data["compactionId"]?.stringValue,
          let index = indexByID["compaction:\(compactionID)"], builders.indices.contains(index)
        else { break }
        var builder = builders[index]
        builder.endSequence = event.id
        builder.completedAt = event.time
        builder.isError = event.data["error"] != nil
        builder.events.append(event)
        if let error = event.data["error"]?.stringValue {
          builder.output = error
          builder.preview = ArkTrajectoryFormat.preview(error)
        }
        builders[index] = builder

      default:
        break
      }
    }

    for index in builders.indices {
      guard let key = stepKey(builders[index].turn, builders[index].step),
        let request = requestByStep[key]
      else { continue }
      builders[index].provider = builders[index].provider ?? request.provider
      builders[index].model = builders[index].model ?? request.model
      builders[index].retry = builders[index].retry ?? request.retry
      if let header = request.headerEvent, !builders[index].events.contains(where: { $0.id == header.id }) {
        builders[index].events.append(header)
      }
      if let context = request.contextEvent,
        !builders[index].events.contains(where: { $0.id == context.id })
      {
        builders[index].events.append(context)
      }
    }

    return builders.map { builder in
      var builder = builder
      builder.events.sort { $0.id < $1.id }
      return builder.build()
    }
    .sorted {
      if $0.sequence == $1.sequence { return $0.id < $1.id }
      return $0.sequence < $1.sequence
    }
  }

  public static func detailJSON(for record: ArkTrajectorySemanticRecord) -> String {
    let values: [JSONValue] = record.events.map { event in
      var object: [String: JSONValue] = [
        "seq": .number(Double(event.id)),
        "type": .string(event.type),
        "time": .string(ArkTrajectoryFormat.iso.string(from: event.time)),
        "data": event.data,
      ]
      if let view = event.view { object["view"] = view }
      return .object(object)
    }
    return json(.array(values), pretty: true)
  }

  private static func usage(in value: JSONValue) -> ArkTrajectoryUsage? {
    guard let object = object(in: value, key: "usage") else { return nil }
    let result = ArkTrajectoryUsage(
      input: integer(object["inputTokens"]),
      cacheRead: integer(object["cacheReadTokens"]),
      cacheWrite: integer(object["cacheWriteTokens"]),
      output: integer(object["outputTokens"]),
      reasoning: integer(object["reasoningTokens"])
    )
    return result.isEmpty ? nil : result
  }

  fileprivate static func integer(in value: JSONValue, key: String) -> Int? {
    number(in: value, keys: [key]).flatMap(integer)
  }

  private static func integer(_ value: JSONValue?) -> Int? {
    value?.numberValue.flatMap(integer)
  }

  private static func integer(_ value: Double) -> Int? {
    guard value.isFinite, value.rounded(.towardZero) == value,
      value >= Double(Int.min), value <= Double(Int.max)
    else { return nil }
    return Int(value)
  }

  fileprivate static func number(
    in value: JSONValue,
    keys: [String],
    depth: Int = 0
  ) -> Double? {
    guard depth <= 6 else { return nil }
    switch value {
    case .object(let object):
      for key in keys {
        if let number = object[key]?.numberValue { return number }
      }
      for key in object.keys.sorted() {
        if let found = number(in: object[key]!, keys: keys, depth: depth + 1) { return found }
      }
    case .array(let values):
      for child in values {
        if let found = number(in: child, keys: keys, depth: depth + 1) { return found }
      }
    default: break
    }
    return nil
  }

  fileprivate static func string(
    in value: JSONValue,
    keys: [String],
    depth: Int = 0
  ) -> String? {
    guard depth <= 6 else { return nil }
    switch value {
    case .object(let object):
      for key in keys {
        if let string = object[key]?.stringValue { return string }
      }
      for key in object.keys.sorted() {
        if let found = string(in: object[key]!, keys: keys, depth: depth + 1) { return found }
      }
    case .array(let values):
      for child in values {
        if let found = string(in: child, keys: keys, depth: depth + 1) { return found }
      }
    default: break
    }
    return nil
  }

  private static func object(
    in value: JSONValue,
    key: String,
    depth: Int = 0
  ) -> [String: JSONValue]? {
    guard depth <= 6 else { return nil }
    switch value {
    case .object(let dictionary):
      if let found = dictionary[key]?.objectValue { return found }
      for childKey in dictionary.keys.sorted() {
        if let found = object(in: dictionary[childKey]!, key: key, depth: depth + 1) {
          return found
        }
      }
    case .array(let values):
      for child in values {
        if let found = object(in: child, key: key, depth: depth + 1) { return found }
      }
    default: break
    }
    return nil
  }

  fileprivate static func contentText(
    in value: JSONValue,
    kinds: Set<String>? = nil,
    depth: Int = 0
  ) -> String? {
    guard depth <= 8 else { return nil }
    if let kind = value["type"]?.stringValue,
      kinds == nil || kinds!.contains(kind),
      let text = value["text"]?.stringValue,
      !text.isEmpty
    {
      return text
    }
    if kinds == nil, let text = value["text"]?.stringValue, !text.isEmpty { return text }
    switch value {
    case .array(let values):
      let pieces = values.compactMap { contentText(in: $0, kinds: kinds, depth: depth + 1) }
      return pieces.isEmpty ? nil : pieces.joined(separator: "\n")
    case .object(let object):
      let priority = ["content", "message", "result", "summary", "rawOutput"]
      for key in priority {
        if let child = object[key], let text = contentText(in: child, kinds: kinds, depth: depth + 1) {
          return text
        }
      }
      var pieces: [String] = []
      for key in object.keys.sorted() where !priority.contains(key) {
        if let text = contentText(in: object[key]!, kinds: kinds, depth: depth + 1) {
          pieces.append(text)
        }
      }
      return pieces.isEmpty ? nil : pieces.joined(separator: "\n")
    default:
      return nil
    }
  }

  /// Extract only image-shaped attachment references. Arbitrary `id` fields
  /// elsewhere in a tool payload are deliberately ignored so a table row
  /// cannot accidentally try to load a non-image resource.
  fileprivate static func imageAttachmentIDs(
    in value: JSONValue,
    depth: Int = 0
  ) -> [String] {
    guard depth <= 12 else { return [] }
    var result: [String] = []
    func visit(_ value: JSONValue, depth: Int) {
      guard depth <= 12 else { return }
      switch value {
      case .object(let object):
        if object["type"]?.stringValue == "image" {
          let attachment = object["attachment"]
          let id = attachment?["attachmentId"]?.stringValue
            ?? attachment?["id"]?.stringValue
            ?? object["attachmentId"]?.stringValue
          if let id, !id.isEmpty { result.append(id) }
        }
        for key in object.keys.sorted() {
          visit(object[key]!, depth: depth + 1)
        }
      case .array(let values):
        for child in values { visit(child, depth: depth + 1) }
      case .string, .number, .bool, .null:
        break
      }
    }
    visit(value, depth: depth)
    var seen = Set<String>()
    return result.filter { seen.insert($0).inserted }
  }

  fileprivate static func json(_ value: JSONValue?, pretty: Bool) -> String {
    guard let value else { return "" }
    let encoder = JSONEncoder()
    encoder.outputFormatting = pretty
      ? [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
      : [.sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(value) else { return "" }
    return String(decoding: data, as: UTF8.self)
  }
}

public struct ArkTrajectoryTimeRange: Equatable, Sendable {
  public let start: Double
  public let end: Double

  public init(start: Double, end: Double) {
    self.start = min(max(min(start, end), 0), 1)
    self.end = min(max(max(start, end), 0), 1)
  }

  public func overlaps(start: Double, end: Double) -> Bool {
    max(self.start, min(start, end)) <= min(self.end, max(start, end))
  }
}

/// Pure overview viewport policy used by the AppKit interaction surface and
/// its contract tests.
public struct ArkTrajectoryViewportState: Equatable, Sendable {
  public private(set) var zoom: Double
  public private(set) var origin: Double

  public init(zoom: Double = 1, origin: Double = 0) {
    self.zoom = min(max(zoom.isFinite ? zoom : 1, 1), 32)
    self.origin = 0
    self.origin = clampedOrigin(origin)
  }

  public var visibleLength: Double { 1 / zoom }

  /// Whether the zoomed viewport still contains the beginning of the loaded
  /// time domain. The unknown-prefix control is visible only in this state.
  public var includesLoadedDomainStart: Bool { origin <= 0.000_000_1 }

  public mutating func zoom(by factor: Double, around anchor: Double) {
    let safeFactor = factor.isFinite && factor > 0 ? factor : 1
    let safeAnchor = min(max(anchor.isFinite ? anchor : 0.5, 0), 1)
    let absoluteAnchor = origin + safeAnchor * visibleLength
    zoom = min(max(zoom * safeFactor, 1), 32)
    origin = clampedOrigin(absoluteAnchor - safeAnchor * visibleLength)
  }

  public mutating func pan(by delta: Double) {
    origin = clampedOrigin(origin + (delta.isFinite ? delta : 0))
  }

  public mutating func reveal(_ position: Double) {
    let position = min(max(position.isFinite ? position : 0, 0), 1)
    if position < origin { origin = clampedOrigin(position) }
    else if position > origin + visibleLength {
      origin = clampedOrigin(position - visibleLength)
    }
  }

  public func viewportFraction(for absolute: Double) -> Double {
    (absolute - origin) / visibleLength
  }

  public func absoluteFraction(for viewport: Double) -> Double {
    min(max(origin + viewport * visibleLength, 0), 1)
  }

  private func clampedOrigin(_ value: Double) -> Double {
    min(max(value.isFinite ? value : 0, 0), max(0, 1 - visibleLength))
  }
}

/// Re-entry gate shared by explicit and scroll-top history loading. Initial
/// layout is deliberately unarmed so the temporary top origin observed before
/// tail restoration cannot start a page request.
public struct ArkTrajectoryOlderLoadPolicy: Equatable, Sendable {
  public private(set) var isArmed = false
  public private(set) var isAtTop = false
  public private(set) var isInFlight = false

  public init() {}

  public mutating func reset() {
    isArmed = false
    isAtTop = false
    isInFlight = false
  }

  /// Arm automatic loading after initial tail placement.
  /// - Returns: true when the already-observed top position should start a page.
  public mutating func arm(hasOlder: Bool, backendLoading: Bool) -> Bool {
    isArmed = true
    return beginIfAllowed(hasOlder: hasOlder, backendLoading: backendLoading, requiresTop: true)
  }

  /// Observe the table's normalized top position.
  /// - Returns: true exactly once for a permitted top-triggered request.
  public mutating func updateTop(
    _ isAtTop: Bool,
    hasOlder: Bool,
    backendLoading: Bool
  ) -> Bool {
    self.isAtTop = isAtTop
    return beginIfAllowed(hasOlder: hasOlder, backendLoading: backendLoading, requiresTop: true)
  }

  /// Request a page from an explicit button or Overview prefix control.
  public mutating func request(hasOlder: Bool, backendLoading: Bool) -> Bool {
    beginIfAllowed(hasOlder: hasOlder, backendLoading: backendLoading, requiresTop: false)
  }

  public mutating func finish() {
    isInFlight = false
  }

  private mutating func beginIfAllowed(
    hasOlder: Bool,
    backendLoading: Bool,
    requiresTop: Bool
  ) -> Bool {
    guard hasOlder, !backendLoading, !isInFlight,
      !requiresTop || (isArmed && isAtTop)
    else { return false }
    isInFlight = true
    return true
  }
}

private enum ArkTrajectoryFormat {
  static let iso: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()

  static func duration(_ milliseconds: Double) -> String {
    if milliseconds < 1 { return String(format: "%.2f ms", milliseconds) }
    if milliseconds < 1_000 { return String(format: "%.0f ms", milliseconds) }
    if milliseconds < 60_000 { return String(format: "%.2f s", milliseconds / 1_000) }
    return String(format: "%.1f min", milliseconds / 60_000)
  }

  static func preview(_ text: String) -> String {
    truncate(text.replacingOccurrences(of: "\n", with: " "), limit: 240)
  }

  static func truncate(_ text: String, limit: Int) -> String {
    guard text.count > limit else { return text }
    return String(text.prefix(limit)) + "…"
  }
}

private enum NativeTrajectoryPalette {
  static let background = Color(nsColor: .windowBackgroundColor)
  static let panel = Color(nsColor: .controlBackgroundColor)
  static let raised = Color.primary.opacity(0.06)
  static let separator = Color(nsColor: .separatorColor)
  static let primary = Color(nsColor: .labelColor)
  static let secondary = Color(nsColor: .secondaryLabelColor)
  static let tertiary = Color(nsColor: .tertiaryLabelColor)
  static let selection = Color.accentColor.opacity(0.18)

  static func event(_ kind: ArkTrajectorySemanticKind, error: Bool = false) -> Color {
    if error { return .red }
    switch kind {
    case .user: return .blue
    case .context: return .green
    case .message: return .purple
    case .tool: return .orange
    case .subtool: return Color.orange.opacity(0.72)
    case .system, .compacted: return secondary
    }
  }
}

private enum NativeTrajectoryMode: String, CaseIterable, Identifiable {
  case timeline
  case table
  var id: String { rawValue }

  func title(_ language: ArkLanguagePreference) -> String {
    switch self {
    case .timeline: return ArkL10n.text(.trajectoryTimeline, language)
    case .table: return ArkL10n.text(.trajectoryTable, language)
    }
  }
}

private enum NativeTrajectoryDetailTab: String, CaseIterable, Identifiable {
  case summary = "概览"
  case input = "输入"
  case output = "输出"
  case source = "原始 JSON"
  var id: String { rawValue }

  func title(_ language: ArkLanguagePreference) -> String {
    switch self {
    case .summary: return ArkL10n.text(.tabOverview, language)
    case .input: return ArkL10n.text(.tabInput, language)
    case .output: return ArkL10n.text(.tabOutput, language)
    case .source: return ArkL10n.text(.tabRawJSON, language)
    }
  }
}

private struct NativeTrajectoryGroup: Identifiable {
  let id: String
  let title: String
  let turn: Int?
  let step: Int?
  let records: [ArkTrajectorySemanticRecord]
  let collapsedTurn: Bool
}

@MainActor
private final class NativeTrajectoryFeed: ObservableObject {
  @Published private(set) var records: [ArkTrajectorySemanticRecord]
  @Published private(set) var selectedSessionID: String?
  @Published private(set) var hasOlderHistory: Bool
  @Published private(set) var loadingOlderHistory: Bool
  @Published private(set) var language: ArkLanguagePreference
  private var cancellables = Set<AnyCancellable>()

  init(model: ArkAppModel) {
    records = model.trajectoryRecords
    selectedSessionID = model.selectedSessionID
    hasOlderHistory = model.hasOlderHistory
    loadingOlderHistory = model.loadingOlderHistory
    language = model.languagePreference

    model.$trajectoryRecords
      .throttle(for: .milliseconds(160), scheduler: RunLoop.main, latest: true)
      .sink { [weak self] records in
        guard let self, self.records != records else { return }
        self.records = records
      }
      .store(in: &cancellables)
    model.$selectedSessionID
      .removeDuplicates()
      .sink { [weak self] in self?.selectedSessionID = $0 }
      .store(in: &cancellables)
    model.$hasOlderHistory
      .removeDuplicates()
      .sink { [weak self] in self?.hasOlderHistory = $0 }
      .store(in: &cancellables)
    model.$loadingOlderHistory
      .removeDuplicates()
      .sink { [weak self] in self?.loadingOlderHistory = $0 }
      .store(in: &cancellables)
    model.$languagePreference
      .removeDuplicates()
      .sink { [weak self] in self?.language = $0 }
      .store(in: &cancellables)
  }
}

/// Native implementation of the legacy Trajectory ledger. The raw session
/// event window remains the source of truth, but its token deltas are folded
/// before reaching the table.
struct NativeTrajectoryParityView: View, Equatable {
  let model: ArkAppModel
  @StateObject private var feed: NativeTrajectoryFeed
  @StateObject private var scrollController: ArkChatScrollController
  @State private var mode: NativeTrajectoryMode = .timeline
  @AppStorage("ark.native.trajectory.actual-duration") private var useActualDuration = false
  @State private var query = ""
  @State private var excludedKinds = Set<ArkTrajectorySemanticKind>()
  @State private var collapsedTurns = Set<Int>()
  @State private var collapsedAssistants = Set<String>()
  @State private var selectedRecordID: String?
  @State private var timelineRange: ArkTrajectoryTimeRange?
  @State private var viewport = ArkTrajectoryViewportState()
  @State private var olderLoadPolicy = ArkTrajectoryOlderLoadPolicy()
  @State private var loadingOlder = false

  init(model: ArkAppModel) {
    self.model = model
    _feed = StateObject(wrappedValue: NativeTrajectoryFeed(model: model))
    _scrollController = StateObject(wrappedValue: ArkChatScrollController(followThreshold: 24))
  }

  static func == (lhs: Self, rhs: Self) -> Bool { lhs.model === rhs.model }

  private var sessionKey: String {
    "trajectory:\(feed.selectedSessionID ?? "new-session")"
  }

  private var records: [ArkTrajectorySemanticRecord] { feed.records }

  private var filteredRecords: [ArkTrajectorySemanticRecord] {
    let terms = query.lowercased().split(whereSeparator: \ .isWhitespace).map(String.init)
    return records.filter { record in
      !excludedKinds.contains(record.kind)
        && (terms.isEmpty || terms.allSatisfy(record.searchText(feed.language).contains))
    }
  }

  private var visibleRecords: [ArkTrajectorySemanticRecord] {
    if !query.isEmpty { return filteredRecords }
    var result: [ArkTrajectorySemanticRecord] = []
    var currentAssistant: String?
    for record in filteredRecords {
      if record.kind == .message {
        currentAssistant = record.id
        result.append(record)
        continue
      }
      if (record.kind == .tool || record.kind == .subtool),
        let currentAssistant, collapsedAssistants.contains(currentAssistant)
      {
        continue
      }
      if record.kind != .tool && record.kind != .subtool { currentAssistant = nil }
      result.append(record)
    }
    return result
  }

  private var groups: [NativeTrajectoryGroup] {
    var order: [String] = []
    var rows: [String: [ArkTrajectorySemanticRecord]] = [:]
    for record in visibleRecords {
      let key: String
      if let turn = record.turn, collapsedTurns.contains(turn) {
        key = "collapsed-turn:\(turn)"
        if rows[key] != nil { continue }
      } else {
        key = record.groupKey
      }
      if rows[key] == nil { order.append(key) }
      rows[key, default: []].append(record)
    }
    return order.compactMap { key in
      guard let records = rows[key], let first = records.first else { return nil }
      return NativeTrajectoryGroup(
        id: key,
        title: first.groupTitle(feed.language),
        turn: first.turn,
        step: first.step,
        records: records,
        collapsedTurn: key.hasPrefix("collapsed-turn:")
      )
    }
  }

  private var selectedRecord: ArkTrajectorySemanticRecord? {
    guard let selectedRecordID else { return nil }
    return records.first { $0.id == selectedRecordID }
  }

  private var availableKinds: [ArkTrajectorySemanticKind] {
    ArkTrajectorySemanticKind.allCases.filter { kind in records.contains { $0.kind == kind } }
  }

  private var allTurnsCollapsed: Bool {
    let turns = Set(records.compactMap(\ .turn))
    return !turns.isEmpty && turns.isSubset(of: collapsedTurns)
  }

  private var allAssistantsCollapsed: Bool {
    let assistants = Set(records.filter { $0.kind == .message }.map(\ .id))
    return !assistants.isEmpty && assistants.isSubset(of: collapsedAssistants)
  }

  var body: some View {
    VStack(spacing: 0) {
      toolbar
        .zIndex(3)
      overviewSeat
        .clipped()
        .zIndex(2)
      Divider().overlay(NativeTrajectoryPalette.separator)
      contentSeat
        .zIndex(1)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background(NativeTrajectoryPalette.background)
    .foregroundStyle(NativeTrajectoryPalette.primary)
    .onAppear {
      scrollController.activate(sessionID: sessionKey)
      armTopLoadingAfterTailPlacement()
    }
    .onChange(of: feed.selectedSessionID) { _ in
      selectedRecordID = nil
      timelineRange = nil
      viewport = ArkTrajectoryViewportState()
      olderLoadPolicy.reset()
      scrollController.activate(sessionID: sessionKey)
      armTopLoadingAfterTailPlacement()
    }
    .onChange(of: feed.records) { projectedRecords in
      if let selectedRecordID,
        !projectedRecords.contains(where: { $0.id == selectedRecordID })
      {
        self.selectedRecordID = nil
      }
      DispatchQueue.main.async { scrollController.contentDidChange() }
    }
    .onChange(of: selectedRecordID) { selectedRecordID in
      guard let selectedRecordID,
        let span = NativeTrajectoryTimelineMath.spans(
          records: filteredRecords,
          actualDuration: useActualDuration
        ).first(where: { $0.recordID == selectedRecordID })
      else { return }
      viewport.reveal((span.start + span.end) / 2)
    }
  }

  @ViewBuilder
  private var overviewSeat: some View {
    if mode == .timeline {
      NativeTrajectoryOverview(
        records: filteredRecords,
        actualDuration: useActualDuration,
        selectedRecordID: selectedRecordID,
        range: $timelineRange,
        viewport: $viewport,
        hasEarlierRecords: feed.hasOlderHistory,
        loadingEarlierRecords: loadingOlder || feed.loadingOlderHistory,
        language: feed.language,
        onLoadEarlier: requestOlderExplicitly,
        onSelect: { id in
          timelineRange = nil
          selectedRecordID = id
        }
      )
      .frame(height: ArkTrajectoryMetrics.overviewHeight)
    }
  }

  @ViewBuilder
  private var contentSeat: some View {
    if let selectedRecord {
      HSplitView {
        tablePane
          .frame(minWidth: 360, maxHeight: .infinity)
        NativeTrajectoryInspector(
          model: model,
          record: selectedRecord,
          language: feed.language,
          close: { selectedRecordID = nil }
        )
        .frame(
          minWidth: ArkTrajectoryMetrics.inspectorMinimumWidth,
          idealWidth: 380,
          maxWidth: ArkTrajectoryMetrics.inspectorMaximumWidth
        )
        .frame(maxHeight: .infinity, alignment: .topLeading)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    } else {
      tablePane
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }

  private var toolbar: some View {
    HStack(spacing: 4) {
      Picker(ArkL10n.text(.trajectoryViewLabel, feed.language), selection: $mode) {
        ForEach(NativeTrajectoryMode.allCases) { mode in
          Text(mode.title(feed.language)).tag(mode)
        }
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      .frame(width: feed.language == .en ? 122 : 94, height: 22)

      Button {
        useActualDuration.toggle()
        timelineRange = nil
      } label: {
        Label(ArkL10n.text(.trajectoryDurationMode, feed.language), systemImage: "clock")
      }
      .buttonStyle(NativeTrajectoryToolbarButtonStyle(active: useActualDuration))
      .help(ArkL10n.text(
        useActualDuration ? .trajectoryUseEqualEvents : .trajectoryUseActualDuration,
        feed.language
      ))

      Button(action: toggleAllTurns) {
        Label(
          ArkL10n.text(.trajectoryTurns, feed.language),
          systemImage: allTurnsCollapsed ? "rectangle.expand.vertical" : "rectangle.compress.vertical"
        )
      }
      .buttonStyle(NativeTrajectoryToolbarButtonStyle(active: allTurnsCollapsed))

      Button(action: toggleAllAssistants) {
        Label(
          ArkL10n.text(.trajectoryCalls, feed.language),
          systemImage: allAssistantsCollapsed ? "plus.square" : "minus.square"
        )
      }
      .buttonStyle(NativeTrajectoryToolbarButtonStyle(active: allAssistantsCollapsed))

      Spacer(minLength: 4)

      HStack(spacing: 4) {
        Image(systemName: "magnifyingglass")
          .font(.system(size: 10))
          .foregroundStyle(NativeTrajectoryPalette.tertiary)
        TextField(ArkL10n.text(.trajectorySearchPlaceholder, feed.language), text: $query)
          .textFieldStyle(.plain)
          .font(.system(size: 11))
        if !query.isEmpty {
          Button { query = "" } label: {
            Image(systemName: "xmark.circle.fill")
          }
          .buttonStyle(.plain)
          .foregroundStyle(NativeTrajectoryPalette.tertiary)
        }
      }
      .padding(.horizontal, 6)
      .frame(width: 164, height: 22)
      .background(NativeTrajectoryPalette.raised, in: RoundedRectangle(cornerRadius: 4))
      .overlay(RoundedRectangle(cornerRadius: 4).stroke(NativeTrajectoryPalette.separator))

      Menu {
        Button(ArkL10n.text(.trajectoryShowAll, feed.language)) { excludedKinds.removeAll() }
          .disabled(excludedKinds.isEmpty)
        Divider()
        ForEach(availableKinds) { kind in
          Button {
            if excludedKinds.contains(kind) { excludedKinds.remove(kind) }
            else { excludedKinds.insert(kind) }
          } label: {
            Label(
              kind.label(feed.language),
              systemImage: excludedKinds.contains(kind) ? "circle" : "checkmark"
            )
          }
        }
      } label: {
        Text(ArkL10n.format(
          .trajectoryTypeCount,
          feed.language,
          arguments: [
            "\(availableKinds.count - excludedKinds.count)",
            "\(availableKinds.count)",
          ]
        ))
      }
      .menuStyle(.borderlessButton)
      .fixedSize()
      .font(.system(size: 10))

      Text("\(filteredRecords.count) / \(records.count)")
        .font(.system(size: 9, design: .monospaced))
        .foregroundStyle(NativeTrajectoryPalette.tertiary)
        .frame(minWidth: 56, alignment: .trailing)

      if feed.hasOlderHistory {
        Button(action: requestOlderExplicitly) {
          if loadingOlder || feed.loadingOlderHistory {
            ProgressView().controlSize(.small)
          } else {
            Image(systemName: "arrow.up.to.line")
          }
        }
        .buttonStyle(.plain)
        .disabled(loadingOlder || feed.loadingOlderHistory)
        .help(ArkL10n.text(.trajectoryLoadOlderHistory, feed.language))
        .accessibilityIdentifier("ark.trajectory.load-older")
      }
    }
    .padding(.horizontal, 6)
    .frame(height: ArkTrajectoryMetrics.toolbarHeight)
    .background(NativeTrajectoryPalette.panel)
  }

  private var tablePane: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
        Section {
          if feed.hasOlderHistory {
            Button(action: requestOlderExplicitly) {
              HStack(spacing: 6) {
                if loadingOlder || feed.loadingOlderHistory {
                  ProgressView().controlSize(.small)
                }
                Text(ArkL10n.text(
                  loadingOlder || feed.loadingOlderHistory
                    ? .trajectoryLoadingOlder : .trajectoryLoadOlder,
                  feed.language
                ))
              }
              .font(.system(size: 11))
              .frame(maxWidth: .infinity, minHeight: 29)
            }
            .buttonStyle(.plain)
            .disabled(loadingOlder || feed.loadingOlderHistory)
            .background(NativeTrajectoryPalette.panel)
            Divider().overlay(NativeTrajectoryPalette.separator)
          }

          if groups.isEmpty {
            VStack(spacing: 8) {
              Image(systemName: records.isEmpty ? "point.3.connected.trianglepath.dotted" : "magnifyingglass")
                .font(.system(size: 22))
              Text(ArkL10n.text(
                records.isEmpty ? .trajectoryEmpty : .trajectoryNoMatches,
                feed.language
              ))
                .font(.system(size: 12, weight: .medium))
            }
            .foregroundStyle(NativeTrajectoryPalette.secondary)
            .frame(maxWidth: .infinity)
            .padding(.top, 76)
          } else {
            ForEach(groups) { group in
              NativeTrajectoryGroupRows(
                group: group,
                selectedRecordID: selectedRecordID,
                range: timelineRange,
                actualDuration: useActualDuration,
                allRecords: filteredRecords,
                collapsedAssistants: collapsedAssistants,
                language: feed.language,
                select: { selectedRecordID = $0 },
                toggleTurn: { turn in toggleTurn(turn) },
                toggleAssistant: { id in toggleAssistant(id) }
              )
            }
          }
        } header: {
          NativeTrajectoryTableHeader(language: feed.language)
        }
      }
      .background(
        ZStack {
          ArkChatScrollAttachment(controller: scrollController)
          NativeTrajectoryTopAttachment { isAtTop in
            topPositionChanged(isAtTop)
          }
        }
        .frame(width: 0, height: 0)
      )
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background(NativeTrajectoryPalette.background)
    .accessibilityIdentifier("ark.trajectory.table")
  }

  private func toggleTurn(_ turn: Int) {
    if collapsedTurns.contains(turn) { collapsedTurns.remove(turn) }
    else { collapsedTurns.insert(turn) }
  }

  private func toggleAssistant(_ id: String) {
    if collapsedAssistants.contains(id) { collapsedAssistants.remove(id) }
    else { collapsedAssistants.insert(id) }
  }

  private func toggleAllTurns() {
    let turns = Set(records.compactMap(\ .turn))
    if allTurnsCollapsed { collapsedTurns.subtract(turns) }
    else { collapsedTurns.formUnion(turns) }
  }

  private func toggleAllAssistants() {
    let assistants = Set(records.filter { $0.kind == .message }.map(\ .id))
    if allAssistantsCollapsed { collapsedAssistants.subtract(assistants) }
    else { collapsedAssistants.formUnion(assistants) }
  }

  private func requestOlderExplicitly() {
    guard olderLoadPolicy.request(
      hasOlder: feed.hasOlderHistory,
      backendLoading: feed.loadingOlderHistory
    ) else { return }
    performOlderLoad()
  }

  private func topPositionChanged(_ isAtTop: Bool) {
    guard olderLoadPolicy.updateTop(
      isAtTop,
      hasOlder: feed.hasOlderHistory,
      backendLoading: feed.loadingOlderHistory
    ) else { return }
    performOlderLoad()
  }

  private func armTopLoadingAfterTailPlacement() {
    DispatchQueue.main.async {
      DispatchQueue.main.async {
        guard olderLoadPolicy.arm(
          hasOlder: feed.hasOlderHistory,
          backendLoading: feed.loadingOlderHistory
        ) else { return }
        performOlderLoad()
      }
    }
  }

  private func performOlderLoad() {
    guard !loadingOlder else {
      olderLoadPolicy.finish()
      return
    }
    let anchor = scrollController.capturePrependAnchor()
    loadingOlder = true
    Task {
      await model.loadOlderHistory()
      loadingOlder = false
      olderLoadPolicy.finish()
      guard let anchor else { return }
      DispatchQueue.main.async {
        scrollController.contentDidChange()
        scrollController.restoreAfterPrepend(anchor)
      }
    }
  }
}

private struct NativeTrajectoryTopAttachment: NSViewRepresentable {
  let changed: (Bool) -> Void

  init(_ changed: @escaping (Bool) -> Void) {
    self.changed = changed
  }

  func makeCoordinator() -> Coordinator { Coordinator(changed: changed) }

  func makeNSView(context: Context) -> NSView {
    let view = NSView(frame: .zero)
    DispatchQueue.main.async { context.coordinator.attach(to: view) }
    return view
  }

  func updateNSView(_ nsView: NSView, context: Context) {
    context.coordinator.changed = changed
    DispatchQueue.main.async { context.coordinator.attach(to: nsView) }
  }

  static func dismantleNSView(_ nsView: NSView, coordinator: Coordinator) {
    coordinator.detach()
  }

  final class Coordinator {
    var changed: (Bool) -> Void
    private weak var scrollView: NSScrollView?
    private var boundsObserver: NSObjectProtocol?
    private var frameObserver: NSObjectProtocol?
    private var lastValue: Bool?

    init(changed: @escaping (Bool) -> Void) {
      self.changed = changed
    }

    func attach(to view: NSView) {
      guard let scroll = view.enclosingScrollView else { return }
      if scrollView === scroll {
        update()
        return
      }
      detach()
      scrollView = scroll
      scroll.contentView.postsBoundsChangedNotifications = true
      scroll.documentView?.postsFrameChangedNotifications = true
      boundsObserver = NotificationCenter.default.addObserver(
        forName: NSView.boundsDidChangeNotification,
        object: scroll.contentView,
        queue: .main
      ) { [weak self] _ in self?.update() }
      if let document = scroll.documentView {
        frameObserver = NotificationCenter.default.addObserver(
          forName: NSView.frameDidChangeNotification,
          object: document,
          queue: .main
        ) { [weak self] _ in self?.update() }
      }
      update()
    }

    func detach() {
      if let boundsObserver { NotificationCenter.default.removeObserver(boundsObserver) }
      if let frameObserver { NotificationCenter.default.removeObserver(frameObserver) }
      boundsObserver = nil
      frameObserver = nil
      scrollView = nil
      lastValue = nil
    }

    private func update() {
      guard let scrollView else { return }
      let atTop = scrollView.documentVisibleRect.minY <= 24
      guard lastValue != atTop else { return }
      lastValue = atTop
      changed(atTop)
    }
  }
}

private struct NativeTrajectoryToolbarButtonStyle: ButtonStyle {
  let active: Bool

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 11))
      .foregroundStyle(active ? NativeTrajectoryPalette.primary : NativeTrajectoryPalette.tertiary)
      .padding(.horizontal, 5)
      .frame(height: 20)
      .contentShape(Rectangle())
      .background(
        active || configuration.isPressed
          ? NativeTrajectoryPalette.raised : Color.clear,
        in: RoundedRectangle(cornerRadius: 3)
      )
  }
}

private struct NativeTrajectoryTableHeader: View {
  let language: ArkLanguagePreference

  var body: some View {
    HStack(spacing: 0) {
      Text(ArkL10n.text(.trajectoryColumnEvent, language))
        .frame(width: ArkTrajectoryMetrics.eventColumnWidth - 8, alignment: .trailing)
        .padding(.trailing, 8)
      Text(ArkL10n.text(.trajectoryColumnContent, language))
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, 4)
    }
    .font(.system(size: 11, weight: .medium))
    .foregroundStyle(NativeTrajectoryPalette.tertiary)
    .frame(height: ArkTrajectoryMetrics.tableHeaderHeight)
    .background(Color(nsColor: .controlBackgroundColor))
    .overlay(alignment: .bottom) { Divider().overlay(NativeTrajectoryPalette.separator) }
  }
}

private struct NativeTrajectoryGroupRows: View {
  let group: NativeTrajectoryGroup
  let selectedRecordID: String?
  let range: ArkTrajectoryTimeRange?
  let actualDuration: Bool
  let allRecords: [ArkTrajectorySemanticRecord]
  let collapsedAssistants: Set<String>
  let language: ArkLanguagePreference
  let select: (String) -> Void
  let toggleTurn: (Int) -> Void
  let toggleAssistant: (String) -> Void

  var body: some View {
    if group.collapsedTurn, let record = group.records.first {
      NativeTrajectoryCollapsedTurnRow(
        turn: record.turn,
        summary: collapsedTurnSummary(record.turn),
        language: language,
        action: { if let turn = record.turn { toggleTurn(turn) } }
      )
    } else {
      ForEach(Array(group.records.enumerated()), id: \ .element.id) { offset, record in
        NativeTrajectoryTableRow(
          record: record,
          group: group,
          firstInGroup: offset == 0,
          lastInGroup: offset == group.records.count - 1,
          selected: record.id == selectedRecordID,
          focused: timelineFocus(record),
          callsCollapsed: collapsedAssistants.contains(record.id),
          language: language,
          select: { select(record.id) },
          toggleTurn: { if let turn = record.turn { toggleTurn(turn) } },
          toggleAssistant: { toggleAssistant(record.id) }
        )
        if record.kind == .message,
          collapsedAssistants.contains(record.id),
          collapsedCallCount(after: record) > 0
        {
          NativeTrajectoryCollapsedAssistantRow(
            count: collapsedCallCount(after: record),
            language: language,
            action: { toggleAssistant(record.id) }
          )
        }
      }
    }
  }

  private func collapsedTurnSummary(_ turn: Int?) -> String {
    guard let turn else { return ArkL10n.text(.trajectoryCollapsedSession, language) }
    let records = allRecords.filter { $0.turn == turn }
    let tools = records.filter { $0.kind == .tool || $0.kind == .subtool }.count
    return ArkL10n.format(
      .trajectoryRecordsAndCalls,
      language,
      arguments: ["\(records.count)", "\(tools)"]
    )
  }

  private func collapsedCallCount(after record: ArkTrajectorySemanticRecord) -> Int {
    allRecords.filter {
      $0.turn == record.turn
        && $0.step == record.step
        && $0.sequence > record.sequence
        && ($0.kind == .tool || $0.kind == .subtool)
    }.count
  }

  private func timelineFocus(_ record: ArkTrajectorySemanticRecord) -> Bool {
    guard let range else { return true }
    let spans = NativeTrajectoryTimelineMath.spans(records: allRecords, actualDuration: actualDuration)
    guard let span = spans.first(where: { $0.recordID == record.id }) else { return true }
    return range.overlaps(start: span.start, end: span.end)
  }
}

private struct NativeTrajectoryCollapsedTurnRow: View {
  let turn: Int?
  let summary: String
  let language: ArkLanguagePreference
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        Text("…")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(NativeTrajectoryPalette.tertiary)
        Text(turn.map {
          ArkL10n.format(
            .trajectoryTurnWithSummary,
            language,
            arguments: ["\($0)", summary]
          )
        } ?? summary)
          .font(.system(size: 11))
          .foregroundStyle(NativeTrajectoryPalette.secondary)
          .lineLimit(1)
        Spacer()
      }
      .padding(.horizontal, 12)
      .frame(height: 20)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .overlay(alignment: .bottom) {
      Rectangle().fill(NativeTrajectoryPalette.separator.opacity(0.55)).frame(height: 1)
    }
  }
}

private struct NativeTrajectoryCollapsedAssistantRow: View {
  let count: Int
  let language: ArkLanguagePreference
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        Text("…")
          .font(.system(size: 12, weight: .semibold))
        Text(ArkL10n.format(
          .trajectoryCollapsedCalls,
          language,
          arguments: ["\(count)"]
        ))
          .font(.system(size: 11))
        Spacer()
      }
      .foregroundStyle(NativeTrajectoryPalette.secondary)
      .padding(.leading, ArkTrajectoryMetrics.eventColumnWidth + 4)
      .padding(.trailing, 8)
      .frame(height: 20)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .overlay(alignment: .bottom) {
      Rectangle().fill(NativeTrajectoryPalette.separator.opacity(0.55)).frame(height: 1)
    }
  }
}

private struct NativeTrajectoryTableRow: View {
  let record: ArkTrajectorySemanticRecord
  let group: NativeTrajectoryGroup
  let firstInGroup: Bool
  let lastInGroup: Bool
  let selected: Bool
  let focused: Bool
  let callsCollapsed: Bool
  let language: ArkLanguagePreference
  let select: () -> Void
  let toggleTurn: () -> Void
  let toggleAssistant: () -> Void

  var body: some View {
    Button(action: select) {
      HStack(spacing: 0) {
        eventCell
          .frame(width: ArkTrajectoryMetrics.eventColumnWidth)
        HStack(spacing: 7) {
          if record.kind == .subtool {
            Color.clear.frame(width: 18)
          }
          Text(record.preview.isEmpty ? "—" : record.preview)
            .font(.system(size: 12, design: record.kind == .tool || record.kind == .subtool ? .monospaced : .default))
            .lineLimit(1)
          if !record.metadataSummary(language).isEmpty {
            Text(record.metadataSummary(language))
              .font(.system(size: 10, design: .monospaced))
              .foregroundStyle(NativeTrajectoryPalette.tertiary)
              .lineLimit(1)
          }
          Spacer(minLength: 4)
          if record.kind == .message,
            hasFollowingCalls
          {
            Button(action: toggleAssistant) {
              Image(systemName: callsCollapsed ? "chevron.right" : "chevron.down")
                .font(.system(size: 9, weight: .semibold))
                .frame(width: 18, height: 18)
            }
            .buttonStyle(.plain)
            .help(ArkL10n.text(
              callsCollapsed ? .trajectoryExpandCalls : .trajectoryCollapseCalls,
              language
            ))
          }
          if !record.attachmentIDs.isEmpty {
            Image(systemName: "photo.on.rectangle")
              .font(.system(size: 10))
              .foregroundStyle(NativeTrajectoryPalette.tertiary)
              .help(ArkL10n.format(
                .trajectoryImages,
                language,
                arguments: ["\(record.attachmentIDs.count)"]
              ))
          }
          Text(record.durationMs.map(ArkTrajectoryFormat.duration) ?? "—")
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(NativeTrajectoryPalette.tertiary)
            .frame(width: 64, alignment: .trailing)
        }
        .padding(.leading, 4)
        .padding(.trailing, 8)
      }
      .frame(height: ArkTrajectoryMetrics.tableRowHeight)
      .background(selected ? NativeTrajectoryPalette.selection.opacity(0.25) : Color.clear)
      .opacity(focused ? 1 : 0.24)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .overlay(alignment: .leading) {
      Rectangle()
        .fill(record.isError ? Color.red : NativeTrajectoryPalette.event(record.kind).opacity(0.34))
        .frame(width: selected ? 3 : 2)
    }
    .overlay(alignment: .top) {
      if firstInGroup {
        Rectangle().fill(NativeTrajectoryPalette.separator).frame(height: 1)
      }
    }
    .overlay(alignment: .bottom) {
      Rectangle().fill(NativeTrajectoryPalette.separator.opacity(0.55)).frame(height: 1)
    }
    .accessibilityLabel("\(record.kind.label(language)), \(record.preview), \(record.location(language))")
    .accessibilityValue(selected ? ArkL10n.text(.trajectorySelected, language) : "")
  }

  private var eventCell: some View {
    ZStack(alignment: .leading) {
      if firstInGroup {
        Button(action: toggleTurn) {
          Text(turnLabel)
            .font(.system(size: 8, design: .monospaced))
            .foregroundStyle(NativeTrajectoryPalette.tertiary)
            .padding(.horizontal, 4)
            .frame(height: 12)
            .background(NativeTrajectoryPalette.raised)
        }
        .buttonStyle(.plain)
        .offset(y: -9)
      }
      HStack(spacing: 4) {
        Spacer(minLength: 24)
        Text(record.kind.label(language))
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(NativeTrajectoryPalette.event(record.kind, error: record.isError))
          .padding(.horizontal, 5)
          .frame(height: 19)
          .background(
            NativeTrajectoryPalette.event(record.kind, error: record.isError).opacity(0.12),
            in: RoundedRectangle(cornerRadius: 4)
          )
      }
      .padding(.trailing, 4)
    }
  }

  private var turnLabel: String {
    if record.kind == .compacted, record.turn == nil {
      return ArkL10n.text(.trajectoryBetweenTurns, language)
    }
    if let turn = record.turn {
      return ArkL10n.format(.trajectoryTurn, language, arguments: ["\(turn)"])
    }
    return group.title
  }

  private var hasFollowingCalls: Bool {
    record.kind == .message && group.records.contains {
      ($0.kind == .tool || $0.kind == .subtool) && $0.sequence > record.sequence
    }
  }
}

private struct NativeTrajectorySpan: Equatable {
  let recordID: String
  let kind: ArkTrajectorySemanticKind
  let start: Double
  let end: Double
  let isError: Bool
  let title: String
}

private enum NativeTrajectoryTimelineMath {
  static func spans(
    records: [ArkTrajectorySemanticRecord],
    actualDuration: Bool
  ) -> [NativeTrajectorySpan] {
    guard !records.isEmpty else { return [] }
    if !actualDuration {
      let count = Double(records.count)
      return records.enumerated().map { index, record in
        NativeTrajectorySpan(
          recordID: record.id,
          kind: record.kind,
          start: Double(index) / count,
          end: Double(index + 1) / count,
          isError: record.isError,
          title: record.title
        )
      }
    }
    let first = records.map(\ .time.timeIntervalSinceReferenceDate).min() ?? 0
    let last = records.map {
      ($0.completedAt ?? $0.time).timeIntervalSinceReferenceDate
    }.max() ?? first
    let span = max(last - first, 0.001)
    return records.map { record in
      let start = (record.time.timeIntervalSinceReferenceDate - first) / span
      let end = ((record.completedAt ?? record.time).timeIntervalSinceReferenceDate - first) / span
      return NativeTrajectorySpan(
        recordID: record.id,
        kind: record.kind,
        start: min(max(start, 0), 1),
        end: min(max(end, start), 1),
        isError: record.isError,
        title: record.title
      )
    }
  }
}

private struct NativeTrajectoryOverview: NSViewRepresentable {
  let records: [ArkTrajectorySemanticRecord]
  let actualDuration: Bool
  let selectedRecordID: String?
  @Binding var range: ArkTrajectoryTimeRange?
  @Binding var viewport: ArkTrajectoryViewportState
  let hasEarlierRecords: Bool
  let loadingEarlierRecords: Bool
  let language: ArkLanguagePreference
  let onLoadEarlier: () -> Void
  let onSelect: (String) -> Void

  func makeNSView(context: Context) -> NativeTrajectoryOverviewView {
    let view = NativeTrajectoryOverviewView()
    view.onRange = { range = $0 }
    view.onViewport = { viewport = $0 }
    view.onSelect = onSelect
    view.onLoadEarlier = onLoadEarlier
    return view
  }

  func updateNSView(_ nsView: NativeTrajectoryOverviewView, context: Context) {
    nsView.spans = NativeTrajectoryTimelineMath.spans(
      records: records,
      actualDuration: actualDuration
    )
    nsView.selectedRecordID = selectedRecordID
    nsView.range = range
    nsView.viewport = viewport
    nsView.hasEarlierRecords = hasEarlierRecords
    nsView.loadingEarlierRecords = loadingEarlierRecords
    nsView.language = language
    nsView.onLoadEarlier = onLoadEarlier
    nsView.needsDisplay = true
  }
}

@MainActor
private final class NativeTrajectoryOverviewView: NSView {
  var spans: [NativeTrajectorySpan] = []
  var selectedRecordID: String?
  var range: ArkTrajectoryTimeRange?
  var viewport = ArkTrajectoryViewportState()
  var hasEarlierRecords = false
  var loadingEarlierRecords = false
  var language: ArkLanguagePreference = .zh
  var onRange: ((ArkTrajectoryTimeRange?) -> Void)?
  var onViewport: ((ArkTrajectoryViewportState) -> Void)?
  var onSelect: ((String) -> Void)?
  var onLoadEarlier: (() -> Void)?

  private let labelWidth: CGFloat = 44
  private var leftDragStart: Double?
  private var leftDragStartPoint: NSPoint?
  private var rightDragStartX: CGFloat?
  private var rightDragOrigin: Double?
  private var rightDragged = false
  private var hoveredRecordID: String?
  private var trackingAreaReference: NSTrackingArea?
  private var earlierControlRect = NSRect.zero

  override var isFlipped: Bool { true }
  override var acceptsFirstResponder: Bool { true }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let trackingAreaReference { removeTrackingArea(trackingAreaReference) }
    let tracking = NSTrackingArea(
      rect: bounds,
      options: [.activeInKeyWindow, .mouseMoved, .mouseEnteredAndExited, .inVisibleRect],
      owner: self,
      userInfo: nil
    )
    addTrackingArea(tracking)
    trackingAreaReference = tracking
  }

  override func draw(_ dirtyRect: NSRect) {
    super.draw(dirtyRect)
    NSColor.controlBackgroundColor.setFill()
    dirtyRect.fill()

    drawLabels()
    drawPlotBackground()
    drawEarlierControl()
    drawRange()
    drawSpans()
  }

  override func mouseMoved(with event: NSEvent) {
    let point = convert(event.locationInWindow, from: nil)
    hoveredRecordID = hitSpan(at: point)?.recordID
    toolTip = hitSpan(at: point)?.title
    needsDisplay = true
  }

  override func mouseExited(with event: NSEvent) {
    hoveredRecordID = nil
    toolTip = nil
    needsDisplay = true
  }

  override func mouseDown(with event: NSEvent) {
    window?.makeFirstResponder(self)
    let point = convert(event.locationInWindow, from: nil)
    guard point.x >= labelWidth else { return }
    if earlierControlRect.contains(point), hasEarlierRecords, !loadingEarlierRecords {
      onLoadEarlier?()
      return
    }
    if let hit = hitSpan(at: point) {
      onRange?(nil)
      onSelect?(hit.recordID)
      return
    }
    leftDragStartPoint = point
    let fraction = absoluteFraction(at: point.x)
    leftDragStart = fraction
    onRange?(ArkTrajectoryTimeRange(start: fraction, end: fraction))
  }

  override func mouseDragged(with event: NSEvent) {
    guard let leftDragStart else { return }
    let point = convert(event.locationInWindow, from: nil)
    onRange?(ArkTrajectoryTimeRange(start: leftDragStart, end: absoluteFraction(at: point.x)))
  }

  override func mouseUp(with event: NSEvent) {
    defer {
      leftDragStart = nil
      leftDragStartPoint = nil
    }
    guard let start = leftDragStart, let startPoint = leftDragStartPoint else { return }
    let point = convert(event.locationInWindow, from: nil)
    if abs(point.x - startPoint.x) < 3 {
      onRange?(nil)
    } else {
      onRange?(ArkTrajectoryTimeRange(start: start, end: absoluteFraction(at: point.x)))
    }
  }

  override func rightMouseDown(with event: NSEvent) {
    let point = convert(event.locationInWindow, from: nil)
    guard point.x >= labelWidth else { return }
    rightDragStartX = point.x
    rightDragOrigin = viewport.origin
    rightDragged = false
  }

  override func rightMouseDragged(with event: NSEvent) {
    guard viewport.zoom > 1, let startX = rightDragStartX, let startOrigin = rightDragOrigin else {
      return
    }
    let point = convert(event.locationInWindow, from: nil)
    let width = max(bounds.width - labelWidth, 1)
    let delta = Double((startX - point.x) / width) * viewport.visibleLength
    var next = viewport
    next.pan(by: startOrigin - viewport.origin + delta)
    viewport = next
    onViewport?(next)
    rightDragged = rightDragged || abs(point.x - startX) >= 3
    needsDisplay = true
  }

  override func rightMouseUp(with event: NSEvent) {
    if !rightDragged { onRange?(nil) }
    rightDragStartX = nil
    rightDragOrigin = nil
    rightDragged = false
  }

  override func scrollWheel(with event: NSEvent) {
    let point = convert(event.locationInWindow, from: nil)
    guard point.x >= labelWidth else { return }
    let plotWidth = max(bounds.width - labelWidth, 1)
    let anchor = Double((point.x - labelWidth) / plotWidth)
    var next = viewport
    next.zoom(by: exp(-Double(event.scrollingDeltaY) * 0.012), around: anchor)
    viewport = next
    onViewport?(next)
    needsDisplay = true
  }

  override func keyDown(with event: NSEvent) {
    if event.keyCode == 53 {
      onRange?(nil)
      return
    }
    super.keyDown(with: event)
  }

  override func menu(for event: NSEvent) -> NSMenu? { nil }

  private func drawLabels() {
    let labels = [
      ArkL10n.text(.fieldInput, language),
      "LLM",
      ArkL10n.text(.trajectoryKindTool, language),
    ]
    let attributes: [NSAttributedString.Key: Any] = [
      .font: NSFont.systemFont(ofSize: 10),
      .foregroundColor: NSColor.tertiaryLabelColor,
    ]
    for (lane, label) in labels.enumerated() {
      let size = label.size(withAttributes: attributes)
      label.draw(
        at: NSPoint(
          x: labelWidth - size.width - 3,
          y: laneY(lane) - size.height / 2
        ),
        withAttributes: attributes
      )
    }
    NSColor.separatorColor.setFill()
    NSRect(x: labelWidth - 1, y: 0, width: 1, height: bounds.height).fill()
  }

  private func drawPlotBackground() {
    NSColor.windowBackgroundColor.withAlphaComponent(0.45).setFill()
    NSRect(x: labelWidth, y: 0, width: max(0, bounds.width - labelWidth), height: bounds.height).fill()
  }

  private func drawEarlierControl() {
    earlierControlRect = .zero
    guard hasEarlierRecords, viewport.origin <= 0.000_001 else { return }
    let rect = NSRect(x: labelWidth + 4, y: 3, width: 18, height: bounds.height - 6)
    earlierControlRect = rect
    let path = NSBezierPath(roundedRect: rect, xRadius: 5, yRadius: 5)
    NSColor.secondaryLabelColor.withAlphaComponent(0.16).setFill()
    path.fill()
    let text = loadingEarlierRecords ? "↑" : "…"
    let attributes: [NSAttributedString.Key: Any] = [
      .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
      .foregroundColor: NSColor.secondaryLabelColor,
    ]
    let size = text.size(withAttributes: attributes)
    text.draw(
      at: NSPoint(x: rect.midX - size.width / 2, y: rect.midY - size.height / 2),
      withAttributes: attributes
    )
  }

  private func drawRange() {
    guard let range else { return }
    let x1 = plotX(for: range.start)
    let x2 = plotX(for: range.end)
    let rect = NSRect(x: min(x1, x2), y: 0, width: max(abs(x2 - x1), 1), height: bounds.height)
    NSColor.controlAccentColor.withAlphaComponent(0.12).setFill()
    rect.fill()
    NSColor.controlAccentColor.setFill()
    NSRect(x: rect.minX, y: 0, width: 2, height: bounds.height).fill()
    NSRect(x: rect.maxX - 2, y: 0, width: 2, height: bounds.height).fill()
  }

  private func drawSpans() {
    for span in spans {
      let start = plotX(for: span.start)
      let end = plotX(for: span.end)
      guard end >= labelWidth, start <= bounds.maxX else { continue }
      let width = max(end - start - 1, 2)
      let rect = NSRect(x: start + 0.5, y: laneY(span.kind.lane) - 4, width: width, height: 8)
      color(for: span).setFill()
      NSBezierPath(roundedRect: rect, xRadius: 1.5, yRadius: 1.5).fill()
      if span.recordID == selectedRecordID || span.recordID == hoveredRecordID {
        NSColor.windowBackgroundColor.setStroke()
        let border = NSBezierPath(roundedRect: rect.insetBy(dx: -1.5, dy: -1.5), xRadius: 2, yRadius: 2)
        border.lineWidth = 1
        border.stroke()
        NSColor.controlAccentColor.setStroke()
        let accent = NSBezierPath(roundedRect: rect.insetBy(dx: -2.5, dy: -2.5), xRadius: 2.5, yRadius: 2.5)
        accent.lineWidth = 1
        accent.stroke()
      }
    }
  }

  private func color(for span: NativeTrajectorySpan) -> NSColor {
    if span.isError { return .systemRed }
    switch span.kind {
    case .user: return .controlAccentColor
    case .context: return .systemGreen
    case .message: return .systemPurple
    case .tool: return .systemOrange
    case .subtool: return NSColor.systemOrange.withAlphaComponent(0.72)
    case .system, .compacted: return .secondaryLabelColor
    }
  }

  private func laneY(_ lane: Int) -> CGFloat { 11 + CGFloat(lane) * 14 }

  private func plotX(for absolute: Double) -> CGFloat {
    let width = max(bounds.width - labelWidth, 1)
    return labelWidth + CGFloat(viewport.viewportFraction(for: absolute)) * width
  }

  private func absoluteFraction(at x: CGFloat) -> Double {
    let width = max(bounds.width - labelWidth, 1)
    let viewportFraction = Double(min(max((x - labelWidth) / width, 0), 1))
    return viewport.absoluteFraction(for: viewportFraction)
  }

  private func hitSpan(at point: NSPoint) -> NativeTrajectorySpan? {
    guard point.x >= labelWidth else { return nil }
    return spans.reversed().first { span in
      let x1 = plotX(for: span.start)
      let x2 = plotX(for: span.end)
      let rect = NSRect(
        x: x1 - 2,
        y: laneY(span.kind.lane) - 7,
        width: max(x2 - x1, 2) + 4,
        height: 14
      )
      return rect.contains(point)
    }
  }
}

private struct NativeTrajectoryInspector: View {
  let model: ArkAppModel
  let record: ArkTrajectorySemanticRecord
  let language: ArkLanguagePreference
  let close: () -> Void
  @State private var tab: NativeTrajectoryDetailTab = .summary
  @State private var copied = false

  private var tabs: [NativeTrajectoryDetailTab] {
    NativeTrajectoryDetailTab.allCases.filter { tab in
      switch tab {
      case .input: return record.input?.isEmpty == false
      case .output: return record.output?.isEmpty == false
      case .summary, .source: return true
      }
    }
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        Circle()
          .fill(NativeTrajectoryPalette.event(record.kind, error: record.isError))
          .frame(width: 5, height: 5)
        Text(record.title)
          .font(.system(size: 12, weight: .medium, design: .monospaced))
          .lineLimit(1)
        Text(record.location(language))
          .font(.system(size: 11, design: .monospaced))
          .foregroundStyle(NativeTrajectoryPalette.tertiary)
          .lineLimit(1)
        Spacer()
        Button(action: close) {
          Image(systemName: "xmark")
            .frame(width: 28, height: 28)
        }
        .buttonStyle(.plain)
        .help(ArkL10n.text(.closeDetail, language))
      }
      .padding(.leading, 12)
      .padding(.trailing, 8)
      .frame(height: 42)
      .background(NativeTrajectoryPalette.panel)
      .overlay(alignment: .bottom) { Divider().overlay(NativeTrajectoryPalette.separator) }

      HStack(spacing: 1) {
        ForEach(tabs) { candidate in
          Button {
            tab = candidate
          } label: {
            Text(candidate.title(language))
              .frame(minWidth: 44, minHeight: 30)
          }
            .buttonStyle(NativeTrajectoryDetailTabButtonStyle(active: tab == candidate))
        }
        Spacer()
        if tab == .source {
          Button(copied ? ArkL10n.text(.copiedJSON, language) : ArkL10n.text(.copyJSON, language), action: copyJSON)
            .buttonStyle(.borderless)
            .font(.system(size: 10))
        }
      }
      .padding(.horizontal, 8)
      .frame(height: 34)
      .overlay(alignment: .bottom) { Divider().overlay(NativeTrajectoryPalette.separator) }

      if tab == .source {
        // 原始 JSON 走 TextKit 2 大文本查看器（有界视口 + 懒排版），
        // 不再放进外层 ScrollView 与整段 Text 布局。
        NativeRawJSONTextView(text: ArkTrajectoryProjection.detailJSON(for: record))
          .padding(10)
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
          .background(NativeTrajectoryPalette.background, in: RoundedRectangle(cornerRadius: 8))
          .overlay(RoundedRectangle(cornerRadius: 8).stroke(NativeTrajectoryPalette.separator))
      } else {
        ScrollView(.vertical) {
          detailBody
            .frame(maxWidth: .infinity, minHeight: 1, alignment: .topLeading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      }
    }
    .background(NativeTrajectoryPalette.panel)
    .onChange(of: record.id) { _ in
      tab = .summary
      copied = false
    }
  }

  @ViewBuilder
  private var detailBody: some View {
    switch tab {
    case .summary:
      VStack(alignment: .leading, spacing: 0) {
        detail(ArkL10n.text(.fieldState, language), record.isError
          ? ArkL10n.text(.trajectoryError, language)
          : record.completedAt == nil
            ? ArkL10n.text(.trajectoryRunning, language)
            : ArkL10n.text(.trajectoryCompleted, language))
        detail(ArkL10n.text(.fieldSequence, language), "#\(record.sequence)–#\(record.endSequence)")
        detail(ArkL10n.text(.fieldStarted, language), ArkTrajectoryFormat.iso.string(from: record.time))
        detail(ArkL10n.text(.fieldDuration, language), record.durationMs.map(ArkTrajectoryFormat.duration) ?? ArkL10n.text(.trajectoryPending, language))
        if let provider = record.provider { detail(ArkL10n.text(.fieldProvider, language), provider) }
        if let model = record.model { detail(ArkL10n.text(.fieldModel, language), model) }
        if let usage = record.usage {
          Divider().padding(.vertical, 6)
          Text(ArkL10n.text(.fieldThisRequest, language))
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(NativeTrajectoryPalette.secondary)
            .padding(.horizontal, 14)
            .padding(.bottom, 3)
          if let input = usage.input { detail(ArkL10n.text(.fieldInput, language), "\(input) tok") }
          if let cached = usage.cacheRead { detail(ArkL10n.text(.fieldCached, language), "\(cached) tok") }
          if let created = usage.cacheWrite { detail(ArkL10n.text(.fieldCacheCreated, language), "\(created) tok") }
          if let output = usage.output { detail(ArkL10n.text(.fieldOutput, language), "\(output) tok") }
          if let reasoning = usage.reasoning { detail(ArkL10n.text(.fieldReasoning, language), "\(reasoning) tok") }
        }
        if let retry = record.retry {
          Divider().padding(.vertical, 6)
          detail(ArkL10n.text(.fieldRetry, language), retry.summary(language))
        }
        if let compaction = record.compaction { detail(ArkL10n.text(.fieldCompaction, language), compaction) }
        if !record.attachmentIDs.isEmpty {
          Divider().padding(.vertical, 6)
          Label(
            ArkL10n.format(
              .trajectoryImages,
              language,
              arguments: ["\(record.attachmentIDs.count)"]
            ),
            systemImage: "photo.on.rectangle"
          )
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(NativeTrajectoryPalette.secondary)
          .padding(.horizontal, 14)
          .padding(.bottom, 6)
          NativeMessageImages(model: model, attachmentIDs: record.attachmentIDs)
            .padding(.horizontal, 14)
            .padding(.bottom, 8)
        }
        if !record.preview.isEmpty {
          Divider().padding(.vertical, 8)
          Text(record.preview)
            .font(.system(size: 12))
            .textSelection(.enabled)
            .padding(.horizontal, 14)
            .padding(.bottom, 14)
        }
      }
      .padding(.top, 8)
    case .input:
      payload(readablePayload(
        record.input ?? ArkL10n.text(.trajectoryInputMissing, language),
        kind: ArkL10n.text(.trajectoryInputSummary, language)
      ))
    case .output:
      payload(readablePayload(
        record.output ?? ArkL10n.text(.trajectoryOutputMissing, language),
        kind: ArkL10n.text(.trajectoryOutputSummary, language)
      ))
    case .source:
      // 由外层直接挂载 NativeRawJSONTextView（TextKit 2 懒排版），此处不可达。
      EmptyView()
    }
  }

  private func detail(_ label: String, _ value: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Text(label)
        .foregroundStyle(NativeTrajectoryPalette.tertiary)
        .frame(width: 94, alignment: .leading)
      Text(value)
        .foregroundStyle(record.isError && label == "State" ? Color.red : NativeTrajectoryPalette.primary)
        .textSelection(.enabled)
      Spacer(minLength: 0)
    }
    .font(.system(size: 11, design: .monospaced))
    .padding(.horizontal, 14)
    .frame(minHeight: 22)
  }

  private func payload(_ text: String) -> some View {
    Text(text)
      .font(.system(size: 12, design: .monospaced))
      .foregroundStyle(NativeTrajectoryPalette.primary)
      .textSelection(.enabled)
      .fixedSize(horizontal: false, vertical: true)
      .padding(14)
      .frame(maxWidth: .infinity, alignment: .topLeading)
      .background(NativeTrajectoryPalette.background, in: RoundedRectangle(cornerRadius: 8))
      .overlay(RoundedRectangle(cornerRadius: 8).stroke(NativeTrajectoryPalette.separator))
      .padding(10)
  }

  private func readablePayload(_ text: String, kind: String) -> String {
    let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    if text.contains("<available_skills>") || text.contains("<system-reminder>") {
      let skills = lines.filter {
        $0.trimmingCharacters(in: .whitespaces).hasPrefix("- `")
      }.count
      let skillSummary = skills > 0 ? "已注入 \(skills) 个可用技能。" : "已注入系统与技能上下文。"
      return "\(kind)\n\n系统上下文\n\(skillSummary)\n完整技能清单与原始内容已收纳到“原始 JSON”，避免在输入页铺满整段系统提示。"
    }
    let maximumCharacters = 1_600
    guard text.count > maximumCharacters || lines.count > 48 else {
      return "\(kind)\n\n\(text)"
    }
    let prefix = String(text.prefix(maximumCharacters))
    return "\(kind)\n\n\(prefix)\n\n… 已折叠 \(max(0, text.count - prefix.count)) 个字符；完整内容请查看“原始 JSON”。"
  }

  private func copyJSON() {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(
      ArkTrajectoryProjection.detailJSON(for: record),
      forType: .string
    )
    copied = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { copied = false }
  }
}

private struct NativeTrajectoryDetailTabButtonStyle: ButtonStyle {
  let active: Bool

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 11))
      .foregroundStyle(active ? Color.accentColor : NativeTrajectoryPalette.tertiary)
      .padding(.horizontal, 9)
      .frame(height: 34)
      .contentShape(Rectangle())
      .background(configuration.isPressed ? NativeTrajectoryPalette.raised : Color.clear)
      .overlay(alignment: .bottom) {
        if active { Rectangle().fill(Color.accentColor).frame(height: 2) }
      }
  }
}
