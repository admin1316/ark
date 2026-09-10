import Foundation
import JiuzhangShellUI

/// Verify native extension seats stay value-owned, deterministic, and unloadable.
func runArkNativeExtensionRegistryContractChecks() {
  let languageID = "contract-lang"
  _ = ArkLanguageRegistry.unregister(id: languageID)
  let language = ArkLanguageDefinition(
    id: languageID,
    displayName: "Contract Language",
    localeIdentifier: "contract-Latn",
    translations: ["chatDisplayTitle": "Contract conversation"]
  )
  check(
    ArkLanguageRegistry.register(language)
      && ArkLanguagePreference.allCases.contains(where: { $0.rawValue == languageID })
      && ArkL10n.text(.chatDisplayTitle, ArkLanguagePreference(rawValue: languageID))
        == "Contract conversation",
    "native extensions can register a third-party language and its UI copy"
  )
  check(
    !ArkLanguageRegistry.register(ArkLanguageDefinition(
      id: "zh", displayName: "Imposter", translations: [:]
    )),
    "native extensions cannot replace a built-in language"
  )

  let provider = "contract-provider"
  let controlID = "contract-login"
  let disposer = ArkProviderLoginRegistry.register(ArkProviderLoginControl(
    id: controlID,
    providerID: provider,
    title: "Contract login",
    methods: [ArkProviderLoginMethod(id: "oauth", displayName: "OAuth")],
    begin: { _ in }
  ))
  check(
    disposer != nil
      && ArkProviderLoginRegistry.controls(for: provider).map(\.id) == [controlID]
      && ArkProviderLoginRegistry.register(ArkProviderLoginControl(
        id: controlID,
        providerID: provider,
        title: "Duplicate",
        methods: [ArkProviderLoginMethod(id: "oauth", displayName: "OAuth")],
        begin: { _ in }
      )) == nil,
    "native extensions can add one deterministic provider login control"
  )
  disposer?()
  check(
    ArkProviderLoginRegistry.controls(for: provider).isEmpty,
    "native provider login controls disappear when their extension unloads"
  )
  _ = ArkLanguageRegistry.unregister(id: languageID)
}
