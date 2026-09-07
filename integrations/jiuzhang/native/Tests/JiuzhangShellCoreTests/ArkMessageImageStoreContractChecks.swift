import Foundation
import JiuzhangShellUI

private enum ArkImageFixtureError: Error {
  case expected
}

private actor ArkImageLoadProbe {
  private var counts: [String: Int] = [:]

  func load(sessionID: String, attachmentID: String) async throws -> Data {
    counts[attachmentID, default: 0] += 1
    let count = counts[attachmentID, default: 0]
    if attachmentID == "retry" && count == 1 { throw ArkImageFixtureError.expected }
    if attachmentID.hasPrefix("slow") {
      try await Task.sleep(nanoseconds: 250_000_000)
    }
    return Data("\(sessionID):\(attachmentID):\(count)".utf8)
  }

  func count(for attachmentID: String) -> Int {
    counts[attachmentID, default: 0]
  }
}

@MainActor
func runArkMessageImageStoreContractChecks() async {
  let probe = ArkImageLoadProbe()
  let store = ArkMessageImageStore { sessionID, attachmentID in
    try await probe.load(sessionID: sessionID, attachmentID: attachmentID)
  }
  store.configure(sessionID: "session-a")

  store.load("dedupe")
  store.load("dedupe")
  let dedupeLoaded = await waitForImageState(store, attachmentID: "dedupe") { $0 == .loaded }
  check(
    dedupeLoaded,
    "native historical image store completes an authorized load"
  )
  let dedupeCallCount = await probe.count(for: "dedupe")
  check(
    dedupeCallCount == 1,
    "native historical image store deduplicates concurrent attachment loads"
  )
  check(
    store.data(for: "dedupe") == Data("session-a:dedupe:1".utf8),
    "native historical image store caches loaded bytes in the owning session scope"
  )

  store.load("retry")
  let firstRetryFailed = await waitForImageState(store, attachmentID: "retry") {
    if case .failed = $0 { return true }
    return false
  }
  check(
    firstRetryFailed,
    "native historical image store exposes a retryable failure state"
  )
  store.retry("retry")
  let retryLoaded = await waitForImageState(store, attachmentID: "retry") { $0 == .loaded }
  check(
    retryLoaded,
    "native historical image retry starts a fresh authorized request"
  )
  let retryCallCount = await probe.count(for: "retry")
  check(
    retryCallCount == 2,
    "native historical image retry does not reuse the failed request"
  )

  store.load("slow-cancel")
  check(store.state(for: "slow-cancel") == .loading, "native image load exposes loading state")
  store.cancel("slow-cancel")
  try? await Task.sleep(nanoseconds: 20_000_000)
  check(
    store.state(for: "slow-cancel") == .cancelled && store.data(for: "slow-cancel") == nil,
    "native image cancellation remains stopped without retaining bytes"
  )

  store.load("slow-stale")
  store.configure(sessionID: "session-b")
  try? await Task.sleep(nanoseconds: 300_000_000)
  check(
    store.state(for: "slow-stale") == .idle && store.data(for: "slow-stale") == nil,
    "native image session change cancels and rejects stale completion"
  )

  let storeURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/ArkMessageImageStore.swift"
  )
  let appModelURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/ArkAppModel.swift"
  )
  let rootURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/ArkRootView.swift"
  )
  let trajectoryURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeTrajectoryParityView.swift"
  )
  guard
    let storeSource = try? String(contentsOf: storeURL, encoding: .utf8),
    let appModel = try? String(contentsOf: appModelURL, encoding: .utf8),
    let root = try? String(contentsOf: rootURL, encoding: .utf8),
    let trajectory = try? String(contentsOf: trajectoryURL, encoding: .utf8)
  else {
    check(false, "native historical image sources are readable")
    return
  }
  check(
    storeSource.contains("private var tasks: [String: Task<Void, Never>]")
      && storeSource.contains("private var attemptTokens: [String: UInt64]")
      && storeSource.contains("case failed(String)")
      && storeSource.contains("case cancelled")
      && storeSource.contains("for task in tasks.values { task.cancel() }"),
    "native image owner locks failure, in-flight dedupe, cancellation and stale-attempt guards"
  )
  check(
    appModel.contains("public let messageImages: ArkMessageImageStore")
      && appModel.contains("try await interactions.readImage(sessionID: sessionID, attachmentID: attachmentID).data")
      && appModel.contains("messageImages.configure(sessionID: sessionID)")
      && appModel.contains("messageImages.configure(sessionID: nil)")
      && !appModel.contains("loadedMessageImages"),
    "native app model owns one session-scoped historical image store"
  )
  guard let images = imageSourceSlice(
    root,
    from: "struct NativeMessageImages: View",
    through: "private enum NativeChatEntry"
  ) else {
    check(false, "native historical image presentation block is present")
    return
  }
  check(
    images.contains("ark.chat.image.retry.")
      && images.contains("ark.chat.image.cancel.")
      && images.contains("ark.chat.image.open.")
      && images.contains("store.retry(attachmentID)")
      && images.contains("store.cancel(attachmentID)")
      && images.contains("NSImage(data: data)")
      && images.contains(".scaledToFit()")
      && root.contains("NativeMessageImages(model: model, attachmentIDs: message.attachmentIDs)")
      && trajectory.contains("NativeMessageImages(model: model, attachmentIDs: record.attachmentIDs)"),
    "native historical and Trajectory images share readable open, cancel, and retry presentation"
  )
}

@MainActor
private func waitForImageState(
  _ store: ArkMessageImageStore,
  attachmentID: String,
  matches: (ArkMessageImageLoadState) -> Bool
) async -> Bool {
  for _ in 0..<100 {
    if matches(store.state(for: attachmentID)) { return true }
    try? await Task.sleep(nanoseconds: 10_000_000)
  }
  return false
}

private func imageSourceSlice(
  _ source: String,
  from start: String,
  through end: String
) -> String? {
  guard
    let startRange = source.range(of: start),
    let endRange = source.range(
      of: end,
      range: startRange.lowerBound..<source.endIndex
    )
  else { return nil }
  return String(source[startRange.lowerBound..<endRange.upperBound])
}
