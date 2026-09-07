import Foundation
import JiuzhangShellCore
@testable import JiuzhangShellUI

/// 并发读取闸门（actor）：两个读取都到达后才一起放行，构造真实的双 open race。
actor RaceReadGate {
  private var arrivals = 0
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func arrive() async {
    arrivals += 1
    if arrivals >= 2 {
      let released = waiters
      waiters.removeAll()
      for waiter in released { waiter.resume() }
      return
    }
    await withCheckedContinuation { continuation in
      waiters.append(continuation)
    }
  }
}

/// 读取计数（actor）。
actor ReadCounter {
  private(set) var value = 0
  func increment() { value += 1 }
}

/// Model 级 async 双 open race 行为测试。
///
/// 被测对象是生产路径共用的 async core：`NativeWorkbenchModel.selectFile(_:)`
/// 本身 `async` 且 `await openFile(...)` 直到读取完成；UI 调用点只是在 Task
/// 里 fire-and-forget，测试直接 `await` 同一个 core，不复制生产打开逻辑。
///
/// 契约：
/// - 同一 canonical file 并发打开（受控延迟读取）最终只有一个 Tab；
/// - 已打开 dirty 文件再次点击不会 reread / 覆盖 dirty 文本；
/// - worktree-changing Git 操作只可清除启动时未变化的 clean 快照，运行期间的新编辑必须保留。
@MainActor
func runArkFilesRaceContractChecks() async {
  let gate = RaceReadGate()
  let counter = ReadCounter()
  let model = NativeWorkbenchModel(
    rootURL: URL(fileURLWithPath: "/tmp"),
    fileReader: { _ in
      await counter.increment()
      await gate.arrive()
      return "content"
    }
  )
  let url = URL(fileURLWithPath: "/tmp/a.swift")

  // 两个并发打开：都先通过 pre-dedupe，再同时放行读取，最后 post-dedupe 收敛。
  await withTaskGroup(of: Void.self) { group in
    group.addTask { await model.selectFile(url) }
    group.addTask { await model.selectFile(url) }
  }

  let reads = await counter.value
  check(reads == 2, "both concurrent opens attempt the read")
  check(model.fileTabs.tabs.count == 1, "async double open race yields exactly one tab")

  // 已打开 dirty 文件再次点击：不 reread、不覆盖。
  let secondCounter = ReadCounter()
  let second = NativeWorkbenchModel(
    rootURL: URL(fileURLWithPath: "/tmp"),
    fileReader: { _ in
      await secondCounter.increment()
      return "fresh-from-disk"
    }
  )
  await second.selectFile(url)
  check(second.fileTabs.tabs.count == 1, "initial open completes")
  guard let tabID = second.fileTabs.activeTabID else {
    check(false, "active tab must exist after a completed open")
    return
  }
  second.fileTabs.updateText(id: tabID, text: "dirty edit")
  let readsBefore = await secondCounter.value
  await second.selectFile(url)
  let readsAfter = await secondCounter.value
  check(second.fileTabs.tabs.count == 1, "reopen keeps a single tab")
  check(readsAfter == readsBefore, "reopen does not reread from disk")
  check(second.fileTabs.activeTab?.text == "dirty edit",
        "reopen does not overwrite dirty text")

  // Different files may complete out of order. Both requested tabs can be
  // retained, but only the user's latest selection may become active or own
  // the shared path/status presentation.
  let latest = NativeWorkbenchModel(
    rootURL: URL(fileURLWithPath: "/tmp"),
    fileReader: { url in
      if url.lastPathComponent == "first.swift" {
        try? await Task.sleep(nanoseconds: 80_000_000)
      } else {
        try? await Task.sleep(nanoseconds: 5_000_000)
      }
      return url.lastPathComponent
    }
  )
  let firstURL = URL(fileURLWithPath: "/tmp/first.swift")
  let latestURL = URL(fileURLWithPath: "/tmp/latest.swift")
  let firstTask = Task { await latest.selectFile(firstURL) }
  await Task.yield()
  let latestTask = Task { await latest.selectFile(latestURL) }
  await firstTask.value
  await latestTask.value
  check(latest.fileTabs.tabs.count == 2,
        "out-of-order distinct reads retain both requested tabs")
  check(latest.fileTabs.activeTab?.canonicalPath == latestURL.path,
        "out-of-order distinct reads keep the latest user selection active")
  check(latest.pathInput == latestURL.path,
        "out-of-order distinct reads keep shared path presentation on the latest selection")

  // Branch/create starts from a clean Files snapshot. If the user edits while
  // Git is running, the success callback must not erase that newly dirty tab.
  let branchRace = NativeWorkbenchModel(
    rootURL: URL(fileURLWithPath: "/tmp"),
    fileReader: { _ in "branch baseline" }
  )
  await branchRace.selectFile(URL(fileURLWithPath: "/tmp/branch-race.swift"))
  let branchStart = branchRace.fileTabs
  guard let branchTabID = branchRace.fileTabs.activeTabID else {
    check(false, "branch race fixture opens a clean tab")
    return
  }
  branchRace.fileTabs.updateText(id: branchTabID, text: "dirty during branch switch")
  check(
    !branchRace.resetFileTabsAfterGitOperation(startedWith: branchStart),
    "branch success refuses to reset Files tabs changed during the operation"
  )
  check(
    branchRace.fileTabs.activeTab?.text == "dirty during branch switch"
      && branchRace.fileTabs.hasDirtyTabs,
    "branch success preserves the user's newly dirty editor buffer"
  )

  let unchanged = NativeWorkbenchModel(
    rootURL: URL(fileURLWithPath: "/tmp"),
    fileReader: { _ in "unchanged baseline" }
  )
  await unchanged.selectFile(URL(fileURLWithPath: "/tmp/unchanged-branch.swift"))
  let unchangedStart = unchanged.fileTabs
  check(
    unchanged.resetFileTabsAfterGitOperation(startedWith: unchangedStart)
      && unchanged.fileTabs.tabs.isEmpty,
    "branch success resets only an unchanged clean Files snapshot"
  )

  let workbenchURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeWorkbenchView.swift"
  )
  let workbenchSource = try? String(contentsOf: workbenchURL, encoding: .utf8)
  check(
    workbenchSource?.contains("let fileTabsAtStart = resetsFileTabs ? fileTabs : nil") == true
      && workbenchSource?.contains(
        "resetFileTabsAfterGitOperation(startedWith: fileTabsAtStart)"
      ) == true,
    "worktree-changing Git operations route asynchronous success through the Files snapshot owner"
  )
}
