import Foundation
import JiuzhangShellCore

public enum ArkTokenFormatting {
  public static func compact(_ value: Int) -> String {
    func scaled(_ amount: Double) -> String {
      amount >= 100
        ? String(Int(amount.rounded()))
        : String(Double((amount * 10).rounded()) / 10)
    }
    if value < 1_000 { return String(value) }
    if value < 1_000_000 { return "\(scaled(Double(value) / 1_000))K" }
    return "\(scaled(Double(value) / 1_000_000))M"
  }
}

public struct ArkContextPressure: Equatable, Sendable {
  public let pressureTokens: Int?
  public let projectedTokens: Int?
  public let contextWindow: Int?

  public init?(projection: JSONValue?) {
    guard projection?.objectValue != nil else { return nil }
    pressureTokens = Self.integer(projection?["pressureTokens"], positive: false)
    projectedTokens = Self.integer(projection?["projectedTokens"], positive: false)
    contextWindow = Self.integer(projection?["contextWindow"], positive: true)
  }

  public var occupancy: ArkContextOccupancy? {
    guard let usedTokens = projectedTokens ?? pressureTokens,
          let contextWindow
    else { return nil }
    return ArkContextOccupancy(
      usedTokens: usedTokens,
      contextWindow: contextWindow,
      percent: min(100, Int((Double(usedTokens) / Double(contextWindow) * 100).rounded()))
    )
  }

  private static func integer(_ value: JSONValue?, positive: Bool) -> Int? {
    guard let number = value?.numberValue,
          number.isFinite,
          number.rounded(.towardZero) == number,
          positive ? number > 0 : number >= 0,
          number < Double(Int.max)
    else { return nil }
    return Int(number)
  }
}

public struct ArkContextOccupancy: Equatable, Sendable {
  public let usedTokens: Int
  public let contextWindow: Int
  public let percent: Int

  public init(usedTokens: Int, contextWindow: Int, percent: Int) {
    self.usedTokens = usedTokens
    self.contextWindow = contextWindow
    self.percent = percent
  }
}

public struct ArkContextBreakdown: Equatable, Sendable {
  public let systemTokens: Int
  public let toolsTokens: Int
  public let messageTokens: Int

  public init?(projection: JSONValue?) {
    guard let systemTokens = Self.integer(projection?["systemTokens"]),
          let toolsTokens = Self.integer(projection?["toolsTokens"]),
          let messageTokens = Self.integer(projection?["messageTokens"])
    else { return nil }
    self.systemTokens = systemTokens
    self.toolsTokens = toolsTokens
    self.messageTokens = messageTokens
  }

  public var total: Int { systemTokens + toolsTokens + messageTokens }

  private static func integer(_ value: JSONValue?) -> Int? {
    guard let number = value?.numberValue,
          number.isFinite,
          number >= 0,
          number.rounded(.towardZero) == number,
          number < Double(Int.max)
    else { return nil }
    return Int(number)
  }
}

public enum ArkContextRole: String, Equatable, Sendable {
  case inject
  case recall
}

public enum ArkContextForm: String, CaseIterable, Equatable, Sendable {
  case instructions
  case catalog
  case snapshot
  case notice
  case relay
  case recall
}

public struct ArkContextProvenance: Equatable, Sendable {
  public let role: ArkContextRole
  public let label: String?
  public let form: ArkContextForm?

  public init(role: ArkContextRole, label: String?, form: ArkContextForm?) {
    self.role = role
    self.label = label
    self.form = form
  }

  public static func project(source: JSONValue?) -> Self {
    guard let source = source?.objectValue,
          let kind = nonempty(source["kind"]?.stringValue)
    else { return Self(role: .inject, label: nil, form: nil) }

    let role: ArkContextRole = kind == "session-reference" ? .recall : .inject
    let label: String? = switch kind {
    case "session-reference": joined(collect(source["references"], field: "label")) ?? kind
    case "agent-instructions": joined(collect(source["changes"], field: "path")) ?? kind
    case "plugin": nonempty(source["plugin"]?.stringValue) ?? kind
    case "skill-invocation": nonempty(source["name"]?.stringValue) ?? kind
    default: kind
    }
    let form = source["form"]?.stringValue.flatMap(ArkContextForm.init(rawValue:))
    return Self(role: role, label: label, form: form)
  }

  private static func collect(_ value: JSONValue?, field: String) -> [String] {
    var seen = Set<String>()
    return value?.arrayValue?.compactMap { nonempty($0[field]?.stringValue) }
      .filter { seen.insert($0).inserted } ?? []
  }

  private static func joined(_ values: [String]) -> String? {
    values.isEmpty ? nil : values.joined(separator: ", ")
  }

  private static func nonempty(_ value: String?) -> String? {
    guard let value, !value.isEmpty else { return nil }
    return value
  }
}
