import Foundation
@testable import JiuzhangShellCore
@testable import JiuzhangShellUI

/// Trajectory rows observed through the real model install path.
///
/// `ArkTrajectoryRecomputeContractChecks` pins the decision function. This drives
/// the pipeline behind it: a reading window installs a snapshot, and loading a
/// second message body inside that same window must not publish an empty
/// trajectory array in between — the table would flash through a state it never
/// had. The published sequence is recorded, not inferred.
@MainActor
func runArkTrajectoryPipelineContractChecks() async {
  let root = FileManager.default.temporaryDirectory
    .appendingPathComponent("ark-trajectory-pipeline-\(UUID().uuidString)")
  let suite = "ark-trajectory-pipeline-\(UUID().uuidString)"
  guard let defaults = UserDefaults(suiteName: suite) else {
    check(false, "trajectory pipeline isolated defaults")
    return
  }
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [HistoryWindowURLProtocol.self]
  let transport = URLSession(configuration: configuration)
  let endpoint = URL(string: "http://ark-trajectory-pipeline.invalid")!
  let client = ArkAPIClient(baseURL: endpoint, apiToken: "synthetic-contract", session: transport)
  let store = ArkDocumentReferenceStore(rootURL: root)
  let model = ArkAppModel(
    client: client,
    interactions: ArkInteractionAPI(baseURL: endpoint, apiToken: "synthetic-contract", session: transport),
    eventPump: ArkEventPump(baseURL: endpoint, apiToken: "synthetic-contract"),
    fallbackWikiRoot: root,
    documentStore: store,
    defaults: defaults
  )
  defer {
    transport.invalidateAndCancel()
    defaults.removePersistentDomain(forName: suite)
    try? FileManager.default.removeItem(at: root)
  }

  // Enough rows that the reading window has older history to load.
  HistoryWindowURLProtocol.fixture = HistoryWindowFixture(rows: 12)

  var published: [Int] = []
  let observation = model.$trajectoryRecords.sink { published.append($0.count) }
  defer { observation.cancel() }

  // Selecting a session navigates to the chat tab by default, which would
  // suppress the trajectory projection. Keep the trajectory surface selected.
  model.selectSession("fixture", navigateToChat: false)
  model.selectedTab = .trajectory
  let loaded = await trajectoryPipelineEventually { model.historyLoadState == .loaded }
  check(loaded, "trajectory pipeline fixture session reaches a loaded history state")
  guard loaded else { return }

  await model.loadOlderHistory()
  let reading = await trajectoryPipelineEventually { model.historyReadingSnapshot != nil }
  check(reading, "loading older history enters the reading window")
  guard reading, let snapshot = model.historyReadingSnapshot else { return }

  // Let the first fold for this reading context install rows.
  let populated = await trajectoryPipelineEventually { !model.trajectoryRecords.isEmpty }
  check(populated, "the reading window installs trajectory rows")
  guard populated else { return }

  let ids = snapshot.recordByMessageID.keys.sorted()
  guard ids.count >= 2 else {
    check(false, "the reading window exposes two message bodies to load")
    return
  }

  // Two consecutive bodies inside one window: same session, same cut.
  let baseline = published.count
  for id in ids.prefix(2) {
    _ = try? await model.loadHistoryMessageContent(messageID: id)
    // Give the same-context re-install and its fold a chance to publish.
    await trajectoryPipelineSettle()
  }
  let window = Array(published.dropFirst(baseline))

  check(
    !window.contains(0),
    "loading message bodies inside one reading window never publishes an empty trajectory array"
  )
  check(
    !model.trajectoryRecords.isEmpty,
    "the reading window still shows rows after loading two bodies"
  )
}

/// Let queued main-actor work and one projection fold settle.
@MainActor
private func trajectoryPipelineSettle() async {
  for _ in 0..<40 {
    await Task.yield()
    try? await Task.sleep(nanoseconds: 5_000_000)
  }
}

/// Poll for an observable condition rather than assuming a fixed delay.
@MainActor
private func trajectoryPipelineEventually(
  _ condition: @MainActor () -> Bool,
  attempts: Int = 400
) async -> Bool {
  for _ in 0..<attempts {
    if condition() { return true }
    try? await Task.sleep(nanoseconds: 5_000_000)
  }
  return condition()
}
