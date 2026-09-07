import AppKit
import Darwin
import JiuzhangShellUI

if let helperStatus = NativePTYTerminalChild.exitStatusIfRequested() {
  Darwin._exit(helperStatus)
}

MainActor.assumeIsolated {
  let application = NSApplication.shared
  let delegate = AppDelegate()
  application.delegate = delegate
  application.run()
  withExtendedLifetime(delegate) {}
}
