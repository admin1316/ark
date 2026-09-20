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

  var completedLoads = 0
  let historyObservation = model.$historyLoadState.sink { if $0 == .loaded { completedLoads += 1 } }
  defer { historyObservation.cancel() }
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

  let coldRows = await trajectoryPipelineEventually {
    model.trajectoryRecords.filter { $0.kind == .user }.count == model.messages.count
  }
  check(coldRows && model.messages.count == 12,
    "cold semantic history populates trajectory before entering a reading window")

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
    let beforeLoad = published.count
    do {
      let message = try await model.loadHistoryMessageContent(messageID: id)
      check(message.id == id, "the requested history message body is returned")
    } catch {
      check(false, "loading a trajectory history body failed: \(error)")
      return
    }
    let recomputed = await trajectoryPipelineEventually { published.count > beforeLoad }
    check(recomputed, "each loaded body completes a new trajectory publication")
    guard recomputed else { return }
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

  // A context change must not present one session's rows as another's. Switching
  // sessions replaces the context, so the retained rows are cleared at the switch
  // rather than surviving into the new session's surface.
  let beforeSwitch = model.trajectoryRecords.count
  check(beforeSwitch > 0, "the reading window has rows to carry into a session switch")
  model.selectSession("other-session", navigateToChat: false)
  model.selectedTab = .trajectory
  check(
    model.trajectoryRecords.isEmpty,
    "switching sessions clears the previous session's rows instead of showing them as the new session's"
  )

  // A session the fixture serves no records for must present a real empty state,
  // and the projection must recover when a populated session is selected again.
  HistoryWindowURLProtocol.fixture = HistoryWindowFixture(rows: 0)
  model.selectSession("empty-session", navigateToChat: false)
  model.selectedTab = .trajectory
  let emptySettled = await trajectoryPipelineEventually { model.historyLoadState == .loaded }
  check(emptySettled, "the empty fixture session reaches a loaded history state")
  check(
    model.trajectoryRecords.isEmpty,
    "a session with no records shows an empty ledger rather than stale rows"
  )

  // Select the populated session again: the projection must repopulate rather
  // than stay permanently cleared by the earlier context change.
  HistoryWindowURLProtocol.fixture = HistoryWindowFixture(rows: 12)
  let beforeWarmLoads = completedLoads
  model.selectSession("fixture", navigateToChat: false)
  model.selectedTab = .trajectory
  // Cache restoration publishes loaded immediately; wait for the subsequent
  // authoritative refresh before asking to change its reading window.
  let recovered = await trajectoryPipelineEventually {
    completedLoads >= beforeWarmLoads + 2 && model.historyLoadState == .loaded
  }
  check(recovered, "the populated fixture session loads again after an empty one")
  let warmRows = await trajectoryPipelineEventually {
    model.trajectoryRecords.filter { $0.kind == .user }.count == 12
  }
  check(warmRows, "warm session restoration retains every semantic trajectory row")
  await model.loadOlderHistory()
  let readingAgain = await trajectoryPipelineEventually { model.historyReadingSnapshot != nil }
  check(readingAgain, "the repopulated session can enter its own reading window")
  let repopulated = await trajectoryPipelineEventually { !model.trajectoryRecords.isEmpty }
  check(
    repopulated,
    "the projection repopulates for the new context instead of staying permanently cleared"
  )
  // A closed turn recovers its bodies semantically; its raw tail is turn/end.
  // An active turn replays chunks as well, which must replace rather than
  // duplicate the semantic assistant prefix.
  for closed in [true, false] {
    let fixture = HistoryWindowFixture(chunks: 8, closed: closed)
    HistoryWindowURLProtocol.fixture = fixture
    model.selectSession(closed ? "closed-turn" : "active-turn", navigateToChat: false)
    model.selectedTab = .trajectory
    let ready = await trajectoryPipelineEventually {
      model.historyLoadState == .loaded && model.trajectoryRecords.contains { $0.kind == .message }
    }
    check(ready, "closed and active semantic recovery each publish an assistant trajectory row")
    let answers = model.trajectoryRecords.filter { $0.kind == .message }
    check(answers.count == 1 && answers.first?.output == fixture.expectedText,
      "semantic baseline and raw tail preserve one complete assistant body (closed=\(closed))")
    check(model.trajectoryRecords.filter { $0.kind == .user }.count == 1,
      "semantic baseline and raw tail do not duplicate the user row")
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
