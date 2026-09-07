import Foundation
import JiuzhangShellCore

/// Durable goal phases exposed by the Host `goal` projection.
public enum ArkGoalPhase: String, Equatable, Sendable {
  case active
  case paused
  case blocked
  case complete
}

public struct ArkGoalBlockReason: Equatable, Sendable {
  public let code: String
  public let message: String

  public init(code: String, message: String) {
    self.code = code
    self.message = message
  }
}

/// Strict native view of the Host-owned goal projection. Invalid or partial
/// projection data fails closed instead of manufacturing mutation authority.
public struct ArkGoalSnapshot: Equatable, Sendable {
  public let id: String
  public let revision: Int
  public let objective: String
  public let phase: ArkGoalPhase
  public let blockedReason: ArkGoalBlockReason?
  public let maxGoalRounds: Int
  public let roundsStarted: Int

  public init?(projection: JSONValue?) {
    guard
      let goal = projection?["goal"],
      let id = goal["id"]?.stringValue, !id.isEmpty,
      let revision = Self.integer(goal["revision"], minimum: 1),
      let objective = goal["objective"]?.stringValue?
        .trimmingCharacters(in: .whitespacesAndNewlines),
      !objective.isEmpty,
      let phaseValue = goal["phase"]?.stringValue,
      let phase = ArkGoalPhase(rawValue: phaseValue),
      let maxGoalRounds = Self.integer(goal["maxGoalRounds"], minimum: 1),
      let roundsStarted = Self.integer(projection?["roundsStarted"], minimum: 0)
    else { return nil }

    let blockedReason: ArkGoalBlockReason?
    if phase == .blocked {
      guard
        let code = goal["blockedReason"]?["code"]?.stringValue, !code.isEmpty,
        let message = goal["blockedReason"]?["message"]?.stringValue?
          .trimmingCharacters(in: .whitespacesAndNewlines),
        !message.isEmpty
      else { return nil }
      blockedReason = ArkGoalBlockReason(code: code, message: message)
    } else {
      blockedReason = nil
    }

    self.id = id
    self.revision = revision
    self.objective = objective
    self.phase = phase
    self.blockedReason = blockedReason
    self.maxGoalRounds = maxGoalRounds
    self.roundsStarted = roundsStarted
  }

  private static func integer(_ value: JSONValue?, minimum: Int) -> Int? {
    guard
      let number = value?.numberValue,
      number.isFinite,
      number >= Double(minimum),
      number <= Double(Int.max),
      number.rounded() == number
    else { return nil }
    return Int(number)
  }
}

public enum ArkGoalMutation: Equatable, Sendable {
  public enum Method {
    public static let edit = "goal/edit"
    public static let pause = "goal/pause"
    public static let resume = "goal/resume"
    public static let clear = "goal/clear"
  }

  case edit(objective: String)
  case pause
  case resume
  case clear

  /// Build one revision-safe Host request from the exact visible snapshot.
  public func request(sessionID: String, goal: ArkGoalSnapshot) -> ArkGoalMutationRequest? {
    guard !sessionID.isEmpty else { return nil }
    var request: [String: JSONValue] = [
      "ref": .object([
        "id": .string(goal.id),
        "revision": .number(Double(goal.revision)),
      ]),
    ]

    let method: String
    switch self {
    case .edit(let objective):
      let normalized = objective.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !normalized.isEmpty else { return nil }
      method = Method.edit
      request["objective"] = .string(normalized)
    case .pause:
      method = Method.pause
    case .resume:
      method = Method.resume
    case .clear:
      method = Method.clear
    }
    return ArkGoalMutationRequest(
      method: method,
      args: [
        "agentId": .string(sessionID),
        "request": .object(request),
      ]
    )
  }
}

public struct ArkGoalMutationRequest: Equatable, Sendable {
  public let method: String
  public let args: [String: JSONValue]

  public init(method: String, args: [String: JSONValue]) {
    self.method = method
    self.args = args
  }
}
