import Foundation

/// One server-to-native event stream exposed by the Ark loopback service.
public enum ArkEventChannel: String, CaseIterable, Hashable, Sendable {
  case mux
  case host
}

/// User-visible health of one independent event downlink.
public enum ArkEventConnectionState: String, Equatable, Sendable {
  case connecting
  case connected
  case degraded
}

/// One validated server-request received from an Ark event stream.
public struct ArkEventFrame: Equatable, Sendable {
  public let channel: ArkEventChannel
  public let rpcID: String
  public let method: String
  public let payload: JSONValue

  public init(channel: ArkEventChannel, rpcID: String, method: String, payload: JSONValue) {
    self.channel = channel
    self.rpcID = rpcID
    self.method = method
    self.payload = payload
  }
}

/// Invalid endpoint or downstream data observed by ``ArkEventPump``.
public enum ArkEventPumpError: Error, Equatable, Sendable {
  case invalidBaseURL
  case binaryFrame
  case malformedEnvelope
  case unexpectedMethod(channel: ArkEventChannel, method: String)
  case invalidSequence(method: String)
}

/// A single-consumer bounded mailbox. Producers suspend at capacity instead of
/// dropping approval, question, lifecycle, or durable session events while the
/// MainActor is busy rendering a large conversation.
actor ArkEventMailbox<Element: Sendable> {
  private struct PendingProducer {
    let element: Element
    let continuation: CheckedContinuation<Bool, Never>
  }

  private let capacity: Int
  private var buffer: [Element] = []
  private var bufferHead = 0
  private var pendingProducers: [PendingProducer] = []
  private var waitingConsumer: CheckedContinuation<Element?, Never>?
  private var finished = false

  init(capacity: Int) {
    precondition(capacity > 0, "Ark event mailbox capacity must be positive")
    self.capacity = capacity
    buffer.reserveCapacity(capacity)
  }

  func send(_ element: Element) async -> Bool {
    guard !finished else { return false }
    if let consumer = waitingConsumer {
      waitingConsumer = nil
      consumer.resume(returning: element)
      return true
    }
    compactBufferIfNeeded()
    if buffer.count - bufferHead < capacity {
      buffer.append(element)
      return true
    }
    return await withCheckedContinuation { continuation in
      pendingProducers.append(PendingProducer(element: element, continuation: continuation))
    }
  }

  func next() async -> Element? {
    if bufferHead < buffer.count {
      let element = buffer[bufferHead]
      bufferHead += 1
      refillFromWaitingProducer()
      compactBufferIfNeeded()
      return element
    }
    guard !finished else { return nil }
    precondition(waitingConsumer == nil, "Ark event mailbox supports one consumer")
    return await withCheckedContinuation { continuation in
      waitingConsumer = continuation
    }
  }

  func finish() {
    guard !finished else { return }
    finished = true
    buffer.removeAll(keepingCapacity: false)
    bufferHead = 0
    waitingConsumer?.resume(returning: nil)
    waitingConsumer = nil
    let producers = pendingProducers
    pendingProducers.removeAll(keepingCapacity: false)
    for producer in producers { producer.continuation.resume(returning: false) }
  }

  func counts() -> (buffered: Int, waitingProducers: Int) {
    (buffer.count - bufferHead, pendingProducers.count)
  }

  private func refillFromWaitingProducer() {
    guard !pendingProducers.isEmpty, !finished else { return }
    let producer = pendingProducers.removeFirst()
    buffer.append(producer.element)
    producer.continuation.resume(returning: true)
  }

  private func compactBufferIfNeeded() {
    guard bufferHead > 0,
          bufferHead >= 256 || bufferHead * 2 >= buffer.count
    else { return }
    buffer.removeFirst(bufferHead)
    bufferHead = 0
  }
}

/// Pumps both authenticated Ark WebSocket downlinks into one bounded native event mailbox.
public actor ArkEventPump {
  private enum Lifecycle {
    case idle
    case running
    case stopping
    case stopped
  }

  private static let initialReconnectDelayNanoseconds: UInt64 = 250_000_000
  private static let maximumReconnectDelayNanoseconds: UInt64 = 8_000_000_000
  private static let stableConnectionNanoseconds: UInt64 = 5_000_000_000

  private let baseURL: URL
  private let apiToken: String
  private let session: URLSession
  private let mailbox = ArkEventMailbox<ArkEventFrame>(capacity: 4_096)
  private var lifecycle = Lifecycle.idle
  private var pumps: [ArkEventChannel: Task<Void, Never>] = [:]
  private var sockets: [ArkEventChannel: URLSessionWebSocketTask] = [:]
  private var stopTask: Task<Void, Never>?

  public init(baseURL: URL, apiToken: String, session: URLSession = .shared) {
    self.baseURL = baseURL
    self.apiToken = apiToken
    self.session = session
  }

  /// Await the next validated event, or nil after terminal shutdown.
  public func nextEvent() async -> ArkEventFrame? {
    await mailbox.next()
  }

  /// Convert the HTTP RPC base URL into one WebSocket downlink URL.
  public static func eventURL(baseURL: URL, channel: ArkEventChannel) throws -> URL {
    let endpoint = baseURL
      .appendingPathComponent("api")
      .appendingPathComponent("events")
      .appendingPathComponent(channel.rawValue)
    guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else {
      throw ArkEventPumpError.invalidBaseURL
    }
    switch components.scheme?.lowercased() {
    case "http": components.scheme = "ws"
    case "https": components.scheme = "wss"
    default: throw ArkEventPumpError.invalidBaseURL
    }
    components.fragment = nil
    guard let url = components.url, url.host != nil else {
      throw ArkEventPumpError.invalidBaseURL
    }
    return url
  }

  /// Build one Bearer-authenticated WebSocket handshake request.
  public static func eventRequest(
    baseURL: URL,
    apiToken: String,
    channel: ArkEventChannel
  ) throws -> URLRequest {
    var request = URLRequest(url: try eventURL(baseURL: baseURL, channel: channel))
    request.setValue("Bearer \(apiToken)", forHTTPHeaderField: "Authorization")
    return request
  }

  /// Decode one text WebSocket message while preserving its merge-extensible payload.
  public static func decodeFrame(_ text: String, channel: ArkEventChannel) throws -> ArkEventFrame {
    guard let data = text.data(using: .utf8),
          let envelope = try? JSONDecoder().decode(JSONValue.self, from: data),
          envelope["type"]?.stringValue == "server-request",
          let rpcID = envelope["rpcId"]?.stringValue,
          !rpcID.isEmpty,
          let method = envelope["method"]?.stringValue,
          !method.isEmpty,
          let payload = envelope["payload"],
          payload["type"]?.stringValue == method
    else {
      throw ArkEventPumpError.malformedEnvelope
    }
    guard methodAllowed(method, on: channel) else {
      throw ArkEventPumpError.unexpectedMethod(channel: channel, method: method)
    }
    try validateProtocolPayload(payload, method: method, channel: channel)
    return ArkEventFrame(channel: channel, rpcID: rpcID, method: method, payload: payload)
  }

  /// Start the mux and host pumps. Repeated calls while running are no-ops.
  public func start() {
    guard lifecycle == .idle else { return }
    lifecycle = .running
    for channel in ArkEventChannel.allCases {
      pumps[channel] = Task { [weak self] in
        await self?.run(channel: channel)
      }
    }
  }

  /// Permanently stop both sockets and finish the event stream after their receive loops exit.
  /// Concurrent callers await the same quiescence operation.
  public func stop() async {
    if let stopTask {
      await stopTask.value
      return
    }
    guard lifecycle != .stopped else { return }
    lifecycle = .stopping
    for socket in sockets.values {
      socket.cancel(with: .goingAway, reason: nil)
    }
    sockets.removeAll()
    let activePumps = Array(pumps.values)
    pumps.removeAll()
    for pump in activePumps { pump.cancel() }
    let stopTask = Task {
      await mailbox.finish()
      for pump in activePumps { await pump.value }
    }
    self.stopTask = stopTask
    await stopTask.value
    lifecycle = .stopped
    self.stopTask = nil
  }

  private func run(channel: ArkEventChannel) async {
    defer {
      sockets[channel]?.cancel(with: .goingAway, reason: nil)
      sockets[channel] = nil
      pumps[channel] = nil
    }
    var reconnectAttempt = 0
    while lifecycle == .running, !Task.isCancelled {
      guard await publishConnectionState(channel: channel, state: .connecting) else { break }
      var connectedAt: UInt64?
      var reportedFailure = false
      do {
        let request = try Self.eventRequest(
          baseURL: baseURL,
          apiToken: apiToken,
          channel: channel
        )
        let socket = session.webSocketTask(with: request)
        sockets[channel] = socket
        socket.resume()
        while lifecycle == .running, !Task.isCancelled {
          let message = try await socket.receive()
          guard lifecycle == .running, !Task.isCancelled else { break }
          do {
            let frame = try Self.decodeFrame(message, channel: channel)
            if connectedAt == nil { connectedAt = DispatchTime.now().uptimeNanoseconds }
            if frame.method == "stream/error" { reportedFailure = true }
            guard await mailbox.send(frame) else {
              break
            }
          } catch {
            reportedFailure = true
            _ = await publishConnectionFailure(
              channel: channel,
              code: "EVENT_PROTOCOL_INVALID",
              message: String(describing: error)
            )
            break
          }
        }
      } catch {
        if lifecycle == .running, !Task.isCancelled, !reportedFailure {
          reportedFailure = true
          _ = await publishConnectionFailure(
            channel: channel,
            code: "EVENT_TRANSPORT_UNAVAILABLE",
            message: error.localizedDescription
          )
        }
      }
      sockets[channel]?.cancel(with: .goingAway, reason: nil)
      sockets[channel] = nil
      guard lifecycle == .running, !Task.isCancelled else { break }
      if !reportedFailure {
        _ = await publishConnectionFailure(
          channel: channel,
          code: "EVENT_STREAM_CLOSED",
          message: "事件连接已关闭，正在重新连接"
        )
      }
      if let connectedAt,
         DispatchTime.now().uptimeNanoseconds &- connectedAt >= Self.stableConnectionNanoseconds {
        reconnectAttempt = 0
      }
      let delay = Self.reconnectDelayNanoseconds(attempt: reconnectAttempt)
      reconnectAttempt = min(reconnectAttempt + 1, 63)
      do {
        try await Task.sleep(nanoseconds: delay)
      } catch {
        break
      }
    }
  }

  private func publishConnectionState(
    channel: ArkEventChannel,
    state: ArkEventConnectionState
  ) async -> Bool {
    await mailbox.send(ArkEventFrame(
      channel: channel,
      rpcID: "local-state-\(UUID().uuidString)",
      method: "stream/state",
      payload: .object([
        "type": .string("stream/state"),
        "channel": .string(channel.rawValue),
        "state": .string(state.rawValue),
      ])
    ))
  }

  private func publishConnectionFailure(
    channel: ArkEventChannel,
    code: String,
    message: String
  ) async -> Bool {
    await mailbox.send(ArkEventFrame(
      channel: channel,
      rpcID: "local-error-\(UUID().uuidString)",
      method: "stream/error",
      payload: .object([
        "type": .string("stream/error"),
        "channel": .string(channel.rawValue),
        "error": .object([
          "code": .string(code),
          "message": .string(message),
          "details": .object([:]),
        ]),
      ])
    ))
  }

  private static func decodeFrame(
    _ message: URLSessionWebSocketTask.Message,
    channel: ArkEventChannel
  ) throws -> ArkEventFrame {
    guard case .string(let text) = message else {
      throw ArkEventPumpError.binaryFrame
    }
    return try decodeFrame(text, channel: channel)
  }

  private static func methodAllowed(_ method: String, on channel: ArkEventChannel) -> Bool {
    if method == "stream/baseline" || method == "stream/error" { return true }
    switch channel {
    case .mux:
      return [
        "session/subscribed", "session/event", "session/projection", "session/queue",
        "session/jobs", "approval/requested", "approval/resolved", "question/requested",
        "question/resolved",
      ].contains(method)
    case .host:
      return [
        "host/session-added", "host/session-removed", "host/session-deleted",
        "host/session-status", "host/agent-error", "host/workspace-changed",
        "host/workspace-removed", "host/workspace-order-changed",
        "host/archived-sessions-changed", "host/remote-event",
      ].contains(method)
    }
  }

  private static func validateProtocolPayload(
    _ payload: JSONValue,
    method: String,
    channel: ArkEventChannel
  ) throws {
    switch method {
    case "session/subscribed":
      guard safeInteger(payload["lastSeq"], minimum: -1) != nil else {
        throw ArkEventPumpError.invalidSequence(method: method)
      }
    case "session/event":
      guard safeInteger(payload["event"]?["seq"], minimum: 0) != nil else {
        throw ArkEventPumpError.invalidSequence(method: method)
      }
    case "session/projection":
      guard safeInteger(payload["seq"], minimum: 0) != nil else {
        throw ArkEventPumpError.invalidSequence(method: method)
      }
    case "stream/baseline":
      guard payload["channel"]?.stringValue == channel.rawValue,
            let generation = payload["generation"]?.stringValue,
            !generation.isEmpty,
            let phase = payload["phase"]?.stringValue,
            phase == "begin" || phase == "complete"
      else { throw ArkEventPumpError.malformedEnvelope }
      if phase == "complete" {
        guard let sessionIDs = payload["sessionIds"]?.arrayValue,
              sessionIDs.allSatisfy({ value in
                guard let id = value.stringValue else { return false }
                return !id.isEmpty
              })
        else { throw ArkEventPumpError.malformedEnvelope }
      }
    case "stream/error":
      guard payload["channel"]?.stringValue == channel.rawValue,
            let error = payload["error"],
            let code = error["code"]?.stringValue,
            !code.isEmpty,
            let message = error["message"]?.stringValue,
            !message.isEmpty
      else { throw ArkEventPumpError.malformedEnvelope }
    default:
      break
    }
  }

  private static func safeInteger(_ value: JSONValue?, minimum: Int) -> Int? {
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

  private static func reconnectDelayNanoseconds(attempt: Int) -> UInt64 {
    let shift = min(max(attempt, 0), 5)
    let base = min(
      initialReconnectDelayNanoseconds << shift,
      maximumReconnectDelayNanoseconds
    )
    // De-correlate mux/host and multiple Ark instances after a service outage;
    // cap the jitter so the documented maximum remains load-bearing.
    let availableJitter = maximumReconnectDelayNanoseconds - base
    let jitterCap = min(base / 4, availableJitter)
    let jitter = jitterCap == 0 ? 0 : UInt64.random(in: 0...jitterCap)
    return base + jitter
  }
}
