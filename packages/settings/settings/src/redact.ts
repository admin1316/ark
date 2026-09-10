/**
 * Structural secret redaction for settings values. `role('secret')` fields are
 * removed from a value before it crosses a wire boundary; a sidecar records
 * each schema-declared secret position and whether it currently holds a value,
 * so a configuration surface can render a write-only input without ever
 * receiving the secret itself.
 * @module @deepseek-ai/dsh-settings/redact
 */

import type z from '@deepseek-ai/schemastery'

/**
 * Minimal structural view of a live schemastery node. Only the relations the
 * redactor walks are named; everything else on the instance is ignored.
 */
interface SchemaNode {
  /** Schemastery assigns a non-configurable identity to every live node. */
  uid: number
  type?: string
  meta?: { role?: unknown }
  /** `object` properties, keyed by property name. */
  dict?: Record<string, SchemaNode>
  /** `dict`/`array` element schema. */
  inner?: SchemaNode
  /** `dict` key schema participates in serialized references, but secret keys cannot cross the wire. */
  sKey?: SchemaNode
  list?: SchemaNode[]
}

/** One schema-declared secret position inside a redacted value. */
export interface RedactedSecret {
  /** Path from the section root to the removed field (concrete dict keys and array indexes included). */
  path: string[]
  /** Whether the field held a value before redaction. */
  set: boolean
}

/** A value with every `role('secret')` field removed, plus the removal record. */
export interface RedactedValue {
  /** Detached copy of the input with secret fields absent. */
  value: unknown
  /**
   * Every reachable secret position: object properties always (even unset, so
   * a form knows the slot exists), dict entries and array items only where the
   * value has them.
   */
  secrets: RedactedSecret[]
}

/** Whether a value is a plain data object the walker may recurse into. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function children(node: SchemaNode): SchemaNode[] {
  return [...Object.values(node.dict ?? {}), ...[node.inner, node.sKey].filter(child => child !== undefined), ...node.list ?? []]
}

function assertPublicKeys(node: SchemaNode): void {
  if (node.sKey !== undefined && containsSecret(node.sKey)) throw new TypeError('settings cannot expose secret dictionary keys')
}

function containsSecret(node: SchemaNode, seen = new Set<SchemaNode>()): boolean {
  if (seen.has(node)) return false
  seen.add(node)
  return node.meta?.role === 'secret' || children(node).some(child => containsSecret(child, seen))
}

function setProperty(record: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true })
}

function walk(node: SchemaNode | undefined, value: unknown, path: string[], secrets: RedactedSecret[]): unknown {
  if (node === undefined) return value
  if (node.meta?.role === 'secret') {
    secrets.push({ path, set: value !== undefined })
    return undefined
  }
  const shapeMatches = node.type === 'object' || node.type === 'dict' ? isRecord(value)
    : node.type === 'array' || node.type === 'tuple' ? Array.isArray(value) : true
  if (value !== undefined && !shapeMatches && containsSecret(node)) {
    throw new TypeError('settings cannot safely redact a malformed secret-bearing container')
  }
  switch (node.type) {
    case 'object': {
      const properties = node.dict ?? {}
      const source = isRecord(value) ? value : undefined
      const rebuilt: Record<string, unknown> = {}
      if (source !== undefined) {
        for (const [key, entry] of Object.entries(source)) {
          if (Object.hasOwn(properties, key)) continue
          setProperty(rebuilt, key, entry)
        }
      }
      for (const [key, child] of Object.entries(properties)) {
        const original = source !== undefined && Object.hasOwn(source, key) ? source[key] : undefined
        const stripped = walk(child, original, [...path, key], secrets)
        if (stripped !== undefined) setProperty(rebuilt, key, stripped)
      }
      return source === undefined && Object.keys(rebuilt).length === 0 ? value : rebuilt
    }
    case 'dict': {
      assertPublicKeys(node)
      if (!isRecord(value)) return value
      const rebuilt: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(value)) {
        const stripped = walk(node.inner, entry, [...path, key], secrets)
        if (stripped !== undefined) setProperty(rebuilt, key, stripped)
      }
      return rebuilt
    }
    case 'array': {
      if (!Array.isArray(value)) return value
      return value.map((entry, index) => walk(node.inner, entry, [...path, String(index)], secrets) ?? null)
    }
    case 'union':
    case 'intersect':
      // All branches constrain secrecy, even when another branch accepts the same value.
      return (node.list ?? []).reduce<unknown>((current, branch) => walk(branch, current, path, secrets), value)
    case 'tuple':
      if (!Array.isArray(value)) return value
      return value.map((entry, index) => walk(node.list?.[index], entry, [...path, String(index)], secrets) ?? null)
    default:
      if (containsSecret(node)) throw new TypeError(`settings cannot safely redact schema type "${node.type ?? 'unknown'}"`)
      return value
  }
}

/**
 * Remove every `role('secret')` field a schema declares from a value. The
 * walker follows object, dict, array, tuple, union, and intersection relations.
 * Unsupported or malformed secret-bearing containers reject instead of returning
 * their values, including schema defaults and overridden layers. Secret array
 * positions become null so indexes remain stable.
 * @param schema - live schemastery schema describing the value.
 * @param value - the value to strip; `undefined` yields an empty record with
 *   object-property secret slots still enumerated.
 * @returns the stripped detached value and the ordered secret positions.
 */
export function redactSecrets(schema: z<never>, value: unknown): RedactedValue {
  const secrets: RedactedSecret[] = []
  const stripped = walk(schema, value, [], secrets)
  const unique = new Map<string, RedactedSecret>()
  for (const secret of secrets) {
    const key = JSON.stringify(secret.path)
    const previous = unique.get(key)
    unique.set(key, { path: secret.path, set: secret.set || previous?.set === true })
  }
  return { value: stripped, secrets: [...unique.values()] }
}

/**
 * Serialize form metadata with secret values removed from every default layer.
 * @param schema - live namespace schema, including shared schema nodes.
 * @returns its detached schemastery envelope, safe from schema-declared default secrets.
 */
export function redactSettingsSchema(schema: z<never>): unknown {
  const nodes = new Map<number, SchemaNode>()
  const visited = new Set<SchemaNode>()
  const visit = (node: SchemaNode) => {
    if (visited.has(node)) return
    visited.add(node)
    assertPublicKeys(node)
    nodes.set(node.uid, node)
    for (const child of children(node)) visit(child)
  }
  visit(schema)
  const envelope: unknown = schema.toJSON()
  if (!isRecord(envelope) || !isRecord(envelope['refs'])) throw new TypeError('settings schema has no serialized references')
  for (const [id, serialized] of Object.entries(envelope['refs'])) {
    const node = nodes.get(Number(id))
    if (node === undefined || !isRecord(serialized)) throw new TypeError('settings schema has an unrecognized reference')
    if (!containsSecret(node)) continue
    if (node.meta?.role === 'secret' && node.type === 'const') {
      throw new TypeError('settings cannot expose a secret literal schema')
    }
    const meta = serialized['meta']
    if (isRecord(meta) && Object.hasOwn(meta, 'default')) {
      const stripped = walk(node, meta['default'], [], [])
      if (stripped === undefined) delete meta['default']
      else setProperty(meta, 'default', stripped)
    }
  }
  return envelope
}
