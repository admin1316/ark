/** Execute the shipped Native localization owner for every declared key. */
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)

// Ark's UI dictionaries are Swift values. Compile the production owner on the
// native platform instead of accepting an empty scan of retired Web packages.
it.runIf(process.platform === 'darwin')('resolves every Native key in both built-in languages and preserves fallback ownership', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'ark-locale-contract-'))
  try {
    const main = join(scratch, 'main.swift')
    const executable = join(scratch, 'locale-contract')
    await writeFile(main, `import Foundation
var failures: [String] = []
func check(_ condition: Bool, _ label: String) {
  if !condition { failures.append(label) }
}
func placeholders(_ value: String) -> [String] {
  let pattern = try! NSRegularExpression(pattern: #"\\{[0-9]+\\}"#)
  let source = value as NSString
  return pattern.matches(in: value, range: NSRange(location: 0, length: source.length))
    .map { source.substring(with: $0.range) }.sorted()
}
let keys = ArkL10n.Key.allCases
check(!keys.isEmpty, "empty key registry")
for key in keys {
  let zh = ArkL10n.text(key, .zh)
  let en = ArkL10n.text(key, .en)
  check(!zh.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "empty zh: \\(key)")
  check(!en.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "empty en: \\(key)")
  check(zh != key.rawValue && en != key.rawValue, "unresolved key: \\(key)")
  check(placeholders(zh) == placeholders(en), "format mismatch: \\(key)")
  check(ArkL10n.text(key, ArkLanguagePreference(rawValue: "missing-pack")) == en, "fallback: \\(key)")
}
let first = keys[0]
check(!ArkL10n.register(language: ArkLanguageDefinition(id: "en", displayName: "Override", translations: [first.rawValue: "changed"])), "built-in replacement")
check(ArkL10n.register(language: ArkLanguageDefinition(id: "contract-pack", displayName: "Contract", translations: [first.rawValue: "custom"])), "custom registration")
let custom = ArkLanguagePreference(rawValue: "contract-pack")
check(ArkL10n.text(first, custom) == "custom", "custom translation")
for key in keys.dropFirst() {
  check(ArkL10n.text(key, custom) == ArkL10n.text(key, .en), "partial fallback: \\(key)")
}
check(ArkL10n.unregisterLanguage(id: "contract-pack"), "custom removal")
check(ArkL10n.text(first, custom) == ArkL10n.text(first, .en), "removed fallback")
print(String(data: try JSONEncoder().encode(failures), encoding: .utf8)!)
`)
    const sourceRoot = resolve('integrations/jiuzhang/native/Sources/JiuzhangShellUI')
    await execute('swiftc', [
      '-module-cache-path', join(scratch, 'modules'),
      join(sourceRoot, 'ArkLanguagePreference.swift'),
      join(sourceRoot, 'ArkL10n.swift'), main, '-o', executable,
    ], { timeout: 120_000 })
    const result = await execute(executable, [], { timeout: 10_000 })
    expect(result.stdout.trim()).toBe('[]')
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}, 150_000)
