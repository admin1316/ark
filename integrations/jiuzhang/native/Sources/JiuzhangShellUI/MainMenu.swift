import AppKit
import Combine

/// User-visible product name for the native shell.
public let jiuzhangVisibleApplicationName = "Ark"
extension Notification.Name {
  public static let arkShowSettings = Notification.Name("cn.jiuzhangtianmu.ark.show-settings")
  public static let arkBeginNewConversation = Notification.Name("cn.jiuzhangtianmu.ark.begin-new-conversation")
  public static let arkLanguageChanged = Notification.Name("cn.jiuzhangtianmu.ark.language-changed")
}

/// Native owner for the global new-conversation command. AppKit resolves
/// Command-N before the focused composer or an input method can consume it.
@MainActor
final class NativeConversationCommandCenter: NSObject {
  static let shared = NativeConversationCommandCenter()

  @objc func beginNewConversation(_ sender: NSMenuItem) {
    NotificationCenter.default.post(name: .arkBeginNewConversation, object: nil)
  }
}

/// Single native owner for Workbench keyboard commands. AppKit resolves these
/// menu equivalents before the focused editor or Terminal input field, then
/// publishes the typed tool intent to whichever Workbench surface is mounted.
@MainActor
final class NativeWorkbenchCommandCenter: NSObject {
  static let shared = NativeWorkbenchCommandCenter()

  let openTool = PassthroughSubject<NativeWorkbenchTabKind, Never>()

  @objc func routeWorkbenchTool(_ sender: NSMenuItem) {
    guard let rawValue = sender.representedObject as? String,
          let kind = NativeWorkbenchTabKind(rawValue: rawValue)
    else { return }
    openTool.send(kind)
  }
}

/// Build the standard macOS menus used by the native Jiuzhang application.
///
/// Edit actions intentionally have no explicit target. AppKit therefore sends
/// them through the first-responder chain to the focused native text control.
@MainActor
public func makeJiuzhangMainMenu(applicationName: String, language: String = "zh") -> NSMenu {
  makeJiuzhangMainMenu(
    applicationName: applicationName,
    language: ArkLanguagePreference(rawValue: language)
  )
}

/// Build the menu from the native localization registry, including registered
/// third-party language packs. The String overload remains source-compatible
/// for callers that only know the historical zh/en identifiers.
@MainActor
public func makeJiuzhangMainMenu(
  applicationName: String,
  language: ArkLanguagePreference
) -> NSMenu {
  func localized(_ key: ArkL10n.Key) -> String {
    ArkL10n.text(key, language)
  }
  func formatted(_ key: ArkL10n.Key, _ argument: String) -> String {
    ArkL10n.format(key, language, arguments: [argument])
  }
  let mainMenu = NSMenu(title: "MainMenu")

  let applicationItem = NSMenuItem(title: applicationName, action: nil, keyEquivalent: "")
  let applicationMenu = NSMenu(title: applicationName)
  applicationMenu.addItem(
    withTitle: formatted(.menuAbout, applicationName),
    action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
    keyEquivalent: ""
  )
  applicationMenu.addItem(.separator())
  let settings = applicationMenu.addItem(
    withTitle: localized(.menuSettings),
    action: Selector(("showArkSettings:")),
    keyEquivalent: ","
  )
  settings.keyEquivalentModifierMask = [.command]
  // Contract tests build the menu without booting NSApplication. At runtime
  // AppDelegate installs the menu after assigning itself, so keep the direct
  // target when present and avoid dereferencing the global NSApp when absent.
  if let application = NSApp {
    settings.target = application.delegate
  }
  applicationMenu.addItem(.separator())
  applicationMenu.addItem(
    withTitle: formatted(.menuHide, applicationName),
    action: #selector(NSApplication.hide(_:)),
    keyEquivalent: "h"
  )
  let hideOthers = applicationMenu.addItem(
    withTitle: localized(.menuHideOthers),
    action: #selector(NSApplication.hideOtherApplications(_:)),
    keyEquivalent: "h"
  )
  hideOthers.keyEquivalentModifierMask = [.command, .option]
  applicationMenu.addItem(
    withTitle: localized(.menuShowAll),
    action: #selector(NSApplication.unhideAllApplications(_:)),
    keyEquivalent: ""
  )
  applicationMenu.addItem(.separator())
  applicationMenu.addItem(
    withTitle: formatted(.menuQuit, applicationName),
    action: #selector(NSApplication.terminate(_:)),
    keyEquivalent: "q"
  )
  applicationItem.submenu = applicationMenu
  mainMenu.addItem(applicationItem)

  let fileTitle = localized(.menuFile)
  let fileItem = NSMenuItem(title: fileTitle, action: nil, keyEquivalent: "")
  let fileMenu = NSMenu(title: fileTitle)
  let newConversation = fileMenu.addItem(
    withTitle: localized(.newConversation),
    action: #selector(NativeConversationCommandCenter.beginNewConversation(_:)),
    keyEquivalent: "n"
  )
  newConversation.target = NativeConversationCommandCenter.shared
  newConversation.keyEquivalentModifierMask = [.command]
  newConversation.identifier = NSUserInterfaceItemIdentifier("ark.menu.new-conversation")
  fileItem.submenu = fileMenu
  mainMenu.addItem(fileItem)

  let editTitle = localized(.menuEdit)
  let editItem = NSMenuItem(title: editTitle, action: nil, keyEquivalent: "")
  let editMenu = NSMenu(title: editTitle)
  addEditItem(to: editMenu, title: localized(.menuUndo), actionName: "undo:", keyEquivalent: "z")
  addEditItem(
    to: editMenu,
    title: localized(.menuRedo),
    actionName: "redo:",
    keyEquivalent: "z",
    modifiers: [.command, .shift]
  )
  editMenu.addItem(.separator())
  addEditItem(to: editMenu, title: localized(.menuCut), actionName: "cut:", keyEquivalent: "x")
  addEditItem(to: editMenu, title: localized(.menuCopy), actionName: "copy:", keyEquivalent: "c")
  addEditItem(to: editMenu, title: localized(.menuPaste), actionName: "paste:", keyEquivalent: "v")
  editMenu.addItem(.separator())
  addEditItem(to: editMenu, title: localized(.menuSelectAll), actionName: "selectAll:", keyEquivalent: "a")
  editItem.submenu = editMenu
  mainMenu.addItem(editItem)

  let workbenchTitle = localized(.workbench)
  let workbenchItem = NSMenuItem(title: workbenchTitle, action: nil, keyEquivalent: "")
  let workbenchMenu = NSMenu(title: workbenchTitle)
  addWorkbenchItem(
    to: workbenchMenu,
    title: NativeWorkbenchTabKind.review.title(language),
    kind: .review,
    keyEquivalent: "g",
    modifiers: [.control, .shift]
  )
  addWorkbenchItem(
    to: workbenchMenu,
    title: NativeWorkbenchTabKind.terminal.title(language),
    kind: .terminal,
    keyEquivalent: "`",
    modifiers: [.control]
  )
  addWorkbenchItem(
    to: workbenchMenu,
    title: NativeWorkbenchTabKind.browser.title(language),
    kind: .browser,
    keyEquivalent: "t",
    modifiers: [.command]
  )
  addWorkbenchItem(
    to: workbenchMenu,
    title: NativeWorkbenchTabKind.files.title(language),
    kind: .files,
    keyEquivalent: "p",
    modifiers: [.command]
  )
  workbenchItem.submenu = workbenchMenu
  mainMenu.addItem(workbenchItem)

  return mainMenu
}

@MainActor
private func addWorkbenchItem(
  to menu: NSMenu,
  title: String,
  kind: NativeWorkbenchTabKind,
  keyEquivalent: String,
  modifiers: NSEvent.ModifierFlags
) {
  let item = NSMenuItem(
    title: title,
    action: #selector(NativeWorkbenchCommandCenter.routeWorkbenchTool(_:)),
    keyEquivalent: keyEquivalent
  )
  item.target = NativeWorkbenchCommandCenter.shared
  item.representedObject = kind.rawValue
  item.keyEquivalentModifierMask = modifiers
  item.identifier = NSUserInterfaceItemIdentifier("ark.menu.workbench.\(kind.rawValue)")
  menu.addItem(item)
}

@MainActor
private func addEditItem(
  to menu: NSMenu,
  title: String,
  actionName: String,
  keyEquivalent: String,
  modifiers: NSEvent.ModifierFlags = [.command]
) {
  let item = NSMenuItem(
    title: title,
    action: Selector(actionName),
    keyEquivalent: keyEquivalent
  )
  item.target = nil
  item.keyEquivalentModifierMask = modifiers
  menu.addItem(item)
}
