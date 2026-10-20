import Foundation
import CryptoKit
import JiuzhangShellCore

struct ArkCommandActionReceipt {
  let invocationID: String
  let execution: ArkCommandExecution
}

/// One native owner retains transport work and the original durable identity across retries.
@MainActor
final class ArkCommandSubmissionOwner {
  private struct Identity: Hashable {
    let sessionID: String
    let invocationID: String
  }

  private struct Active {
    let token: UUID
    let line: String
    let images: [ArkPromptImage]
    let task: Task<ArkCommandOutcome, Error>
  }

  private let documentStore: ArkDocumentReferenceStore
  private let execute: @Sendable (String, String, [ArkPromptImage], String) async throws -> ArkCommandOutcome
  private var active: [Identity: Active] = [:]
  private var stopped = false

  init(documentStore: ArkDocumentReferenceStore,
    execute: @escaping @Sendable (String, String, [ArkPromptImage], String) async throws -> ArkCommandOutcome) {
    self.documentStore = documentStore
    self.execute = execute
  }

  /// Independent buttons and menu actions share the composer's existing private inflight journal.
  func submitAction(sessionID: String, line: String, parentSubmissionID: String? = nil) async throws -> ArkCommandActionReceipt {
    guard !stopped else { throw ArkAPIError(message: "应用正在停止，命令尚未发送") }
    let prerequisiteID: String?
    if let parentSubmissionID {
      guard UUID(uuidString: parentSubmissionID) != nil else { throw ArkAPIError(message: "前置命令的提交身份无效") }
      let encoded = try JSONEncoder().encode(["ark-command-prerequisite-v1", sessionID, parentSubmissionID, line])
      let bytes = Array(SHA256.hash(data: encoded).prefix(16))
      prerequisiteID = UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15])).uuidString.lowercased()
    } else { prerequisiteID = nil }
    let invocationID = try await documentStore.prepareCommandAction(sessionID: sessionID, line: line,
      invocationID: prerequisiteID)
    let execution = try await submit(sessionID: sessionID, line: line, images: [], invocationID: invocationID)
    return ArkCommandActionReceipt(invocationID: invocationID, execution: execution)
  }

  /// Retire only after the action's native state has been saved or refreshed successfully.
  func acknowledgeAction(_ receipt: ArkCommandActionReceipt) async throws {
    try await documentStore.removeInflightSubmission(receipt.invocationID)
  }

  /// The composer has already persisted this exact payload and retains its journal until success.
  func submitCaptured(sessionID: String, line: String, images: [ArkPromptImage],
    invocationID: String) async throws -> ArkCommandExecution {
    let execution = try await submit(sessionID: sessionID, line: line, images: images, invocationID: invocationID)
    guard execution.result == .success else {
      throw ArkAPIError(message: execution.text ?? "命令执行失败")
    }
    return execution
  }

  private func submit(sessionID: String, line: String, images: [ArkPromptImage], invocationID: String) async throws -> ArkCommandExecution {
    guard !stopped else { throw ArkAPIError(message: "应用正在停止，命令尚未发送；原提交记录已保留") }
    guard UUID(uuidString: invocationID) != nil else { throw ArkAPIError(message: "命令提交身份无效") }
    let identity = Identity(sessionID: sessionID, invocationID: invocationID)
    let operation: Task<ArkCommandOutcome, Error>
    let token: UUID
    if let existing = active[identity] {
      guard existing.line == line, existing.images == images else {
        throw ArkAPIError(message: "同一命令提交身份对应了不同内容，已阻止发送")
      }
      operation = existing.task
      token = existing.token
    } else {
      guard !active.keys.contains(where: { $0.sessionID == sessionID }) else {
        throw ArkAPIError(message: "当前会话已有命令正在发送，请等待其执行回执")
      }
      operation = Task { [execute] in
        try await execute(sessionID, line, images, invocationID)
      }
      token = UUID()
      active[identity] = Active(token: token, line: line, images: images, task: operation)
    }
    defer { if active[identity]?.token == token { active.removeValue(forKey: identity) } }
    let outcome = try await operation.value
    switch outcome {
    case .completed(let execution):
      return execution
    case .running:
      throw ArkCommandUnconfirmedError.running
    case .unknown(_, let reason):
      throw ArkCommandUnconfirmedError.unknown(reason)
    }
  }

  /// Lifecycle teardown may cancel response observation after the Host is safe or already gone.
  /// The journal remains unacknowledged; ordinary caller cancellation does not reach this owner.
  func stop(cancelResponseWaiters: Bool = false) async {
    stopped = true
    let pending = active.values.map(\.task)
    if cancelResponseWaiters { pending.forEach { $0.cancel() } }
    for task in pending { _ = await task.result }
  }
}

enum ArkCommandUnconfirmedError: LocalizedError {
  case running
  case unknown(ArkCommandUnknownReason)

  var errorDescription: String? {
    switch self {
    case .running:
      return "命令仍在执行，草稿和原提交身份已保留；重试仅检查同一次执行"
    case .unknown(.interrupted):
      return "命令执行曾中断，结果未知；原提交身份已保留，不会自动重复执行，请先检查实际状态"
    case .unknown(.durabilityUnconfirmed):
      return "命令回执尚未确认保存，草稿和原提交身份已保留；请重试查询同一次执行"
    }
  }
}
