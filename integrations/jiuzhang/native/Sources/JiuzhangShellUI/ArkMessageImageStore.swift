import Combine
import Foundation

public enum ArkMessageImageLoadState: Equatable, Sendable {
  case idle
  case loading
  case loaded
  case cancelled
  case failed(String)
}

/// Session-scoped owner for authorized historical image bytes.
///
/// One attachment has at most one in-flight load. Session changes cancel every
/// task and clear bytes so an attachment id can never leak across sessions.
@MainActor
public final class ArkMessageImageStore: ObservableObject {
  public typealias Loader = @Sendable (_ sessionID: String, _ attachmentID: String) async throws -> Data

  @Published public private(set) var states: [String: ArkMessageImageLoadState] = [:]

  private let loader: Loader
  private var sessionID: String?
  private var dataByAttachmentID: [String: Data] = [:]
  private var tasks: [String: Task<Void, Never>] = [:]
  private var attemptTokens: [String: UInt64] = [:]
  private var nextAttemptToken: UInt64 = 0

  public init(loader: @escaping Loader) {
    self.loader = loader
  }

  deinit {
    for task in tasks.values { task.cancel() }
  }

  public func configure(sessionID: String?) {
    guard self.sessionID != sessionID else { return }
    for task in tasks.values { task.cancel() }
    tasks.removeAll()
    attemptTokens.removeAll()
    states.removeAll()
    dataByAttachmentID.removeAll()
    self.sessionID = sessionID
  }

  public func state(for attachmentID: String) -> ArkMessageImageLoadState {
    states[attachmentID] ?? .idle
  }

  public func data(for attachmentID: String) -> Data? {
    dataByAttachmentID[attachmentID]
  }

  public func load(_ attachmentID: String) {
    guard let sessionID, !attachmentID.isEmpty else { return }
    switch state(for: attachmentID) {
    case .loading, .loaded: return
    case .idle, .cancelled, .failed: break
    }

    nextAttemptToken &+= 1
    let token = nextAttemptToken
    let loader = self.loader
    attemptTokens[attachmentID] = token
    states[attachmentID] = .loading
    tasks[attachmentID] = Task { [weak self] in
      do {
        let data = try await loader(sessionID, attachmentID)
        try Task.checkCancellation()
        guard let self, self.accepts(attachmentID: attachmentID, token: token) else { return }
        self.dataByAttachmentID[attachmentID] = data
        self.states[attachmentID] = .loaded
        self.finish(attachmentID: attachmentID, token: token)
      } catch is CancellationError {
        guard let self, self.accepts(attachmentID: attachmentID, token: token) else { return }
        self.states[attachmentID] = .idle
        self.finish(attachmentID: attachmentID, token: token)
      } catch {
        guard let self, self.accepts(attachmentID: attachmentID, token: token) else { return }
        self.dataByAttachmentID.removeValue(forKey: attachmentID)
        self.states[attachmentID] = .failed(error.localizedDescription)
        self.finish(attachmentID: attachmentID, token: token)
      }
    }
  }

  public func retry(_ attachmentID: String) {
    cancel(attachmentID)
    load(attachmentID)
  }

  public func cancel(_ attachmentID: String) {
    attemptTokens.removeValue(forKey: attachmentID)
    tasks.removeValue(forKey: attachmentID)?.cancel()
    dataByAttachmentID.removeValue(forKey: attachmentID)
    states[attachmentID] = .cancelled
  }

  private func accepts(attachmentID: String, token: UInt64) -> Bool {
    attemptTokens[attachmentID] == token
  }

  private func finish(attachmentID: String, token: UInt64) {
    guard accepts(attachmentID: attachmentID, token: token) else { return }
    attemptTokens.removeValue(forKey: attachmentID)
    tasks.removeValue(forKey: attachmentID)
  }
}
