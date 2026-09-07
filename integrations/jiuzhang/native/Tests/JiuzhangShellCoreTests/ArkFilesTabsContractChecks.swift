import Foundation
import JiuzhangShellCore
import JiuzhangShellUI

/// 多文件 Tab 状态机行为契约：不依赖 UI，直接验证 NativeFileTabsState。
/// 注意：async 双 open race 需要 Model 级行为测试另行覆盖，
/// 本文件只锁状态机自身的插入 invariant。
func runArkFilesTabsContractChecks() {
  let rootA = URL(fileURLWithPath: "/foo")
  let rootB = URL(fileURLWithPath: "/bar")

  func url(_ base: URL, _ name: String) -> URL {
    base.appendingPathComponent(name)
  }

  // 1) same canonical URL → 1 Tab（含 openTab 内部 dedupe）
  var same = NativeFileTabsState()
  let a1 = same.openTab(url: url(rootA, "a.swift"), text: "v1")
  let a2 = same.openTab(url: url(rootA, "a.swift"), text: "v2-dirty")
  check(same.tabs.count == 1 && a1 == a2, "same canonical URL dedupes to one tab")
  check(same.activeTab?.text == "v1", "reopening an open tab does not overwrite its text")

  // 2) 同名不同路径 → 2 Tabs
  var twins = NativeFileTabsState()
  twins.openTab(url: url(rootA, "a.swift"), text: "A")
  twins.openTab(url: url(rootB, "a.swift"), text: "B")
  check(twins.tabs.count == 2, "same filename on different paths coexists as two tabs")

  // 3) dirty A → 切 B → 回 A → 内容仍在（切换不丢内容、不弹确认）
  var switchTabs = NativeFileTabsState()
  let idA = switchTabs.openTab(url: url(rootA, "a.swift"), text: "baseA")
  let idB = switchTabs.openTab(url: url(rootB, "b.swift"), text: "baseB")
  switchTabs.updateText(id: idA, text: "dirtyA")
  switchTabs.activate(id: idB)
  switchTabs.activate(id: idA)
  check(switchTabs.activeTab?.text == "dirtyA" && switchTabs.activeTab?.isDirty == true,
        "switching tabs preserves dirty text without confirmation")

  // 4) Save A 只清 A（按捕获 ID 写回），B 不变
  var saveCase = NativeFileTabsState()
  let sA = saveCase.openTab(url: url(rootA, "a.swift"), text: "base")
  let sB = saveCase.openTab(url: url(rootB, "b.swift"), text: "base")
  saveCase.updateText(id: sA, text: "edited")
  saveCase.updateText(id: sB, text: "editedB")
  saveCase.markSaved(id: sA, text: "edited")
  check(saveCase.tab(withID: sA)?.isDirty == false && saveCase.tab(withID: sB)?.isDirty == true,
        "saving one tab clears only that tab's dirty")

  // 5) Revert A 只改 A
  var revertCase = NativeFileTabsState()
  let rA = revertCase.openTab(url: url(rootA, "a.swift"), text: "base")
  let rB = revertCase.openTab(url: url(rootB, "b.swift"), text: "baseB")
  revertCase.updateText(id: rA, text: "edited")
  revertCase.updateText(id: rB, text: "editedB")
  revertCase.revert(id: rA)
  check(revertCase.tab(withID: rA)?.text == "base" && revertCase.tab(withID: rB)?.text == "editedB",
        "reverting one tab leaves others untouched")

  // 6) clean inactive close：active 不变
  var cleanClose = NativeFileTabsState()
  let cA = cleanClose.openTab(url: url(rootA, "a.swift"), text: "A")
  let cB = cleanClose.openTab(url: url(rootB, "b.swift"), text: "B")
  cleanClose.activate(id: cA)
  check(cleanClose.requestClose(id: cB) == false, "clean tab closes without confirmation")
  check(cleanClose.activeTabID == cA, "closing an inactive clean tab keeps active unchanged")

  // 7) dirty inactive close：pending 目标正确且 active 不变；discard 后 active 不变
  var dirtyClose = NativeFileTabsState()
  let dA = dirtyClose.openTab(url: url(rootA, "a.swift"), text: "A")
  let dB = dirtyClose.openTab(url: url(rootB, "b.swift"), text: "B")
  dirtyClose.updateText(id: dB, text: "dirty")
  dirtyClose.activate(id: dA)
  check(dirtyClose.requestClose(id: dB) == true, "dirty tab requests confirmation")
  check(dirtyClose.pendingCloseTabID == dB && dirtyClose.activeTabID == dA,
        "dirty inactive close targets requested tab without changing active tab")
  dirtyClose.discardClose()
  check(dirtyClose.tab(withID: dB) == nil && dirtyClose.activeTabID == dA,
        "discarding an inactive dirty tab keeps the active tab unchanged")

  // 8) Cancel dirty close：完全不变
  var cancelClose = NativeFileTabsState()
  let kA = cancelClose.openTab(url: url(rootA, "a.swift"), text: "A")
  let kB = cancelClose.openTab(url: url(rootB, "b.swift"), text: "B")
  cancelClose.updateText(id: kB, text: "dirty")
  cancelClose.requestClose(id: kB)
  cancelClose.cancelClose()
  check(cancelClose.tabs.count == 2 && cancelClose.pendingCloseTabID == nil
          && cancelClose.tab(withID: kB)?.text == "dirty",
        "cancelling a dirty close leaves tab and text intact")

  // 9) active close 激活规则：删除后原位置存在 → 原右侧；否则最后一个；最后 → 空态
  var activeClose = NativeFileTabsState()
  let e1 = activeClose.openTab(url: url(rootA, "1.swift"), text: "1")
  let e2 = activeClose.openTab(url: url(rootA, "2.swift"), text: "2")
  let e3 = activeClose.openTab(url: url(rootA, "3.swift"), text: "3")
  activeClose.activate(id: e1)
  activeClose.requestClose(id: e1)
  check(activeClose.activeTabID == e2, "closing the first active tab activates the right neighbor")
  activeClose.activate(id: e3)
  activeClose.requestClose(id: e3)
  check(activeClose.activeTabID == e2, "closing the last active tab activates the previous one")
  activeClose.requestClose(id: e2)
  check(activeClose.tabs.isEmpty && activeClose.activeTabID == nil,
        "closing the last tab returns to the empty editor state")

  // 10) 工作台级破坏性关闭：clean → 不动状态；dirty → pending；cancel/confirm 语义
  var wb = NativeFileTabsState()
  let w1 = wb.openTab(url: url(rootA, "1.swift"), text: "1")
  check(wb.requestWorkbenchClose() == false && wb.tabs.count == 1,
        "clean workbench close does not clear tabs")
  wb.updateText(id: w1, text: "dirty")
  check(wb.requestWorkbenchClose() == true && wb.pendingWorkbenchClose,
        "dirty workbench close requests confirmation")
  wb.cancelWorkbenchClose()
  check(wb.tabs.count == 1 && !wb.pendingWorkbenchClose,
        "cancelling workbench close keeps tabs")
  check(wb.requestWorkbenchClose() == true, "dirty workbench close requests confirmation again")
  wb.confirmDiscardWorkbenchClose()
  check(wb.tabs.isEmpty && wb.activeTabID == nil,
        "confirming discard clears all tabs")

  // 11) confirmDiscardWorkbenchClose 无 pending 时必须 no-op（安全 invariant）
  var protectedWB = NativeFileTabsState()
  let protectedID = protectedWB.openTab(
    url: url(rootA, "protected.swift"),
    text: "base"
  )
  protectedWB.updateText(id: protectedID, text: "dirty")
  protectedWB.confirmDiscardWorkbenchClose()
  check(protectedWB.tabs.count == 1 && protectedWB.tab(withID: protectedID)?.text == "dirty",
        "workbench discard cannot clear tabs without a pending confirmed close")

  // 12) 外部版本只可刷新 clean Tab；dirty buffer 不得被磁盘版本覆盖。
  var external = NativeFileTabsState()
  let externalID = external.openTab(url: url(rootA, "external.swift"), text: "disk-v1")
  external.replaceCleanTabFromDisk(id: externalID, text: "disk-v2")
  check(
    external.tab(withID: externalID)?.text == "disk-v2"
      && external.tab(withID: externalID)?.savedBaseline == "disk-v2"
      && external.tab(withID: externalID)?.isDirty == false,
    "a clean tab adopts a newly read external disk version"
  )
  external.updateText(id: externalID, text: "local-dirty")
  external.replaceCleanTabFromDisk(id: externalID, text: "disk-v3")
  check(
    external.tab(withID: externalID)?.text == "local-dirty"
      && external.tab(withID: externalID)?.savedBaseline == "disk-v2"
      && external.tab(withID: externalID)?.isDirty == true,
    "an external refresh never overwrites a dirty local buffer"
  )
}
