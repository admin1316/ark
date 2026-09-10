import Foundation

public enum ArkSubagentComposerState: Equatable, Sendable {
  case regular
  case loading
  case oneShot
  case parentUnavailable
  case continuable

  public var canCompose: Bool {
    self == .regular || self == .continuable
  }

  public var canSend: Bool { canCompose }

  public func canStop(sessionRunning: Bool) -> Bool {
    sessionRunning && self != .oneShot && self != .loading
  }
}

public enum ArkSubagentComposerPolicy {
  public static func resolve(
    sessionOrigin: String?,
    mode: String?,
    parentAvailable: Bool?
  ) -> ArkSubagentComposerState {
    guard sessionOrigin == "subagent" else { return .regular }
    guard let mode else { return .loading }
    if mode == "one-shot" { return .oneShot }
    guard mode == "continuable" else { return .loading }
    return parentAvailable == false ? .parentUnavailable : .continuable
  }
}
