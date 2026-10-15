import Darwin
import Foundation
import JiuzhangShellCore

private func ownerProbeWrite(_ socket: Int32, _ value: JSONValue) throws {
  let data = try ArkProtectedBytes.encode(value)
  var length = UInt32(data.count).bigEndian
  var frame = withUnsafeBytes(of: &length) { Data($0) }; frame.append(data)
  try frame.withUnsafeBytes { bytes in
    var position = 0
    while position < bytes.count {
      let written = Darwin.write(socket, bytes.baseAddress!.advanced(by: position), bytes.count - position)
      guard written > 0 else { throw ArkProtectedOwnerError.rejected("probe write failed") }
      position += written
    }
  }
}

private func ownerProbeRead(_ socket: Int32) throws -> JSONValue {
  func bytes(_ count: Int) throws -> Data {
    var data = Data(count: count)
    try data.withUnsafeMutableBytes { buffer in
      var position = 0
      while position < buffer.count {
        let received = Darwin.read(socket, buffer.baseAddress!.advanced(by: position), buffer.count - position)
        guard received > 0 else { throw ArkProtectedOwnerError.rejected("probe closed before response") }
        position += received
      }
    }
    return data
  }
  let length = try bytes(4).reduce(0) { ($0 << 8) | Int($1) }
  guard length > 0, length <= ArkProtectedBytes.maximumFrame else { throw ArkProtectedOwnerError.rejected("probe frame invalid") }
  return try JSONDecoder().decode(JSONValue.self, from: bytes(length))
}

func runArkPrivateChannelProbe(_ mode: String) -> Int32 {
  do {
    let environment = ProcessInfo.processInfo.environment
    guard let path = environment["ARK_NATIVE_OWNER_SOCKET_PATH"], let token = environment["ARK_NATIVE_OWNER_LAUNCH_TOKEN"] else { return 65 }
    let socket = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard socket >= 0 else { return 66 }
    defer { Darwin.close(socket) }
    var timeout = timeval(tv_sec: 3, tv_usec: 0)
    setsockopt(socket, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    var noSignal: Int32 = 1
    setsockopt(socket, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
    var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: Array(path.utf8) + [0]) }
    let connected = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(socket, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    guard connected == 0 else { return 67 }
    try ownerProbeWrite(socket, .object(["version": .number(1), "operation": .string("hello"),
      "launchToken": .string(mode == "wrong-token" ? "wrong" : token)]))
    let hello = try ownerProbeRead(socket)
    guard hello["version"] == .number(1), hello["ok"] == .bool(true) else { return 68 }
    let operation = mode == "guard" ? "admitProviderRequest" : mode == "forge-settlement" ? "recordProviderSettlement" : mode == "unknown" ? "signBytes" : "verifyCandidate"
    try ownerProbeWrite(socket, .object(["version": .number(1), "requestId": .string("fixture-request"),
      "operation": .string(operation), "payload": .object(["fixture": .bool(true)])]))
    if mode == "cancel" {
      try ownerProbeWrite(socket, .object(["version": .number(1), "requestId": .string("fixture-request"), "operation": .string("cancel")]))
    }
    let response = try ownerProbeRead(socket)
    guard response["requestId"] == .string("fixture-request") else { return 69 }
    if mode == "cancel" { return response["ok"] == .bool(false) && response["error"]?["code"] == .string("cancelled") ? 0 : 70 }
    return response["ok"] == .bool(true) && response["result"]?["fixtureEcho"] == .bool(true) ? 0 : 71
  } catch { return 72 }
}

private actor OwnerChannelCallCounter {
  private var count = 0
  func called() { count += 1 }
  func value() -> Int { count }
}

@MainActor
func runArkNativeOwnerChannelContractChecks() async {
  let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.path
  for (mode, role, expected) in [("positive", ArkProtectedPeerRole.backend, Int32(0)),
    ("wrong-token", .backend, 72), ("unknown", .backend, 72), ("forge-settlement", .backend, 72),
    ("guard", .guardProcess, 0), ("cancel", .backend, 0)] {
    do {
      let counter = OwnerChannelCallCounter()
      let channel = try ArkNativeOwnerChannel(peerRole: role) { _, _ in
        await counter.called()
        if mode == "cancel" { try await Task.sleep(nanoseconds: 2_000_000_000) }
        return .object(["fixtureEcho": .bool(true)])
      }
      let backend = BackendProcess()
      var exitStatus: Int32?
      backend.onExit = { exitStatus = $0 }
      try backend.start(executable: executable, arguments: ["--private-channel-probe", mode], environment: [:],
        workingDirectory: URL(fileURLWithPath: "/private/tmp"), ownerChannel: channel)
      let deadline = Date().addingTimeInterval(5)
      while exitStatus == nil && Date() < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
      if backend.isRunning { await withCheckedContinuation { continuation in backend.stop { continuation.resume() } } }
      check(exitStatus == expected, "private channel \(mode) binds real child PID/token/role and settles its correlation")
      let calls = await counter.value()
      if ["wrong-token", "unknown", "forge-settlement"].contains(mode) {
        check(calls == 0, "private channel \(mode) refuses before owner business execution")
      }
      let cleanup = Date().addingTimeInterval(2)
      while FileManager.default.fileExists(atPath: channel.socketPath) && Date() < cleanup { try await Task.sleep(nanoseconds: 10_000_000) }
      check(!FileManager.default.fileExists(atPath: channel.socketPath), "private \(mode) socket is removed after owned backend exit")
    } catch { check(false, "private channel \(mode) fixture failed: \(error)") }
  }
  do {
    let gate = OwnerChannelSettlementGate()
    let channel = try ArkNativeOwnerChannel { _, _ in
      await gate.beginAndHold()
      throw CancellationError()
    }
    let backend = BackendProcess()
    try backend.start(executable: executable, arguments: ["--private-channel-probe", "positive"], environment: [:],
      workingDirectory: URL(fileURLWithPath: "/private/tmp"), ownerChannel: channel)
    while !(await gate.hasBegun()) { await Task.yield() }
    var completed = false
    backend.stop { completed = true }
    try await Task.sleep(nanoseconds: 100_000_000)
    check(!completed, "backend stop waits for private handler settlement after launcher exit")
    await gate.finish()
    let deadline = Date().addingTimeInterval(4)
    while !completed && Date() < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
    check(completed, "backend stop completes after cancelled private handler actually returns")
  } catch { check(false, "private shutdown join fixture failed: \(error)") }
  do {
    let channel = try ArkNativeOwnerChannel { _, _ in .object(["fixtureEcho": .bool(true)]) }
    let owned = Process(); owned.executableURL = URL(fileURLWithPath: "/bin/sleep"); owned.arguments = ["10"]
    try owned.run(); channel.bindLauncher(owned)
    defer { channel.close(); if owned.isRunning { owned.terminate(); owned.waitUntilExit() } }
    let sibling = BackendProcess()
    var status: Int32?
    sibling.onExit = { status = $0 }
    try sibling.start(executable: executable, arguments: ["--private-channel-probe", "positive"], environment: channel.environment,
      workingDirectory: URL(fileURLWithPath: "/private/tmp"))
    let deadline = Date().addingTimeInterval(5)
    while status == nil && Date() < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
    if sibling.isRunning { await withCheckedContinuation { continuation in sibling.stop { continuation.resume() } } }
    check(status == 72, "same-UID unrelated process with the copied token is rejected by kernel peer ownership")
  } catch { check(false, "private wrong-PID fixture failed: \(error)") }
}

private actor OwnerChannelSettlementGate {
  private var began = false
  private var continuation: CheckedContinuation<Void, Never>?
  func beginAndHold() async { began = true; await withCheckedContinuation { continuation = $0 } }
  func hasBegun() -> Bool { began }
  func finish() { continuation?.resume(); continuation = nil }
}
