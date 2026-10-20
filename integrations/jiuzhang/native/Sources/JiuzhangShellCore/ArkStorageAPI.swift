import Foundation

/// Operational persistence state; message contents and backend exception text never cross this API.
public struct ArkStorageState: Equatable, Sendable {
  public enum WritePhase: String, Sendable { case healthy, pressured, failed, closing }
  public enum QuitPhase: String, Sendable { case stopping, saving, ready, failed }
  public enum ErrorCode: String, Sendable { case writeFailed = "storage-write-failed", stalled = "storage-stalled" }

  public struct Write: Equatable, Sendable {
    public let phase: WritePhase
    public let events: Int
    public let bytes: Int
    public let totalEvents: Int
    public let totalBytes: Int
    public let oldestAt: Double?
    public let lastSuccessAt: Double?
    public let waitTimeoutMs: Int
    public let errorCode: ErrorCode?
  }

  public struct Quit: Equatable, Sendable {
    public let attemptID: String
    public let phase: QuitPhase
    public let safeToQuit: Bool
    public let errorCode: ErrorCode?
  }

  public let write: Write
  public let retrying: Bool
  public let quitEpoch: Int
  public let quit: Quit?

  /// A matching Host acknowledgement and empty write queue are both required before teardown.
  public func permitsQuit(attemptID: String, epoch: Int) -> Bool {
    quitEpoch == epoch && quit?.attemptID == attemptID && quit?.phase == .ready && quit?.safeToQuit == true
      && write.totalEvents == 0 && write.totalBytes == 0
  }

  public static func decode(_ value: JSONValue) throws -> Self {
    func invalid() -> ArkAPIError {
      ArkAPIError(message: "本机服务返回了无效的保存状态", code: "invalid-storage-response")
    }
    func integer(_ value: JSONValue?, positive: Bool = false) throws -> Int {
      guard let n = value?.numberValue, n.isFinite, n.rounded(.towardZero) == n,
            n >= (positive ? 1 : 0), n <= 9_007_199_254_740_991, let result = Int(exactly: n)
      else { throw invalid() }
      return result
    }
    func timestamp(_ value: JSONValue?) throws -> Double? {
      if value == .null { return nil }
      _ = try integer(value)
      return value?.numberValue
    }
    func errorCode(_ value: JSONValue?) throws -> ErrorCode? {
      if value == .null { return nil }
      guard let raw = value?.stringValue, let code = ErrorCode(rawValue: raw) else { throw invalid() }
      return code
    }
    guard let raw = value["write"], let phaseName = raw["phase"]?.stringValue,
          let phase = WritePhase(rawValue: phaseName), let retrying = value["retrying"]?.boolValue
    else { throw invalid() }
    let write = try Write(phase: phase, events: integer(raw["events"]), bytes: integer(raw["bytes"]),
      totalEvents: integer(raw["totalEvents"]), totalBytes: integer(raw["totalBytes"]),
      oldestAt: timestamp(raw["oldestAt"]), lastSuccessAt: timestamp(raw["lastSuccessAt"]),
      waitTimeoutMs: integer(raw["waitTimeoutMs"], positive: true), errorCode: errorCode(raw["errorCode"]))
    guard write.events <= write.totalEvents, write.bytes <= write.totalBytes else { throw invalid() }
    let quit: Quit?
    if value["quit"] == .null { quit = nil }
    else {
      guard let rawQuit = value["quit"], let attemptID = rawQuit["attemptId"]?.stringValue, !attemptID.isEmpty,
            let name = rawQuit["phase"]?.stringValue, let quitPhase = QuitPhase(rawValue: name),
            let safe = rawQuit["safeToQuit"]?.boolValue
      else { throw invalid() }
      let code = try errorCode(rawQuit["errorCode"])
      guard code != .stalled, safe == (quitPhase == .ready),
            !safe || (write.totalEvents == 0 && write.totalBytes == 0 && code == nil
              && write.errorCode == nil && write.phase != .failed && write.phase != .pressured)
      else { throw invalid() }
      quit = Quit(attemptID: attemptID, phase: quitPhase, safeToQuit: safe, errorCode: code)
    }
    return try Self(write: write, retrying: retrying, quitEpoch: integer(value["quitEpoch"]), quit: quit)
  }
}

/// Storage actions observe or settle existing writes; they never start a model request.
public enum ArkStorageAction: Sendable {
  case state(sessionID: String? = nil)
  case retrySave
  case prepareQuit(attemptID: String, epoch: Int)
  case cancelQuit(attemptID: String, epoch: Int)

  fileprivate func request() throws -> [String: JSONValue] {
    switch self {
    case .state(let sessionID):
      var result: [String: JSONValue] = ["kind": .string("state")]
      if let sessionID { result["sessionId"] = .string(sessionID) }
      return result
    case .retrySave: return ["kind": .string("retry-save")]
    case .prepareQuit(let attemptID, let epoch), .cancelQuit(let attemptID, let epoch):
      guard !attemptID.isEmpty, epoch >= 0, epoch <= 9_007_199_254_740_991 else {
        throw ArkAPIError(message: "退出请求标识或代次无效")
      }
      let kind: String
      if case .prepareQuit = self { kind = "prepare-quit" } else { kind = "cancel-quit" }
      return ["kind": .string(kind), "attemptId": .string(attemptID), "epoch": .number(Double(epoch))]
    }
  }
}

extension ArkAPIClient {
  /// Send one bounded observation; a transport timeout never proves that saving has completed.
  public func storage(_ action: ArkStorageAction) async throws -> ArkStorageState {
    let result = try await remoteCall(method: "session/storage", args: ["request": .object(action.request())], timeout: 5)
    if result["ok"]?.boolValue == true, let value = result["value"] {
      return try ArkStorageState.decode(value)
    }
    throw ArkAPIError(message: "本机服务未确认保存操作", code: result["error"]?["code"]?.stringValue ?? "invalid-storage-response")
  }
}
