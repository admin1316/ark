/** Duplicate-install-safe JSON and immutable-value helpers. @module @deepseek-ai/dsh-util-values */

/**
 * Lossless JSON scalars, dense ordinary arrays, and plain or null-prototype records.
 * Runtime validation rejects non-finite numbers, negative zero, and own properties
 * that JSON would discard; TypeScript's `number` cannot express these restrictions.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/**
 * Mark an unreachable closed-union branch.
 * @param value - impossible value; an unhandled typed variant fails at the call site.
 * @param context - optional switch-site label included in the failure message.
 * @returns never; a runtime value that escaped its type always throws.
 */
export function assertNever(value: never, context?: string): never {
  const rendered = (JSON.stringify(value) as string | undefined) ?? String(value)
  throw new Error(`unreachable variant${context ? ` in ${context}` : ''}: ${rendered}`)
}

/**
 * Match own-property presence without reading values or rejecting unrelated keys.
 * Forbidden keys are checked first; both lists short-circuit in their given order.
 * @param value - object whose own keys are inspected; proxy trap errors propagate.
 * @param required - keys that must be own properties, including values of `undefined`.
 * @param forbidden - keys that must not be own properties; inherited keys do not count.
 * @returns whether every required key is present and every forbidden key is absent.
 */
export function matchesOwnKeyPattern(
  value: object,
  required: readonly PropertyKey[],
  forbidden: readonly PropertyKey[],
): boolean {
  return forbidden.every(key => !Object.hasOwn(value, key))
    && required.every(key => Object.hasOwn(value, key))
}

/** Whether a realm-owned intrinsic prototype is backed by its native constructor. */
function hasIntrinsicConstructor(prototype: object, name: 'Array' | 'Object'): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'constructor')
  const constructor: unknown = descriptor?.value
  if (typeof constructor !== 'function') return false
  try {
    return constructor.name === name
      && constructor.prototype === prototype
      && Function.prototype.toString.call(constructor) === `function ${name}() { [native code] }`
  } catch {
    return false
  }
}

/** Whether a candidate is one realm's intrinsic `Object.prototype`. */
function isIntrinsicObjectPrototype(value: object): boolean {
  return Object.getPrototypeOf(value) === null && hasIntrinsicConstructor(value, 'Object')
}

/** Whether an array uses one realm's intrinsic `Array.prototype`, not a subclass or forged prototype. */
function hasPlainArrayPrototype(value: unknown[]): boolean {
  const prototype: unknown = Object.getPrototypeOf(value)
  if (!Array.isArray(prototype) || !hasIntrinsicConstructor(prototype, 'Array')) return false
  const objectPrototype: unknown = Object.getPrototypeOf(prototype)
  return typeof objectPrototype === 'object'
    && objectPrototype !== null
    && isIntrinsicObjectPrototype(objectPrototype)
}

/** Whether an object is a plain or null-prototype record from any JavaScript realm. */
function hasPlainObjectPrototype(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === null
    || typeof prototype === 'object' && isIntrinsicObjectPrototype(prototype)
}

/** Return every JSON-visible object key, or reject own data JSON would discard. */
function enumerableStringKeys(value: object): string[] | undefined {
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(value, key))) return undefined
  return keys as string[]
}

type SnapshotDestination =
  | { kind: 'root' }
  | { kind: 'array'; target: JsonValue[]; index: number }
  | { kind: 'object'; target: { [key: string]: JsonValue }; key: string }

type JsonWalkTask =
  | { kind: 'visit'; value: unknown; destination?: SnapshotDestination }
  | { kind: 'array-item'; source: unknown[]; index: number; target?: JsonValue[] }
  | { kind: 'object-property'; source: Record<string, unknown>; key: string; target?: { [key: string]: JsonValue } }
  | { kind: 'leave'; source: object }

/** Validate lossless JSON iteratively, optionally materializing a detached snapshot. */
function walkJsonValue(value: unknown, detach: boolean): JsonValue | true | undefined {
  const ancestors = new Set<object>()
  let root: JsonValue | undefined
  const assign = (destination: SnapshotDestination | undefined, item: JsonValue): void => {
    if (destination === undefined) return
    if (destination.kind === 'root') {
      root = item
    } else if (destination.kind === 'array') {
      destination.target[destination.index] = item
    } else {
      Object.defineProperty(destination.target, destination.key, {
        value: item,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
  }

  const tasks: JsonWalkTask[] = [{
    kind: 'visit',
    value,
    ...(detach ? { destination: { kind: 'root' } as const } : {}),
  }]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.kind === 'leave') {
      ancestors.delete(task.source)
      continue
    }
    if (task.kind === 'array-item') {
      if (!Object.prototype.hasOwnProperty.call(task.source, task.index)) return undefined
      tasks.push({
        kind: 'visit',
        value: task.source[task.index],
        ...(task.target === undefined ? {} : { destination: { kind: 'array', target: task.target, index: task.index } as const }),
      })
      continue
    }
    if (task.kind === 'object-property') {
      tasks.push({
        kind: 'visit',
        value: task.source[task.key],
        ...(task.target === undefined ? {} : { destination: { kind: 'object', target: task.target, key: task.key } as const }),
      })
      continue
    }

    const current = task.value
    if (current === null) {
      assign(task.destination, null)
      continue
    }
    if (typeof current === 'boolean' || typeof current === 'string') {
      assign(task.destination, current)
      continue
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0)) return undefined
      assign(task.destination, current)
      continue
    }
    if (typeof current !== 'object') return undefined
    if (ancestors.has(current)) return undefined

    if (Array.isArray(current)) {
      if (!hasPlainArrayPrototype(current)) return undefined
      const length = current.length
      if (Reflect.ownKeys(current).length !== length + 1) return undefined
      const target = detach ? [] as JsonValue[] : undefined
      if (target !== undefined) assign(task.destination, target)
      ancestors.add(current)
      tasks.push({ kind: 'leave', source: current })
      for (let index = length - 1; index >= 0; index--) {
        tasks.push({ kind: 'array-item', source: current, index, ...(target === undefined ? {} : { target }) })
      }
      continue
    }

    if (!hasPlainObjectPrototype(current)) return undefined
    const keys = enumerableStringKeys(current)
    if (keys === undefined) return undefined
    const target = detach ? {} as { [key: string]: JsonValue } : undefined
    if (target !== undefined) assign(task.destination, target)
    ancestors.add(current)
    tasks.push({ kind: 'leave', source: current })
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]
      /* v8 ignore next -- the loop is bounded by the captured key count. */
      if (key === undefined) return undefined
      tasks.push({ kind: 'object-property', source: current as Record<string, unknown>, key, ...(target === undefined ? {} : { target }) })
    }
  }
  return detach ? root : true
}

/**
 * Validate and detach lossless JSON in one read per property, so a stateful
 * getter cannot change between validation and copying. Traversal is iterative,
 * so valid nesting is bounded by available memory rather than the JavaScript
 * call stack. Accepts ordinary arrays, plain or null-prototype objects, and JSON
 * scalars; rejects sparse, cyclic, exotic, negative-zero, and non-finite values.
 * Getter throws propagate.
 *
 * @param value - the candidate value to validate and detach.
 * @returns the detached snapshot, or `undefined` when the value is not
 *   losslessly JSON-serializable.
 */
export function snapshotJsonValue<T>(value: T): T | undefined {
  return walkJsonValue(value, true) as T | undefined
}

/**
 * Test the same lossless JSON boundary as {@link snapshotJsonValue} without
 * detaching it. Only own enumerable string properties participate; `toJSON`
 * is ignored and getters run, so persistence boundaries use the snapshotter.
 * @param value - the candidate event data to test.
 * @returns whether `value` survives JSON round-trip losslessly.
 */
export function isJsonValue(value: unknown): boolean {
  return walkJsonValue(value, false) === true
}

/**
 * Compare JSON-compatible values structurally using own enumerable record keys.
 * An inherited value cannot substitute for a missing own key.
 * @param a - one JSON-compatible value.
 * @param b - the other JSON-compatible value.
 * @returns whether both values contain the same JSON data.
 */
export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((entry, index) => deepEqualJson(entry, b[index]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every(key => Object.hasOwn(right, key) && deepEqualJson(left[key], right[key]))
}

/**
 * Deep-freeze an object graph in place while leaving live AbortSignal objects mutable.
 * @param value - value to freeze.
 * @returns the same value after every reachable enumerable child is frozen.
 */
export function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>()
  const pending: (
    | { kind: 'visit'; node: unknown }
    | { kind: 'property'; source: Record<string, unknown>; key: string }
  )[] = [{ kind: 'visit', node: value }]
  while (pending.length > 0) {
    const task = pending.pop()
    /* v8 ignore next -- the loop condition guarantees one pending task. */
    if (task === undefined) continue
    if (task.kind === 'property') {
      pending.push({ kind: 'visit', node: task.source[task.key] })
      continue
    }
    const node = task.node
    if (node === null || typeof node !== 'object') continue
    if (node instanceof AbortSignal) continue
    if (seen.has(node)) continue
    seen.add(node)
    Object.freeze(node)
    const keys = Object.keys(node)
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]
      /* v8 ignore next -- the loop is bounded by the captured key count. */
      if (key === undefined) continue
      pending.push({ kind: 'property', source: node as Record<string, unknown>, key })
    }
  }
  return value
}
