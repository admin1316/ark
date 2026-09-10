import Foundation

/// One provider-login method contributed by a native extension.
public struct ArkProviderLoginMethod: Identifiable, Hashable, Sendable {
  public let id: String
  public let displayName: String

  public init(id: String, displayName: String) {
    self.id = id
    self.displayName = displayName
  }
}

/// Provider settings-page login control contributed by a native extension.
/// The callback owns the actual OAuth/API-key flow and must keep secrets out of
/// the UI model and UserDefaults.
public struct ArkProviderLoginControl: Identifiable, Sendable {
  public let id: String
  public let providerID: String
  public let title: String
  public let detail: String
  public let methods: [ArkProviderLoginMethod]
  public let begin: @Sendable (String) -> Void
  public let cancel: @Sendable () -> Void

  public init(
    id: String,
    providerID: String,
    title: String,
    detail: String = "",
    methods: [ArkProviderLoginMethod],
    begin: @escaping @Sendable (String) -> Void,
    cancel: @escaping @Sendable () -> Void = {}
  ) {
    self.id = id
    self.providerID = providerID
    self.title = title
    self.detail = detail
    self.methods = methods
    self.begin = begin
    self.cancel = cancel
  }
}

/// Native extension seats for provider login controls.
///
/// Controls are value-owned and process-local. Registration returns a disposer
/// so a plugin's unload cannot leave a stale button calling a retired flow.
public enum ArkProviderLoginRegistry {
  private static let lock = NSLock()
  private static var entries: [String: ArkProviderLoginControl] = [:]

  /// Register a provider login control, or return `nil` on invalid/duplicate input.
  public static func register(_ control: ArkProviderLoginControl) -> (() -> Void)? {
    let id = control.id.trimmingCharacters(in: .whitespacesAndNewlines)
    let provider = control.providerID.trimmingCharacters(in: .whitespacesAndNewlines)
    guard id == control.id, provider == control.providerID,
          !id.isEmpty, !provider.isEmpty, !control.title.isEmpty, !control.methods.isEmpty,
          control.methods.allSatisfy({ !$0.id.isEmpty && !$0.displayName.isEmpty }),
          Set(control.methods.map(\.id)).count == control.methods.count
    else { return nil }
    let key = provider + "\u{0}" + id
    lock.lock()
    guard entries[key] == nil else {
      lock.unlock()
      return nil
    }
    entries[key] = control
    lock.unlock()
    return {
      lock.lock()
      if entries[key]?.id == control.id { entries.removeValue(forKey: key) }
      lock.unlock()
    }
  }

  /// Return a stable snapshot of controls for one provider route.
  public static func controls(for providerID: String) -> [ArkProviderLoginControl] {
    lock.lock()
    let result = entries.values
      .filter { $0.providerID == providerID }
      .sorted { $0.id < $1.id }
    lock.unlock()
    return result
  }
}
