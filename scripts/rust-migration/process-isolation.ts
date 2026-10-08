/** Minimal environment passed to isolated Rust benchmark/shadow processes. */

const SAFE_ENVIRONMENT_KEYS = [
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
  'SYSTEMROOT', 'WINDIR', 'PATHEXT', 'CARGO_HOME', 'RUSTUP_HOME',
] as const

/** Drop ambient credentials and native-loader controls at the process boundary. */
export function isolatedChildEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = process.env[key]
    if (value !== undefined) result[key] = value
  }
  return result
}
