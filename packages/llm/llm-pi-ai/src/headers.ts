/** Credential-header admission and legacy-settings projection for the pi-ai owner. */
import { credentialRef, isCredentialRefName, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { isCredentialHeaderName } from '@deepseek-ai/dsh-llm'
import type { RedactedValue } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import assert from 'node:assert/strict'

function required<T>(value: T | undefined): T {
  assert(value !== undefined, 'llm-pi-ai cannot redact an incomplete configuration schema')
  return value
}

function accepts(value: unknown, schema: z<never, unknown>): boolean {
  try { z.resolve(value, schema, {}); return true }
  catch { return false /* Schema rejection must not expose its value-bearing diagnostic. */ }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Hide fields absent from the provider's schema, preserving declared dictionaries and capabilities.
 * @param value - one provider profile, including retained unknown fields.
 * @param schema - the same live schema used to configure this owner.
 * @param opaqueFields - root fields redacted separately by their owning schema or dictionary.
 * @returns a detached profile and paths of removed fields; malformed values fail without echoing data.
 */
export function redactProviderCredentialFields(
  value: Record<string, unknown>, schema: z<never, unknown>, opaqueFields?: readonly string[],
): RedactedValue & { value: Record<string, unknown> }
/**
 * Project an untyped configuration layer through the provider schema.
 * @param value - retained configuration data.
 * @param schema - the owner's live configuration schema.
 * @param opaqueFields - root fields handled separately by their owner.
 * @returns detached public fields and removal paths; malformed data throws a value-free error.
 */
export function redactProviderCredentialFields(value: unknown, schema: z<never, unknown>, opaqueFields?: readonly string[]): RedactedValue
export function redactProviderCredentialFields(
  value: unknown, schema: z<never, unknown>, opaqueFields: readonly string[] = ['headers', 'credentialHeaders'],
): RedactedValue {
  const secrets: RedactedValue['secrets'] = []
  const ancestors = new Set<object>()
  const assertJson = (entry: unknown): void => {
    if (entry === null || typeof entry !== 'object') return
    if (ancestors.has(entry)) throw new TypeError('llm-pi-ai cannot safely redact cyclic provider settings')
    ancestors.add(entry)
    try {
      if (!Array.isArray(entry) && Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null) {
        throw new TypeError('llm-pi-ai cannot safely redact non-JSON provider settings')
      }
      Object.values(entry).forEach(assertJson)
    } finally { ancestors.delete(entry) }
  }
  const alternatives = (nodes: readonly z<never, unknown>[]): z<never, unknown>[] => nodes.flatMap(node =>
    node.type === 'union' ? alternatives(required(node.list)) : [node])
  const visit = (entry: unknown, nodes: readonly z<never, unknown>[], path: string[]): unknown => {
    if (entry === undefined || entry === null) return entry
    const choices = alternatives(nodes)
    if (typeof entry !== 'object') {
      if (!choices.some(node => accepts(entry, node))) throw new TypeError('llm-pi-ai cannot safely redact malformed provider settings')
      return entry
    }
    if (Array.isArray(entry)) {
      const elements = choices.filter(node => node.type === 'array').map(node => required(node.inner))
      if (elements.length === 0) throw new TypeError('llm-pi-ai cannot safely redact malformed provider settings')
      return entry.map((item, index) => visit(item, elements, [...path, String(index)]))
    }
    const objects = choices.filter(node => node.type === 'object' || node.type === 'dict')
    if (objects.length === 0) throw new TypeError('llm-pi-ai cannot safely redact malformed provider settings')
    return Object.fromEntries(Object.entries(entry).flatMap(([name, item]) => {
      // Union members may share a container while declaring different public fields.
      const children = objects.flatMap(node => node.type === 'dict'
        ? accepts(name, required(node.sKey)) ? [required(node.inner)] : []
        : Object.hasOwn(required(node.dict), name) ? [required(required(node.dict)[name])] : [])
      if (children.length === 0) {
        secrets.push({ path: [...path, name], set: item !== undefined })
        return []
      }
      return [[name, path.length === 0 && opaqueFields.includes(name) ? item : visit(item, children, [...path, name])]]
    }))
  }
  let snapshot: unknown
  try { snapshot = structuredClone(value) }
  catch { throw new TypeError('llm-pi-ai cannot safely redact non-serializable provider settings') }
  assertJson(snapshot)
  return { value: visit(snapshot, [schema], []), secrets }
}

/**
 * Validate headers and separate literal credentials from usable request fields.
 * @param provider - route used in value-free diagnostics.
 * @param source - deployment headers and reference-backed headers.
 * @param schema - the provider profile's live configuration schema.
 * @returns detached headers, validated references and any required migration fields.
 */
export function resolveProfileHeaders(provider: string, source: {
  headers?: Record<string, string>
  credentialHeaders?: Record<string, string>
}, schema: z<never, unknown>): {
  headers?: Record<string, string>
  credentialHeaders?: Record<string, CredentialRef>
  migrationRequired?: { headers: string[]; fields?: string[][] }
} {
  const headers = new Map<string, string>()
  const credentialHeaders = new Map<string, CredentialRef>()
  const legacy: string[] = []
  const fields = redactProviderCredentialFields(source, schema).secrets.filter(field => field.set).map(field => field.path)
  const seen = new Set<string>()
  const admit = (name: string, value: string) => {
    try { new Headers([[name, value]]) }
    catch { throw new Error(`llm-pi-ai: provider "${provider}" has an invalid request header`) }
    const normalized = name.toLowerCase()
    if (seen.has(normalized)) throw new Error(`llm-pi-ai: provider "${provider}" repeats a request header case-insensitively`)
    seen.add(normalized)
  }
  for (const [name, value] of Object.entries(source.headers ?? {})) {
    admit(name, value)
    if (isCredentialHeaderName(name) && value.trim() !== '') legacy.push(name)
    else headers.set(name, value)
  }
  for (const [name, reference] of Object.entries(source.credentialHeaders ?? {})) {
    admit(name, '')
    credentialHeaders.set(name, credentialRef(reference))
  }
  return { ...headers.size === 0 ? {} : { headers: Object.fromEntries(headers) },
    ...credentialHeaders.size === 0 ? {} : { credentialHeaders: Object.fromEntries(credentialHeaders) },
    ...legacy.length === 0 && fields.length === 0 ? {} : { migrationRequired: {
      headers: legacy.sort(), ...fields.length === 0 ? {} : { fields },
    } } }
}

/**
 * Redact retained literal credential headers independently in each settings layer.
 * @param value - raw or resolved provider configuration layer.
 * @param schema - the owner's live configuration schema.
 * @returns detached configuration and secret slots without credential values.
 */
export function redactPiAiSecrets(value: unknown, schema: z<never, unknown>): RedactedValue {
  if (value === undefined) return { value, secrets: [] }
  if (!record(value)) throw new TypeError('llm-pi-ai cannot safely redact malformed provider settings')
  const root = redactProviderCredentialFields(value, schema, ['providers'])
  const result = root.value
  const providers = result.providers
  if (providers === undefined) return { value: result, secrets: root.secrets }
  if (!record(providers)) throw new TypeError('llm-pi-ai cannot safely redact malformed provider settings')
  const secrets: RedactedValue['secrets'] = [...root.secrets]
  for (const [provider, profile] of Object.entries(providers)) {
    if (!record(profile)) throw new TypeError('llm-pi-ai cannot safely redact a malformed provider profile')
    const redacted = redactProviderCredentialFields(profile, required(required(required(schema.dict)['providers']).inner))
    const projected = redacted.value
    providers[provider] = projected
    secrets.push(...redacted.secrets.map(field => ({ ...field, path: ['providers', provider, ...field.path] })))
    if (projected.apiKeyEnv !== undefined && projected.apiKeyEnv !== null && projected.apiKeyEnv !== ''
      && (typeof projected.apiKeyEnv !== 'string' || !isCredentialRefName(projected.apiKeyEnv))) {
      throw new TypeError('llm-pi-ai cannot expose a malformed credential reference')
    }
    if (projected.credentialHeaders !== undefined && projected.credentialHeaders !== null) {
      if (!record(projected.credentialHeaders)
        || Object.values(projected.credentialHeaders).some(value => typeof value !== 'string' || !isCredentialRefName(value))) {
        throw new TypeError('llm-pi-ai cannot expose malformed credential-header references')
      }
    }
    if (projected.headers === undefined) continue
    if (!record(projected.headers)) throw new TypeError('llm-pi-ai cannot safely redact malformed provider headers')
    projected.headers = Object.fromEntries(Object.entries(projected.headers).filter(([name, entry]) => {
      if (!isCredentialHeaderName(name) || entry === '') {
        if (typeof entry !== 'string') throw new TypeError('llm-pi-ai cannot safely redact malformed provider headers')
        return true
      }
      secrets.push({ path: ['providers', provider, 'headers', name], set: entry !== undefined })
      return false
    }))
  }
  return { value: result, secrets }
}
