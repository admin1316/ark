import Foundation
import JiuzhangShellCore

@MainActor
private func readinessWait(until predicate: () -> Bool) async -> Bool {
  let end = Date().addingTimeInterval(3)
  while !predicate(), Date() < end {
    try? await Task.sleep(nanoseconds: 5_000_000)
  }
  return predicate()
}

@MainActor
func runArkBackendReadinessContractChecks() async {
  check((try? JiuzhangShellContract.backendReadinessTimeout(info: [:])) == 30,
    "startup readiness defaults to thirty seconds")
  check((try? JiuzhangShellContract.backendReadinessTimeout(info: ["ArkBackendReadinessTimeoutSeconds": 12.5])) == 12.5,
    "signed deployment configuration can tune readiness")
  for invalid: Any in [true, false, 0, -1, Double.infinity, Double.nan, "30", NSNull()] {
    check((try? JiuzhangShellContract.backendReadinessTimeout(info: ["ArkBackendReadinessTimeoutSeconds": invalid])) == nil,
      "invalid readiness configuration fails instead of disabling the limit")
  }

  let owner = BackendReadinessDeadline()
  var expired: [UUID] = []
  let ready = UUID()
  owner.arm(launchID: ready, timeout: 0.02) { expired.append(ready) }
  check(owner.acceptReadiness(launchID: ready), "current readiness ends its startup deadline")
  check(!owner.acceptReadiness(launchID: ready), "duplicate readiness is ignored")
  try? await Task.sleep(nanoseconds: 40_000_000)
  check(expired.isEmpty, "healthy startup cannot later time out")

  let cancelled = UUID()
  owner.arm(launchID: cancelled, timeout: 0.02) { expired.append(cancelled) }
  owner.cancel()
  try? await Task.sleep(nanoseconds: 40_000_000)
  check(expired.isEmpty && !owner.acceptReadiness(launchID: cancelled),
    "quit or failure invalidates queued timers and late readiness")

  let old = UUID(), current = UUID()
  owner.arm(launchID: old, timeout: 0.02) { expired.append(old) }
  owner.arm(launchID: current, timeout: 0.05) { expired.append(current) }
  check(!owner.acceptReadiness(launchID: old), "old launch readiness cannot resolve its replacement")
  let reachedDeadline = await readinessWait { expired.count == 1 }
  check(reachedDeadline, "unready launch reaches its deadline")
  check(expired == [current] && !owner.acceptReadiness(launchID: current),
    "only current generation times out, once, and late readiness is rejected")

  let callbackProbe = BackendProcess()
  var launchLines = 0, replacementLines = 0, launchExits = 0, replacementExits = 0
  callbackProbe.onLine = { _ in launchLines += 1 }
  callbackProbe.onExit = { _ in launchExits += 1; owner.cancel() }
  do {
    try callbackProbe.start(executable: "/bin/sh", arguments: ["-c", "printf 'ready\\n'; exec /bin/sleep 60"],
      environment: ["PATH": "/usr/bin:/bin"], workingDirectory: FileManager.default.temporaryDirectory)
    callbackProbe.onLine = { _ in replacementLines += 1 }
    callbackProbe.onExit = { _ in replacementExits += 1 }
    let delivered = await readinessWait { launchLines == 1 }
    check(delivered && replacementLines == 0, "queued output retains the launch callback instead of adopting a replacement")
    owner.arm(launchID: UUID(), timeout: 0.1) { replacementExits += 100 }
    callbackProbe.stop(deadline: Date().addingTimeInterval(0.02)) {}
    let exited = await readinessWait { launchExits == 1 }
    try? await Task.sleep(nanoseconds: 120_000_000)
    check(exited && replacementExits == 0,
      "exit retains its launch callback and cancels readiness before a queued deadline")
  } catch {
    check(false, "launch callback ownership fixture runs: \(error)")
  }
  if callbackProbe.isRunning {
    var stopped = false
    callbackProbe.stop(deadline: Date()) { stopped = true }
    let reaped = await readinessWait { stopped }
    check(reaped, "callback ownership fixture reaps its owned process")
  }

  // Exercise the same deadline and owned stop primitives used by AppDelegate,
  // with a real child that never reports readiness and leaves no descendant.
  let backend = BackendProcess()
  var exits = 0
  var timedOut = 0
  backend.onExit = { _ in exits += 1; owner.cancel() }
  var breaker = BackendRestartCircuitBreaker(maximumRapidRestarts: 3)
  do {
    for attempt in 0..<4 {
      let generation = UUID()
      breaker.recordLaunch()
      try backend.start(executable: "/bin/sleep", arguments: ["60"],
        environment: ["PATH": "/usr/bin:/bin"], workingDirectory: FileManager.default.temporaryDirectory)
      owner.arm(launchID: generation, timeout: 0.02) {
        timedOut += 1
        backend.stop(deadline: Date().addingTimeInterval(0.05)) {}
      }
      let reaped = await readinessWait { exits == attempt + 1 }
      check(reaped, "unready process is reaped before recovery")
      check(!backend.isRunning, "readiness timeout releases owned process")
      let retry = breaker.restartDelayAfterUnexpectedExit()
      check(attempt < 3 ? retry != nil : retry == nil,
        "startup failures share the bounded restart circuit breaker")
      if backend.isRunning { break }
    }
    check(timedOut == 4 && exits == 4, "never-ready backend stops after the finite restart budget")
  } catch {
    check(false, "real never-ready startup fixture runs: \(error)")
  }
  if backend.isRunning {
    var stopped = false
    backend.stop(deadline: Date()) { stopped = true }
    let reaped = await readinessWait { stopped }
    check(reaped, "readiness fixture cleanup waits for its owned child")
  }
  owner.cancel()
}
