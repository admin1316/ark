import Foundation

public enum NativeWorkbenchTabKind: String, CaseIterable, Sendable {
  case review
  case terminal
  case browser
  case files

  fileprivate var isSingleton: Bool {
    switch self {
    case .review, .files: return true
    case .terminal, .browser: return false
    }
  }
}

public struct NativeWorkbenchToolTab: Identifiable, Equatable, Sendable {
  public let id: String
  public let kind: NativeWorkbenchTabKind
  public let ordinal: Int

  public init(id: String, kind: NativeWorkbenchTabKind, ordinal: Int = 1) {
    self.id = id
    self.kind = kind
    self.ordinal = ordinal
  }
}

/// Pure state machine for the product-owned Workbench tab strip.
/// Review/Files focus their existing singleton; Terminal/Browser
/// mint independent tab identities for their later per-tab runtime state.
public struct NativeWorkbenchTabsState: Equatable, Sendable {
  public private(set) var tabs: [NativeWorkbenchToolTab]
  public private(set) var activeTabID: String?
  private var nextTerminal = 1
  private var nextBrowser = 1

  public init(initial: NativeWorkbenchTabKind? = .files) {
    if let initial {
      let tab = Self.singletonTab(initial)
      tabs = [tab]
      activeTabID = tab.id
      if initial == .terminal { nextTerminal = 2 }
      if initial == .browser { nextBrowser = 2 }
    } else {
      tabs = []
      activeTabID = nil
    }
  }

  public var activeTab: NativeWorkbenchToolTab? {
    guard let activeTabID else { return nil }
    return tabs.first { $0.id == activeTabID }
  }

  @discardableResult
  public mutating func open(_ kind: NativeWorkbenchTabKind) -> String {
    if kind.isSingleton,
       let existing = tabs.first(where: { $0.kind == kind }) {
      activeTabID = existing.id
      return existing.id
    }

    let tab: NativeWorkbenchToolTab
    switch kind {
    case .terminal:
      tab = NativeWorkbenchToolTab(id: "terminal:\(nextTerminal)", kind: kind, ordinal: nextTerminal)
      nextTerminal += 1
    case .browser:
      tab = NativeWorkbenchToolTab(id: "browser:\(nextBrowser)", kind: kind, ordinal: nextBrowser)
      nextBrowser += 1
    case .review, .files:
      tab = Self.singletonTab(kind)
    }
    tabs.append(tab)
    activeTabID = tab.id
    return tab.id
  }

  public mutating func activate(_ id: String) {
    guard tabs.contains(where: { $0.id == id }) else { return }
    activeTabID = id
  }

  public mutating func close(_ id: String) {
    guard let index = tabs.firstIndex(where: { $0.id == id }) else { return }
    let wasActive = activeTabID == id
    tabs.remove(at: index)
    guard wasActive else { return }
    if tabs.indices.contains(index) {
      activeTabID = tabs[index].id
    } else {
      activeTabID = tabs.last?.id
    }
  }

  private static func singletonTab(_ kind: NativeWorkbenchTabKind) -> NativeWorkbenchToolTab {
    switch kind {
    case .review: return NativeWorkbenchToolTab(id: "review", kind: kind)
    case .files: return NativeWorkbenchToolTab(id: "files", kind: kind)
    case .terminal: return NativeWorkbenchToolTab(id: "terminal:1", kind: kind)
    case .browser: return NativeWorkbenchToolTab(id: "browser:1", kind: kind)
    }
  }
}
