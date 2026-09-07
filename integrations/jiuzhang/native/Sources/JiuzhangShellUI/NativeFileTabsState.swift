import Foundation

/// 文件级多 Tab 的一个 Tab：identity 是 canonicalPath（不是文件名）。
public struct NativeFileTabState: Identifiable, Equatable, Sendable {
  public let id: UUID
  public let url: URL
  public let canonicalPath: String
  public var text: String
  public var savedBaseline: String

  public var isDirty: Bool { text != savedBaseline }

  public init(id: UUID, url: URL, text: String) {
    self.id = id
    self.url = url
    self.canonicalPath = Self.canonicalPath(for: url)
    self.text = text
    self.savedBaseline = text
  }

  public static func canonicalPath(for url: URL) -> String {
    url.standardizedFileURL.resolvingSymlinksInPath().path
  }
}

/// 多文件 Tab 纯状态机（可单测）：
/// - canonicalPath 唯一 identity，由状态机内部强制：同路径永远一个 Tab，
///   同名不同路径是两个 Tab；
/// - 切换只改 active；单 Tab close：clean 直接关、dirty 先 pending 确认；
/// - 工作台级破坏性关闭走显式 request/cancel/confirmDiscard transition，
///   不存在任何能无条件清掉 dirty Tabs 的公开 API；
/// - 编辑缓冲与保存完成都按捕获的 Tab ID 写回，异步保存不会串到别的 Tab；
/// - active 关闭后的激活规则固定：删除后原位置仍存在 → 激活它（原右侧），
///   否则激活最后一个（原左侧）；无 Tab → active=nil。
public struct NativeFileTabsState: Equatable, Sendable {
  public private(set) var tabs: [NativeFileTabState] = []
  public private(set) var activeTabID: UUID?
  public private(set) var pendingCloseTabID: UUID?
  public private(set) var pendingWorkbenchClose = false

  public init() {}

  public var activeTab: NativeFileTabState? {
    guard let activeTabID else { return nil }
    return tabs.first { $0.id == activeTabID }
  }

  public var activeIndex: Int? {
    guard let activeTabID else { return nil }
    return tabs.firstIndex { $0.id == activeTabID }
  }

  public var hasDirtyTabs: Bool { tabs.contains { $0.isDirty } }

  public func indexOf(canonicalPath: String) -> Int? {
    tabs.firstIndex { $0.canonicalPath == canonicalPath }
  }

  public func tab(withID id: UUID) -> NativeFileTabState? {
    tabs.first { $0.id == id }
  }

  /// 打开（或激活）一个已读好的文件。canonicalPath 唯一性由状态机强制：
  /// 已存在 → 只激活既有 Tab（不覆盖其 dirty 文本）；不存在 → 新建并激活。
  @discardableResult
  public mutating func openTab(url: URL, text: String, activate: Bool = true) -> UUID {
    let canonical = NativeFileTabState.canonicalPath(for: url)
    if let existing = tabs.first(where: { $0.canonicalPath == canonical }) {
      if activate { activeTabID = existing.id }
      return existing.id
    }
    let tab = NativeFileTabState(id: UUID(), url: url, text: text)
    tabs.append(tab)
    if activate { activeTabID = tab.id }
    return tab.id
  }

  /// Mount a recovered draft without touching the source file. The journal's
  /// saved baseline remains the CAS baseline, so a file changed externally
  /// after the crash still fails closed on Save.
  @discardableResult
  public mutating func openRecoveredTab(
    url: URL,
    savedBaseline: String,
    draftText: String
  ) -> UUID {
    let canonical = NativeFileTabState.canonicalPath(for: url)
    if let index = tabs.firstIndex(where: { $0.canonicalPath == canonical }) {
      activeTabID = tabs[index].id
      guard !tabs[index].isDirty else { return tabs[index].id }
      tabs[index].savedBaseline = savedBaseline
      tabs[index].text = draftText
      return tabs[index].id
    }
    var tab = NativeFileTabState(id: UUID(), url: url, text: savedBaseline)
    tab.text = draftText
    tabs.append(tab)
    activeTabID = tab.id
    return tab.id
  }

  public mutating func activate(id: UUID) {
    guard tabs.contains(where: { $0.id == id }) else { return }
    activeTabID = id
  }

  /// 编辑器按 Tab ID 写编辑缓冲（异步/切换期间也不会写错 Tab）。
  public mutating func updateText(id: UUID, text: String) {
    guard let index = tabs.firstIndex(where: { $0.id == id }) else { return }
    tabs[index].text = text
  }

  /// 保存完成：按捕获的 Tab ID + 实际写入的文本更新 baseline。
  /// 保存 A 期间切到 B 不会清 B 的 dirty。
  public mutating func markSaved(id: UUID, text: String) {
    guard let index = tabs.firstIndex(where: { $0.id == id }) else { return }
    tabs[index].savedBaseline = text
  }

  /// A clean tab may adopt a newly read on-disk version. Dirty tabs are never
  /// replaced by this path; the caller must preserve local edits and surface a
  /// save conflict instead.
  public mutating func replaceCleanTabFromDisk(id: UUID, text: String) {
    guard let index = tabs.firstIndex(where: { $0.id == id }), !tabs[index].isDirty else { return }
    tabs[index].text = text
    tabs[index].savedBaseline = text
  }

  /// 还原指定 Tab（调用方在按下时捕获 active ID）。
  public mutating func revert(id: UUID) {
    guard let index = tabs.firstIndex(where: { $0.id == id }) else { return }
    tabs[index].text = tabs[index].savedBaseline
  }

  /// 请求关闭：clean → 立即关闭并返回 false；dirty → 记 pending 并返回 true。
  @discardableResult
  public mutating func requestClose(id: UUID) -> Bool {
    guard let index = tabs.firstIndex(where: { $0.id == id }) else { return false }
    if tabs[index].isDirty {
      pendingCloseTabID = id
      return true
    }
    removeAndActivate(index: index)
    return false
  }

  public mutating func cancelClose() {
    pendingCloseTabID = nil
  }

  /// Discard：删除 pending Tab，不写盘，按激活规则处理。
  public mutating func discardClose() {
    guard let pendingCloseTabID,
          let index = tabs.firstIndex(where: { $0.id == pendingCloseTabID })
    else {
      self.pendingCloseTabID = nil
      return
    }
    self.pendingCloseTabID = nil
    removeAndActivate(index: index)
  }

  /// 工作台级破坏性关闭：存在 dirty Tabs 时返回 true（需要确认）；clean 时仅返回 false，不动任何状态。
  @discardableResult
  public mutating func requestWorkbenchClose() -> Bool {
    if hasDirtyTabs {
      pendingWorkbenchClose = true
      return true
    }
    return false
  }

  public mutating func cancelWorkbenchClose() {
    pendingWorkbenchClose = false
  }

  /// 仅在 pendingWorkbenchClose 已置位时生效：清空全部 Tabs（不写任何源文件）。
  public mutating func confirmDiscardWorkbenchClose() {
    guard pendingWorkbenchClose else { return }
    tabs = []
    activeTabID = nil
    pendingCloseTabID = nil
    pendingWorkbenchClose = false
  }

  private mutating func removeAndActivate(index: Int) {
    let wasActive = tabs[index].id == activeTabID
    tabs.remove(at: index)
    guard wasActive else { return }
    if tabs.isEmpty {
      activeTabID = nil
    } else if index < tabs.count {
      activeTabID = tabs[index].id
    } else {
      activeTabID = tabs[tabs.count - 1].id
    }
  }
}
