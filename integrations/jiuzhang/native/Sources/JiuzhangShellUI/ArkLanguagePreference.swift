import Foundation

/// One third-party language pack that can be registered by a native extension.
/// Keys use the stable raw values of `ArkL10n.Key`; missing keys fall back to
/// English so a partial pack never renders an empty control.
public struct ArkLanguageDefinition: Identifiable, Hashable, Sendable {
  public let id: String
  public let displayName: String
  public let localeIdentifier: String
  public let translations: [String: String]

  public init(
    id: String,
    displayName: String,
    localeIdentifier: String? = nil,
    translations: [String: String]
  ) {
    self.id = id
    self.displayName = displayName
    self.localeIdentifier = localeIdentifier ?? id
    self.translations = translations
  }
}

/// Runtime language registry shared by native UI and extension code.
///
/// Registration is process-local and intentionally does not read arbitrary
/// files or execute JavaScript. A plugin registers a value-owned dictionary,
/// and the UI takes a snapshot for its Picker. Built-in `zh` and `en` entries
/// cannot be replaced by a third party.
public enum ArkLanguageRegistry {
  private static let lock = NSLock()
  private static var custom: [String: ArkLanguageDefinition] = [:]

  /// Register or replace one third-party language pack.
  ///
  /// Invalid ids, empty labels, and attempts to replace built-ins are refused.
  /// Re-registering the same third-party id is an atomic replacement, which
  /// lets an extension hot-reload its dictionary without changing selection.
  @discardableResult
  public static func register(_ definition: ArkLanguageDefinition) -> Bool {
    let id = definition.id.trimmingCharacters(in: .whitespacesAndNewlines)
    let label = definition.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
    let locale = definition.localeIdentifier.trimmingCharacters(in: .whitespacesAndNewlines)
    guard id.range(of: #"^[A-Za-z][A-Za-z0-9_-]{0,31}$"#, options: .regularExpression) != nil,
          !label.isEmpty, label.count <= 80,
          !locale.isEmpty, locale.count <= 80,
          id != ArkLanguagePreference.zh.rawValue,
          id != ArkLanguagePreference.en.rawValue
    else { return false }
    let normalized = ArkLanguageDefinition(
      id: id,
      displayName: label,
      localeIdentifier: locale,
      translations: definition.translations
    )
    lock.lock()
    custom[id] = normalized
    lock.unlock()
    return true
  }

  /// Remove a third-party language pack. Built-ins are never removable.
  @discardableResult
  public static func unregister(id: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return custom.removeValue(forKey: id) != nil
  }

  /// Return the current built-in and third-party language choices.
  public static var availableLanguages: [ArkLanguagePreference] {
    lock.lock()
    let ids = custom.keys.sorted()
    lock.unlock()
    return [.zh, .en] + ids.map(ArkLanguagePreference.init(rawValue:))
  }

  /// Return a custom definition, if one is registered.
  public static func definition(for id: String) -> ArkLanguageDefinition? {
    lock.lock()
    defer { lock.unlock() }
    return custom[id]
  }

  /// Look up one custom translation without exposing the mutable registry.
  public static func translation(for key: String, language: ArkLanguagePreference) -> String? {
    lock.lock()
    defer { lock.unlock() }
    return custom[language.rawValue]?.translations[key]
  }
}

/// Interface language preference: controls native shell copy independently of
/// the language used by the model's answer.
public struct ArkLanguagePreference: RawRepresentable, Hashable, Identifiable, CaseIterable, Sendable {
  public let rawValue: String

  public init(rawValue: String) {
    let normalized = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
    self.rawValue = normalized.isEmpty ? "en" : normalized
  }

  public static let zh = ArkLanguagePreference(rawValue: "zh")
  public static let en = ArkLanguagePreference(rawValue: "en")

  public static var allCases: [ArkLanguagePreference] {
    ArkLanguageRegistry.availableLanguages
  }

  public var id: String { rawValue }

  public var localeIdentifier: String {
    if rawValue == Self.zh.rawValue { return "zh-Hans" }
    if rawValue == Self.en.rawValue { return "en" }
    return ArkLanguageRegistry.definition(for: rawValue)?.localeIdentifier ?? rawValue
  }

  public var displayName: String {
    if self == .zh { return "简体中文" }
    if self == .en { return "English" }
    return ArkLanguageRegistry.definition(for: rawValue)?.displayName ?? rawValue
  }
}
