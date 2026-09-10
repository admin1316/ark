/**
 * Service Definition for the user-settings capability seam (`ctx.settings`). Providers store one raw document of
 * per-namespace sections; plugins register a namespace schema and read the
 * resolved value, which layers schema defaults, the registrant's composition
 * `base`, and the user document section, in that order.
 * @module @deepseek-ai/dsh-settings
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { openNativeTextFile } from '@deepseek-ai/dsh-native-command'
import { Remote, TypertLookupFailure, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type z from '@deepseek-ai/schemastery'
import { redactSecrets, redactSettingsSchema } from './redact.ts'
import type { RedactedSecret, RedactedValue } from './redact.ts'
import type {
  RemoteSettingsDescription, RemoteSettingsDocumentOpenResult, RemoteSettingsJsonObject,
  RemoteSettingsJsonValue, RemoteSettingsNamespaceView, RemoteSettingsPathOp,
  SettingsNamespace, SettingsUpdateSource,
} from './types.ts'

export { redactSecrets } from './redact.ts'
export type { RedactedSecret, RedactedValue } from './redact.ts'
export type { SettingsNamespace, SettingsUpdateSource } from './types.ts'

const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/

/**
 * Brand a raw string as a {@link SettingsNamespace}.
 * @param value - candidate namespace; lowercase kebab-case, as in plugin short names.
 * @returns the branded namespace.
 */
export function settingsNamespace(value: string): SettingsNamespace {
  if (!NAMESPACE_PATTERN.test(value)) {
    throw new TypeError(`settings namespace "${value}" must match ${String(NAMESPACE_PATTERN)}`)
  }
  return value as SettingsNamespace
}

/** When a namespace's changes take effect for its owner. */
export type SettingsApplies = 'live' | 'restart'

/** Registration options beyond the namespace schema. */
export interface SettingsRegisterOptions<T> {
  /** Composition-layer values resolved below the user layer (entry-config subset). */
  base?: Partial<T>
  /** Owner's effect timing, surfaced to configuration UIs; defaults to `live`. */
  applies?: SettingsApplies
  /**
   * Reject a resolved section the owner could not act on, for constraints its
   * schema cannot express — a cross-field requirement, or one field's validity
   * depending on another's. Throwing here refuses the *write* that produced the
   * value, so a caller learns at `update`/`replace`/`mutate` instead of storing
   * something that would silently disable the owner.
   *
   * Kept separate from the schema because the schema is also what a
   * configuration surface renders and what an absent section resolves through;
   * folding a cross-field check into it would change both.
   *
   * Once the owner is registered, a stored section that fails this keeps the
   * namespace's last good value and warns, exactly as a schema failure does,
   * so an externally edited document cannot strand a running owner. At
   * registration there is no last good value yet, so a stored section that
   * already fails rejects the registration itself — again exactly as a schema
   * failure does.
   * @param value - the resolved section, schema-valid by construction.
   */
  validate?: (value: T) => void
  /** Stricter validation applied only to new writes, allowing legacy data to load for migration. */
  validateWrite?: (value: T) => void
  /** Owner-specific wire redaction layered over schema roles. */
  redact?: (value: unknown) => RedactedValue
}

/** One registered namespace as surfaced to configuration UIs. */
export interface SettingsDescriptor {
  // TODO(settings-namespace-vocabulary): Rename `ns` to `namespace` across the
  // public API, provider contract, implementations, tests, and consumers.
  /** The registered namespace. */
  ns: SettingsNamespace
  /** Serialized schemastery schema (`schema.toJSON()`). */
  schema: unknown
  /** Current resolved value. */
  value: unknown
  /**
   * Monotonic revision of the raw user section this descriptor was read at.
   * Send it back as `expectedRevision` on a write to refuse a stale one.
   */
  revision: number
  /** Registrant's composition `base` layer (detached), when one was declared. */
  base?: unknown
  /**
   * Raw user section from the stored document (detached), when one exists and
   * is well-formed; a field's presence here is what marks it user-overridden.
   */
  user?: unknown
  /** Owner's declared effect timing. */
  applies: SettingsApplies
  /** Schema-declared secret positions; present only under `redactSecrets`. */
  secrets?: RedactedSecret[]
}

/** Options for {@link SettingsProvider.describe}. */
export interface SettingsDescribeOptions {
  /**
   * Strip `role('secret')` fields from `value`/`base`/`user` and enumerate
   * them in each descriptor's `secrets`. Every wire surface MUST pass this;
   * the verbatim default exists for same-process configuration UIs only.
   */
  redactSecrets?: boolean
}

/** Owner-facing handle for one registered namespace. */
export interface SettingsScope<T> {
  /** Current resolved value: schema defaults, then `base`, then the user layer. */
  get(): T
  /**
   * Observe committed changes to this namespace's resolved value. Invocations
   * of one callback run asynchronously, one at a time, in commit order; a
   * rejection is contained and logged like a sync throw. After the disposer
   * returns, no further invocation starts — one already queued is skipped;
   * one already started still settles, and service disposal waits for it.
   * @param callback - invoked after each commit with the next and previous values.
   * @returns the disposer removing this observer.
   */
  watch(callback: (next: T, prev: T) => void | Promise<void>): () => void
  /**
   * Merge a partial patch into this namespace's user layer and persist it.
   * @param patch - plain-object patch over the user section; JSON-compatible data
   * only (non-JSON values reject with their path before anything persists).
   */
  update(patch: object): Promise<void>
  /**
   * Replace this namespace's user section wholesale; absent keys re-inherit
   * the composition `base` and schema defaults (`replace({})` resets all).
   * @param section - the complete next user section; JSON-compatible data only,
   * as for {@link update}.
   */
  replace(section: object): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    settings: SettingsProvider
  }
}

/**
 * Deep equality over JSON-compatible data (objects, arrays, primitives) — the
 * Service Definition's single change-detection predicate, exported so the invariant
 * companion checks exactly the implementation's relation.
 * @param a - one JSON-compatible value.
 * @param b - the other JSON-compatible value.
 * @returns whether the two values are structurally equal.
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
 * A write refused because the namespace moved since the caller read it. The
 * Service Definition's serialized write queue orders writes; it cannot tell a fresh writer
 * from one holding a stale snapshot, which is what this reports.
 */
export class SettingsConflictError extends Error {
  /** Stable machine code for wire layers mapping this to their own taxonomy. */
  readonly code = 'SETTINGS_CONFLICT'
  /** The revision the write expected. */
  readonly expected: number
  /** The revision the namespace actually stands at. */
  readonly actual: number

  /**
   * @param ns - the namespace whose write was refused.
   * @param expected - the revision the caller sent.
   * @param actual - the revision now stored.
   */
  constructor(ns: SettingsNamespace, expected: number, actual: number) {
    super(`settings namespace "${ns}" changed since it was read (expected revision ${String(expected)}, now ${String(actual)})`)
    this.name = 'SettingsConflictError'
    this.expected = expected
    this.actual = actual
  }
}

/** A namespace cannot be replaced until its previous owner's work stops. */
export class SettingsRegistrationQuiescenceError extends Error {
  /** Replacement remains blocked while the previous registration is stopping. */
  readonly code = 'SETTINGS_REGISTRATION_QUIESCENCE_TIMEOUT'

  /**
   * @param ns - namespace whose owner is still stopping.
   * @param timeoutMs - elapsed replacement deadline.
   */
  constructor(readonly ns: SettingsNamespace, readonly timeoutMs: number) {
    super(`settings namespace "${ns}" did not quiesce within ${String(timeoutMs)}ms; replacement remains blocked`)
    this.name = 'SettingsRegistrationQuiescenceError'
  }
}

/** Whether a value is a plain data object (not an array, null, or class instance). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * One path-addressed edit to a namespace's user section. Path mutation exists
 * for a caller holding an INCOMPLETE view of the section — a configuration UI
 * reads the redacted descriptor, which by construction never received the
 * `role('secret')` fields. Such a caller can name the field it means without
 * restating the section: a wholesale `replace` rebuilt from a redacted
 * document silently deletes every secret the wire never returned.
 */
export type SettingsPathOp =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'unset'; path: readonly string[] }

/** Apply one path op to a detached section, returning the next section. */
function applyPathOp(section: Record<string, unknown>, op: SettingsPathOp): Record<string, unknown> {
  const [head, ...rest] = op.path
  // The empty path addresses the section itself.
  if (head === undefined) {
    if (op.op === 'unset') return {}
    if (!isPlainObject(op.value)) {
      throw new TypeError('settings mutate: setting the section root requires a plain object')
    }
    return { ...op.value }
  }
  if (rest.length === 0) {
    if (op.op === 'set') return { ...section, [head]: op.value }
    const { [head]: _removed, ...kept } = section
    return kept
  }
  const child = Object.hasOwn(section, head) ? section[head] : undefined
  if (!isPlainObject(child)) {
    // Unsetting through an absent path is already satisfied; setting through
    // one creates the intermediate objects it needs.
    if (op.op === 'unset') return section
    return { ...section, [head]: applyPathOp({}, { ...op, path: rest }) }
  }
  return { ...section, [head]: applyPathOp(child, { ...op, path: rest }) }
}

function validateSettingsPathOps(ns: SettingsNamespace, ops: unknown): asserts ops is SettingsPathOp[] {
  if (!Array.isArray(ops)) throw new TypeError(`settings mutate for "${ns}" must be an array of path ops`)
  for (const op of ops) {
    if (!isPlainObject(op) || (op['op'] !== 'set' && op['op'] !== 'unset')) {
      throw new TypeError(`settings mutate for "${ns}" ops must be {op:'set'|'unset', path}`)
    }
    if (!Array.isArray(op['path']) || op['path'].some(part => typeof part !== 'string')) {
      throw new TypeError(`settings mutate for "${ns}" op paths must be arrays of strings`)
    }
    if (op['op'] === 'set' && !Object.hasOwn(op, 'value')) {
      throw new TypeError(`settings mutate for "${ns}" set ops must include a JSON value`)
    }
  }
}

/** Human label for a value that lossless JSON cannot represent (numbers reject inline). */
function describeRejected(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (typeof value === 'object' && value !== null) {
    const proto = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null
    const name = proto?.constructor?.name
    return name === undefined || name === 'Object' ? 'a non-plain object' : `a ${name}`
  }
  return `a ${typeof value}`
}

/**
 * Detach and validate one write input in a single walk before persistence:
 * only JSON data (plain objects, arrays, strings, finite numbers,
 * booleans, `null`) may reach a provider document. `structuredClone` alone
 * would admit Dates, Maps, BigInts, and cycles that YAML/JSON storage then
 * silently distorts on the reload round-trip. `undefined` entries in objects
 * are skipped — the same sparse-patch semantics as {@link mergeLayers} — while
 * an `undefined` array entry is rejected rather than coerced.
 * @param root - plain-object write input (caller-checked).
 * @param reject - builds the validation error from a value label and its `$`-rooted path.
 * @returns the detached JSON-compatible clone.
 */
function cloneJsonShaped(
  root: Record<string, unknown>,
  reject: (label: string, path: string) => TypeError,
): RemoteSettingsJsonObject {
  const visiting = new WeakSet<object>()
  const clone = (value: unknown, path: string): RemoteSettingsJsonValue => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw reject('a non-finite number', path)
      if (Object.is(value, -0)) throw reject('negative zero', path)
      return value
    }
    if (Array.isArray(value)) {
      if (visiting.has(value)) throw reject('a circular reference', path)
      visiting.add(value)
      const entries: RemoteSettingsJsonValue[] = []
      for (let index = 0; index < value.length; index++) entries.push(clone(value[index], `${path}[${index}]`))
      // Un-mark on exit so one object referenced twice without a cycle passes.
      visiting.delete(value)
      return entries
    }
    if (isPlainObject(value)) return cloneObject(value, path)
    throw reject(describeRejected(value), path)
  }
  const cloneObject = (value: Record<string, unknown>, path: string): RemoteSettingsJsonObject => {
    if (visiting.has(value)) throw reject('a circular reference', path)
    visiting.add(value)
    const out: RemoteSettingsJsonObject = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue
      Object.defineProperty(out, key, {
        value: clone(entry, `${path}.${key}`), enumerable: true, writable: true, configurable: true,
      })
    }
    visiting.delete(value)
    return out
  }
  return cloneObject(root, '$')
}

/**
 * Layer `over` onto `under`: plain objects merge recursively, every other
 * value (arrays included) replaces the lower layer wholesale. `over` never
 * carries `undefined` entries — sections come from parsed documents and write
 * snapshots pass {@link cloneJsonShaped}, which strips them so a sparse patch
 * cannot erase lower keys.
 */
function mergeLayers(under: unknown, over: unknown): unknown {
  if (over === undefined) return under
  if (!isPlainObject(under) || !isPlainObject(over)) return over
  const merged: Record<string, unknown> = { ...under }
  for (const [key, value] of Object.entries(over)) {
    Object.defineProperty(merged, key, {
      value: Object.hasOwn(merged, key) ? mergeLayers(merged[key], value) : value,
      enumerable: true, writable: true, configurable: true,
    })
  }
  return merged
}

/** Recursively freeze one resolved value so handed-out snapshots stay immutable. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const entry of Object.values(value)) deepFreeze(entry)
  return Object.freeze(value)
}

/** One registered watcher and its serialized invocation chain. */
interface SettingsWatcher {
  callback: (next: never, prev: never) => void | Promise<void>
  /** Settled tail: invocations of this callback run one at a time, in commit order. */
  tail: Promise<void>
  /** Cleared by the disposer: a queued invocation checks this before starting. */
  active: boolean
}

/** One live namespace registration owned by a registrant fiber. */
interface SettingsRegistration {
  ns: SettingsNamespace
  schema: z<unknown>
  base: unknown
  applies: SettingsApplies
  /** Owner-supplied check for constraints the schema cannot express. */
  validate?: (value: unknown) => void
  validateWrite?: (value: unknown) => void
  redact?: (value: unknown) => RedactedValue
  resolved: unknown
  /**
   * Monotonic counter over this namespace's RAW user section — bumped by any
   * change to what is stored, including one whose resolved value is
   * unchanged (adding an override equal to the composition base). Editors
   * carry it as `expectedRevision` to detect a concurrent write, and the
   * document event carries it so another tab learns a field went from
   * inherited to overridden.
   */
  revision: number
  watchers: Set<SettingsWatcher>
  active: boolean
  settlement: Promise<boolean>
  settlementResolver?: (accepted: boolean) => void
  quiescenceTimedOut: boolean
}

const watcherExecution = new AsyncLocalStorage<{ registration: SettingsRegistration; watcher: SettingsWatcher }>()

function isRegistrationActive(registration: SettingsRegistration): boolean {
  return registration.active
}

async function settlesBefore(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
  const timeout = Promise.withResolvers<boolean>()
  const timer = setTimeout(timeout.resolve, timeoutMs, false)
  timer.unref()
  try {
    return await Promise.race([operation.then(() => true), timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Abstract settings service. Providers implement raw-document storage
 * (`load`/`persist`) and push external changes through {@link Settings.publish};
 * the base class owns namespace registration, resolution, validation, change
 * detection, and the `settings/updated` commit event.
 */
export abstract class SettingsProvider extends TypertRemoteService {
  private readonly registrations = new Map<SettingsNamespace, SettingsRegistration>()
  /** Latest published raw document; empty until the provider's first publish. */
  private document: Record<string, unknown> = {}
  /** Per-namespace write chains; settled tails, so a failure never poisons the queue. */
  private readonly writeQueues = new Map<SettingsNamespace, Promise<unknown>>()
  /** In-flight watcher invocation segments, drained by the dispose teardown. */
  private readonly pendingTails = new Set<Promise<void>>()
  private readonly remoteProtectedNamespaces = new Map<Context['fiber'], Set<SettingsNamespace>>()
  /** Set at service dispose: refuse new writes while queued ones drain. */
  private stopped = false

  /** Deadline for an old namespace owner to release writes and callbacks. */
  protected get registrationQuiescenceTimeoutMs(): number {
    return 5000
  }

  /** Opaque read of {@link stopped}: control flow cannot narrow it across awaits. */
  private isStopped(): boolean {
    return this.stopped
  }

  constructor(ctx: Context) {
    super(ctx, 'settings')
  }

  /**
   * Load the provider's document once and publish it before the service
   * becomes injectable, and register the write-drain teardown. Providers with
   * their own init (watchers, connections) delegate here first via
   * `yield* super[Service.init]()`; their disposers then run before the drain.
   */
  async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    yield async () => {
      // Teardown: refuse new writes and new watcher starts, then wait until
      // every queued write chain and every started watcher invocation settles
      // so disposal completes only once storage and observers are quiescent.
      // Invocations queued but not yet started skip via the stopped check.
      this.stopped = true
      await Promise.allSettled([...this.writeQueues.values(), ...this.pendingTails])
    }
    this.publish(await this.load())
  }

  /** Whether {@link update} may persist through this provider. */
  abstract readonly writable: boolean

  /**
   * Absolute path of the provider's user-editable document, when its storage
   * is one local file. Configuration surfaces use this only as availability
   * metadata; the guarded open operation resolves the path again Host-side.
   * Non-file providers leave it undefined and expose no open-document affordance.
   * @returns the absolute local document path, or undefined for non-file storage.
   */
  get documentPath(): string | undefined {
    return undefined
  }

  /**
   * Prepare the provider's user-editable document for a native editor. File
   * providers may materialize an absent document before returning its path;
   * non-file providers return undefined.
   * @returns the absolute local document path, or undefined for non-file storage.
   */
  prepareDocument(): Promise<string | undefined> {
    return Promise.resolve(this.documentPath)
  }

  /**
   * Read the provider's current raw document (namespace to raw section).
   * @returns the detached raw document.
   */
  protected abstract load(): Promise<Record<string, unknown>>

  /**
   * Durably store one namespace's merged user section.
   * @param ns - the namespace being written.
   * @param section - the complete merged user section to store.
   */
  protected abstract persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void>

  /**
   * Register a namespace schema and receive its owner scope. The registration
   * is an effect on the calling plugin's fiber: disposing that fiber removes
   * the namespace and its observers. An invalid stored section fails the
   * registration itself — the earliest point where the schema can judge it.
   * @param ns - unique namespace; duplicate registration fails loud.
   * @param schema - schemastery schema resolving this namespace's value.
   * @param options - composition `base` layer and effect timing.
   * @returns the owner scope for reads, observation, and updates.
   */
  register<T>(ns: SettingsNamespace, schema: z<T>, options?: SettingsRegisterOptions<T>): SettingsScope<T> {
    if (this.isStopped()) throw new Error(`settings service is disposed: "${ns}" cannot be registered`)
    const existing = this.registrations.get(ns)
    if (existing !== undefined) {
      if (existing.quiescenceTimedOut) {
        throw new SettingsRegistrationQuiescenceError(ns, this.registrationQuiescenceTimeoutMs)
      }
      throw new Error(`settings namespace "${ns}" is already registered`)
    }
    const registration: SettingsRegistration = {
      ns,
      schema: schema as z<unknown>,
      base: options?.base,
      applies: options?.applies ?? 'live',
      ...options?.validate === undefined
        ? {}
        : { validate: options.validate as (value: unknown) => void },
      ...options?.validateWrite === undefined
        ? {}
        : { validateWrite: options.validateWrite as (value: unknown) => void },
      ...options?.redact === undefined ? {} : { redact: options.redact },
      resolved: deepFreeze(this.resolve(schema, options?.base, this.section(ns), options?.validate)),
      revision: 0,
      watchers: new Set(),
      active: true,
      settlement: Promise.resolve(true),
      quiescenceTimedOut: false,
    }
    this.ctx.effect(() => {
      this.registrations.set(ns, registration)
      return async () => {
        registration.active = false
        for (const watcher of registration.watchers) watcher.active = false
        const write = this.writeQueues.get(ns)
        const current = watcherExecution.getStore()
        // A watcher may unload its own plugin; waiting on itself would deadlock.
        const tails = [...registration.watchers]
          .filter(watcher => current?.registration !== registration || current.watcher !== watcher)
          .map(watcher => watcher.tail)
        const quiescence = Promise.allSettled([...write === undefined ? [] : [write], ...tails])
          .then(() => undefined)
        if (!await settlesBefore(quiescence, this.registrationQuiescenceTimeoutMs)) {
          registration.quiescenceTimedOut = true
          void quiescence.then(() => this.registrations.delete(ns))
          throw new SettingsRegistrationQuiescenceError(ns, this.registrationQuiescenceTimeoutMs)
        }
        this.registrations.delete(ns)
      }
    }, `settings.register(${JSON.stringify(String(ns))})`)
    const requireOwner = () => {
      if (!registration.active || this.registrations.get(ns) !== registration || this.isStopped()) {
        throw new Error(`settings namespace "${ns}" registration is disposed`)
      }
    }
    return {
      get: () => registration.resolved as T,
      watch: (callback) => {
        requireOwner()
        const watcher: SettingsWatcher = { callback: callback, tail: Promise.resolve(), active: true }
        registration.watchers.add(watcher)
        return () => {
          watcher.active = false
          // Unsubscription stops new calls, but the namespace still owns a started call.
          void watcher.tail.then(() => registration.watchers.delete(watcher))
        }
      },
      update: async (patch) => { requireOwner(); await this.update(ns, patch) },
      replace: async (section) => { requireOwner(); await this.replace(ns, section) },
    }
  }

  /**
   * Describe every registered namespace for configuration surfaces, including
   * the composition `base` and raw user layers so a form can mark which fields
   * the user overrode (presence in `user`) and what a reset returns to.
   * @param options - redaction switch; wire surfaces must redact.
   * @returns one descriptor per registered namespace, in registration order.
   */
  describe(options?: SettingsDescribeOptions): SettingsDescriptor[] {
    return [...this.registrations.values()].map((registration) => {
      let user: Record<string, unknown> | undefined
      try {
        user = this.section(registration.ns)
      } catch {
        // A malformed stored section already warned at publish and kept the
        // last good resolved value; only that malformed shape can throw here,
        // and describing it as "no user layer" keeps this read total.
        user = undefined
      }
      const base = registration.base === undefined ? undefined : structuredClone(registration.base)
      const detachedUser = user === undefined ? undefined : structuredClone(user)
      const descriptor: SettingsDescriptor = {
        ns: registration.ns,
        schema: registration.schema.toJSON(),
        value: registration.resolved,
        revision: registration.revision,
        ...base === undefined ? {} : { base },
        ...detachedUser === undefined ? {} : { user: detachedUser },
        applies: registration.applies,
      }
      if (options?.redactSecrets !== true) return descriptor
      const schema = registration.schema as z<never>
      const redact = registration.redact ?? ((value: unknown) => redactSecrets(schema, value))
      const redacted = redact(registration.resolved)
      return {
        ...descriptor,
        schema: redactSettingsSchema(schema),
        value: redacted.value,
        ...base === undefined ? {} : { base: redact(base).value },
        ...detachedUser === undefined ? {} : { user: redact(detachedUser).value },
        secrets: redacted.secrets,
      }
    })
  }

  /**
   * Read redacted settings and deployment facts without revealing a local path.
   * @returns every registered namespace in registration order.
   */
  @Remote('describe')
  remoteDescribe(): RemoteSettingsDescription {
    return {
      writable: this.writable,
      hasDocument: this.ownedDocumentPath() !== undefined,
      namespaces: this.describe({ redactSecrets: true }).map(remoteNamespaceView),
    }
  }

  /**
   * Prepare and open only the document owned by this provider.
   * @param signal - transport cancellation, including the native command.
   * @returns confirmation of the editor handoff; cancellation rejects.
   */
  @Remote('openDocument')
  async remoteOpenDocument(signal: AbortSignal): Promise<RemoteSettingsDocumentOpenResult> {
    const checkCancellation = () => {
      if (signal.aborted) throw new TypertLookupFailure({
        code: 'cancelled', message: 'settings document open was aborted', details: {},
      })
    }
    const fail = (message: string) => new TypertLookupFailure({ code: 'internal', message, details: {} })
    checkCancellation()
    const documentPath = this.ownedDocumentPath()
    if (documentPath === undefined) throw fail('settings provider has no local document to open')
    let preparedPath: string | undefined
    try {
      preparedPath = await this.prepareDocument()
    } catch {
      // Storage errors can contain Host paths or document contents; expose neither.
      checkCancellation()
      throw fail('settings document preparation failed')
    }
    checkCancellation()
    if (preparedPath !== documentPath || this.ownedDocumentPath() !== documentPath) {
      throw fail('settings provider did not prepare its owned local document')
    }
    try {
      await this.openDocumentInNativeEditor(documentPath, signal)
    } catch {
      // Native process diagnostics are not safe Remote error payloads.
      checkCancellation()
      throw fail('settings document open failed')
    }
    checkCancellation()
    return { opened: true }
  }

  /**
   * Merge fields without reconstructing a redacted section.
   * @param ns - namespace to update.
   * @param patch - JSON fields to merge.
   * @param expectedRevision - revision read by the caller.
   * @returns the updated redacted namespace.
   */
  @Remote('update')
  remoteUpdate(ns: string, patch: RemoteSettingsJsonObject, expectedRevision?: number): Promise<RemoteSettingsNamespaceView> {
    return this.remoteWrite(ns, namespace => this.update(namespace, patch, expectedRevision))
  }

  /**
   * Replace the whole user layer, removing omitted overrides.
   * @param ns - namespace to replace.
   * @param section - complete new user layer, not a redacted readback.
   * @param expectedRevision - revision read by the caller.
   * @returns the updated redacted namespace.
   */
  @Remote('replace')
  remoteReplace(ns: string, section: RemoteSettingsJsonObject, expectedRevision?: number): Promise<RemoteSettingsNamespaceView> {
    return this.remoteWrite(ns, namespace => this.replace(namespace, section, expectedRevision))
  }

  /**
   * Apply ordered edits while preserving untouched hidden fields.
   * @param ns - namespace to mutate.
   * @param ops - path-addressed JSON edits.
   * @param expectedRevision - revision read by the caller.
   * @returns the updated redacted namespace.
   */
  @Remote('mutate')
  remoteMutate(ns: string, ops: readonly RemoteSettingsPathOp[], expectedRevision?: number): Promise<RemoteSettingsNamespaceView> {
    return this.remoteWrite(ns, namespace => this.mutate(namespace, ops, expectedRevision))
  }

  private async remoteWrite(ns: string, write: (namespace: SettingsNamespace) => Promise<void>): Promise<RemoteSettingsNamespaceView> {
    let namespace: SettingsNamespace
    try {
      namespace = settingsNamespace(ns)
      if ([...this.remoteProtectedNamespaces.values()].some(namespaces => namespaces.has(namespace))) {
        throw new Error('namespace writes belong to its domain transaction')
      }
      await write(namespace)
    } catch (error) {
      if (error instanceof SettingsConflictError) throw new TypertLookupFailure({
        code: 'settings-conflict', message: error.message,
        details: { ns, expected: error.expected, actual: error.actual },
      })
      throw new TypertLookupFailure({
        code: 'settings-rejected', message: `settings write for "${ns}" was rejected`, details: { ns },
      })
    }
    const descriptor = this.describe({ redactSecrets: true }).find(candidate => candidate.ns === namespace)
    if (descriptor === undefined) throw new TypertLookupFailure({
      code: 'internal', message: 'settings write did not complete', details: {},
    })
    return remoteNamespaceView(descriptor)
  }

  private ownedDocumentPath(): string | undefined {
    const path = this.documentPath
    return path !== undefined && isAbsolute(path) ? path : undefined
  }

  /**
   * Hand the provider-owned file to a native text editor, without a shell.
   * @param path - absolute provider document path.
   * @param signal - caller lifetime.
   * @returns completion of the native handoff command.
   */
  protected openDocumentInNativeEditor(path: string, signal: AbortSignal): Promise<void> {
    return openNativeTextFile(path, signal)
  }

  /**
   * Reserve generic Remote writes for namespaces with a domain transaction owner.
   * @param namespaces - this calling fiber's complete protected set; other owners retain their reservations.
   */
  setRemoteProtectedNamespaces(namespaces: readonly SettingsNamespace[]): void {
    const owner = this.ctx.fiber
    if (!this.remoteProtectedNamespaces.has(owner)) {
      this.ctx.effect(() => () => { this.remoteProtectedNamespaces.delete(owner) }, 'settings.remote-domain-protection')
    }
    this.remoteProtectedNamespaces.set(owner, new Set(namespaces))
  }

  /**
   * Wait for the owner's callbacks for an exact persisted revision.
   * @param ns - registered namespace.
   * @param revision - exact revision to observe; superseded revisions reject.
   * @returns whether every owner callback accepted the revision, not merely whether it persisted.
   */
  async settle(ns: SettingsNamespace, revision: number): Promise<boolean> {
    const registration = this.registrations.get(ns)
    if (registration === undefined || !registration.active) throw new Error(`settings namespace "${ns}" is not registered`)
    if (registration.revision !== revision) throw new SettingsConflictError(ns, revision, registration.revision)
    const accepted = await registration.settlement
    if (this.registrations.get(ns) !== registration || !isRegistrationActive(registration)) {
      throw new Error(`settings namespace "${ns}" was disposed while revision ${String(revision)} settled`)
    }
    if (registration.revision !== revision) throw new SettingsConflictError(ns, revision, registration.revision)
    return accepted
  }

  /**
   * Read one registered namespace's resolved value.
   * @param ns - the namespace to read.
   * @returns the resolved value, or `undefined` while unregistered.
   */
  get(ns: SettingsNamespace): unknown {
    return this.registrations.get(ns)?.resolved
  }

  /**
   * Merge a patch into one registered namespace's user layer, validate the
   * resolved candidate, persist through the provider, then commit and emit.
   * A validation failure rejects before anything is persisted. Writes to one
   * namespace are serialized: concurrent updates apply in call order, each
   * merging over the previous write's committed section.
   * @param ns - the registered namespace to update.
   * @param patch - plain-object patch over the user section.
   * @param expectedRevision - the descriptor `revision` the caller read; a
   *   namespace that moved past it rejects with {@link SettingsConflictError}.
   */
  async update(ns: SettingsNamespace, patch: object, expectedRevision?: number): Promise<void> {
    return this.write(ns, patch, 'merge', expectedRevision)
  }

  /**
   * Replace one registered namespace's user section wholesale, validate,
   * persist, then commit and emit. Keys absent from `section` fall back to the
   * composition `base` and schema defaults — this is the removal/reset path a
   * merge-only patch cannot express (`replace({})` re-inherits everything).
   * @param ns - the registered namespace to replace.
   * @param section - the complete next user section.
   * @param expectedRevision - the descriptor `revision` the caller read; a
   *   namespace that moved past it rejects with {@link SettingsConflictError}.
   */
  async replace(ns: SettingsNamespace, section: object, expectedRevision?: number): Promise<void> {
    return this.write(ns, section, 'replace', expectedRevision)
  }

  /**
   * Apply path-addressed edits to one registered namespace's user section,
   * validate, persist, then commit and emit. The ops are applied to the
   * section as it stands when the write reaches the front of the queue, so a
   * caller never has to restate fields it did not touch — and, crucially,
   * cannot delete fields it never saw. This is the write path for any caller
   * holding a redacted view; `replace` remains the wholesale reset.
   * @param ns - the registered namespace to edit.
   * @param ops - ordered path edits; later ops observe earlier ones.
   * @param expectedRevision - the descriptor `revision` the caller read; a
   *   namespace that moved past it rejects with {@link SettingsConflictError}.
   */
  async mutate(ns: SettingsNamespace, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void> {
    return this.write(ns, ops, 'mutate', expectedRevision)
  }

  /**
   * Validate a mutation and locate its secrets before a domain owner journals it.
   * @param ns - registered namespace.
   * @param ops - proposed ordered edits; nothing is persisted.
   * @returns secret positions in the resolved candidate.
   */
  previewMutation(ns: SettingsNamespace, ops: readonly SettingsPathOp[]): { secrets: RedactedSecret[] } {
    const registration = this.registrations.get(ns)
    if (registration === undefined || !registration.active) throw new Error(`settings namespace "${ns}" is not registered`)
    const snapshot = cloneJsonShaped({ ops }, (label, path) =>
      new TypeError(`settings mutate for "${ns}" must contain only JSON-compatible data (found ${label} at ${path})`))
    const edits = snapshot['ops']
    validateSettingsPathOps(ns, edits)
    const section = edits.reduce(applyPathOp, this.section(ns) ?? {})
    const next = this.resolve(registration.schema, registration.base, section, registration.validate)
    registration.validateWrite?.(next)
    const redact = registration.redact ?? ((value: unknown) => redactSecrets(registration.schema as z<never>, value))
    return { secrets: redact(next).secrets }
  }

  /** Validate a write, then queue it on the namespace's serialized write chain. */
  private write(
    ns: SettingsNamespace,
    input: object,
    mode: 'merge' | 'replace' | 'mutate',
    expectedRevision?: number,
  ): Promise<void> {
    const verb = mode === 'merge' ? 'update' : mode === 'replace' ? 'replace' : 'mutate'
    const registration = this.registrations.get(ns)
    if (registration === undefined || !registration.active) {
      throw new Error(`settings namespace "${ns}" is not registered`)
    }
    if (this.isStopped()) {
      throw new Error(`settings service is disposed: "${ns}" cannot be written`)
    }
    if (!this.writable) {
      throw new Error(`settings provider is read-only: "${ns}" cannot be updated in-process`)
    }
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
      throw new TypeError('settings expectedRevision must be a non-negative safe integer')
    }
    // A mutate's ops array is wrapped so one JSON-shape walk covers both
    // shapes; merge/replace carry the section itself.
    let payload: Record<string, unknown>
    if (mode === 'mutate') {
      payload = { ops: input }
    } else {
      if (!isPlainObject(input)) throw new TypeError(`settings ${verb} for "${ns}" must be a plain object`)
      payload = input
    }
    // Snapshot at call time: the queue must never read a caller-owned object
    // the caller may keep mutating while the write waits its turn. The same
    // walk rejects values that JSON cannot preserve (see cloneJsonShaped).
    const snapshot = cloneJsonShaped(payload, (label, path) =>
      new TypeError(`settings ${verb} for "${ns}" must contain only JSON-compatible data (found ${label} at ${path})`))
    let edits: readonly SettingsPathOp[] = []
    if (mode === 'mutate') {
      const ops = snapshot['ops']
      validateSettingsPathOps(ns, ops)
      edits = ops
    }
    const previous = this.writeQueues.get(ns) ?? Promise.resolve()
    // Chain past a failed predecessor: one rejected write must not poison the
    // namespace queue for every later caller.
    const run = previous.catch(() => undefined).then(async () => {
      if (this.isStopped()) {
        throw new Error(`settings service was disposed before the queued "${ns}" ${verb} ran`)
      }
      if (!registration.active || this.registrations.get(ns) !== registration) {
        throw new Error(`settings namespace "${ns}" registration was disposed before the queued ${verb} ran`)
      }
      // Every mode derives from the section as it stands NOW, at the front of
      // the queue — never from whatever the caller last saw.
      const current = this.section(ns) ?? {}
      // The revision check belongs HERE, not at call time: the queue orders
      // writes but cannot tell a fresh writer from one holding a snapshot
      // that a predecessor already superseded.
      if (expectedRevision !== undefined && expectedRevision !== registration.revision) {
        throw new SettingsConflictError(ns, expectedRevision, registration.revision)
      }
      const section = mode === 'merge'
        ? mergeLayers(current, snapshot) as Record<string, unknown>
        : mode === 'replace'
          ? snapshot
          : edits.reduce(applyPathOp, current)
      const next = deepFreeze(this.resolve(registration.schema, registration.base, section, registration.validate))
      registration.validateWrite?.(next)
      if (registration.revision === Number.MAX_SAFE_INTEGER && !deepEqualJson(current, section)) {
        throw new RangeError(`settings namespace "${ns}" revision space is exhausted`)
      }
      await this.persist(ns, section)
      // The write reached storage either way; the cache must say so. Commit
      // only when this registration is still the namespace owner — a fiber
      // disposed (or replaced) mid-persist must not receive the notification.
      this.document[ns] = section
      if (isRegistrationActive(registration) && this.registrations.get(ns) === registration && !this.isStopped()) {
        const documentChanged = this.bumpRevision(registration, current, section)
        this.commit(registration, next, 'update', documentChanged)
      }
    })
    this.writeQueues.set(ns, run)
    return run
  }

  /**
   * Provider hook: commit a complete raw document observed in storage. Each
   * registered namespace re-resolves; an invalid section keeps that
   * namespace's last good value and warns, other namespaces still commit.
   * @param doc - the detached raw document (unregistered sections preserved).
   * @param source - change origin; defaults to `provider`.
   */
  protected publish(doc: Record<string, unknown>, source: SettingsUpdateSource = 'provider'): void {
    // Read every raw section BEFORE swapping the document, so the revision
    // bump below compares what was stored with what now is — an external edit
    // moves the revision exactly like an in-process write.
    const before = new Map<SettingsNamespace, unknown>()
    for (const registration of this.registrations.values()) {
      try {
        before.set(registration.ns, this.section(registration.ns))
      } catch {
        // A malformed stored section is not a readable "before"; treating it
        // as absent still bumps against any well-formed replacement.
        before.set(registration.ns, undefined)
      }
    }
    this.document = doc
    for (const registration of this.registrations.values()) {
      if (!registration.active || this.isStopped()) continue
      let next: unknown
      try {
        next = deepFreeze(this.resolve(registration.schema, registration.base, this.section(registration.ns), registration.validate))
      } catch (error) {
        this.ctx.logger.warn('settings: keeping last good "%s" after invalid stored section', registration.ns)
        this.ctx.logger.warn(error)
        continue
      }
      const documentChanged = this.bumpRevision(registration, before.get(registration.ns), this.section(registration.ns))
      this.commit(registration, next, source, documentChanged)
    }
  }

  /** Read one namespace's raw user section, rejecting non-object sections. */
  private section(ns: SettingsNamespace): Record<string, unknown> | undefined {
    const section = this.document[ns]
    if (section === undefined) return undefined
    if (!isPlainObject(section)) {
      throw new TypeError(`settings section "${ns}" must be an object of keys`)
    }
    return section
  }

  /** Resolve one namespace value: schema defaults, then `base`, then the user layer. */
  private resolve<T>(
    schema: z<T>,
    base: unknown,
    section: Record<string, unknown> | undefined,
    validate?: (value: T) => void,
  ): T {
    // The merged candidate is untyped by construction; the schema call is the
    // runtime validation that admits it into T.
    const value = schema(mergeLayers(base, section) as never)
    // The owner's own check runs on the admitted value, so it sees defaults
    // and the composition base exactly as the owner will.
    validate?.(value)
    return value
  }

  /**
   * Bind settlement before any commit notification can re-enter settle().
   * Raw changes advance the revision even when the resolved value is unchanged.
   */
  private bumpRevision(registration: SettingsRegistration, before: unknown, after: unknown): boolean {
    if (deepEqualJson(before, after)) return false
    if (registration.revision === Number.MAX_SAFE_INTEGER) {
      throw new RangeError(`settings namespace "${registration.ns}" revision space is exhausted`)
    }
    registration.revision += 1
    const settlement = Promise.withResolvers<boolean>()
    registration.settlement = settlement.promise
    registration.settlementResolver = settlement.resolve
    return true
  }

  /** Contained fan-out of `settings/document-updated`, mirroring {@link commit}'s. */
  private emitDocumentUpdated(ns: SettingsNamespace, revision: number): void {
    const registration = this.registrations.get(ns)
    let invariantFailure: unknown
    const args = ['settings/document-updated', ns, revision]
    for (const listener of this.ctx.events.dispatch('emit', args) as Array<(...listenerArgs: unknown[]) => unknown>) {
      if (this.registrations.get(ns) !== registration || registration?.revision !== revision || !registration.active) break
      try {
        const returned = listener(ns, revision)
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(returned as PromiseLike<unknown>).then(undefined, (error: unknown) => {
            this.warnListenerFailure(ns, error)
          })
        }
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'INVARIANT') {
          invariantFailure ??= error
          continue
        }
        this.warnListenerFailure(ns, error)
      }
    }
    if (invariantFailure !== undefined) throw invariantFailure as Error
  }

  /** Commit a resolved value when changed: swap, notify watchers, emit the event. */
  private commit(registration: SettingsRegistration, next: unknown, source: SettingsUpdateSource, documentChanged: boolean): void {
    const revision = registration.revision
    const resolveSettlement = registration.settlementResolver
    delete registration.settlementResolver
    const prev = registration.resolved
    if (deepEqualJson(next, prev)) {
      resolveSettlement?.(true)
      if (documentChanged) this.emitDocumentUpdated(registration.ns, revision)
      return
    }
    registration.resolved = next
    const outcomes: Promise<boolean>[] = []
    for (const watcher of [...registration.watchers]) {
      if (!watcher.active) continue
      // Serialize per watcher: invocations of one callback run one at a time
      // in commit order, so a slow stale invocation can never apply after a
      // newer one. Sync throws and async rejections land in the same handler.
      // The activity check runs when the queued invocation would start, so a
      // disposer (or service stop) that ran while it waited prevents the
      // start entirely; started invocations drain at service dispose.
      const outcome = watcher.tail
        .then(() => {
          if (!watcher.active || !registration.active || this.isStopped()) return
          return watcherExecution.run({ registration, watcher }, () => watcher.callback(next as never, prev as never))
        })
        .then(() => true, (error: unknown) => {
          this.warnWatcherFailure(registration.ns, error)
          return false
        })
      outcomes.push(outcome)
      const segment = outcome.then(() => undefined)
      watcher.tail = segment
      this.pendingTails.add(segment)
      void segment.then(() => this.pendingTails.delete(segment))
    }
    void Promise.all(outcomes).then(results => resolveSettlement?.(results.every(Boolean)))
    if (documentChanged) this.emitDocumentUpdated(registration.ns, revision)
    // Fan the event out one listener at a time (the plain emit stops at the
    // first throwing listener, starving the rest). Invariant violations are
    // harness-fatal by design and rethrow after every listener ran; any other
    // failure is contained so one broken observer cannot wedge the commit
    // path (and, through it, a provider's reload loop).
    let invariantFailure: unknown
    const args = ['settings/updated', registration.ns, next, prev, source]
    for (const listener of this.ctx.events.dispatch('emit', args) as Array<(...listenerArgs: unknown[]) => unknown>) {
      if (this.registrations.get(registration.ns) !== registration || !registration.active
        || registration.resolved !== next || registration.revision !== revision) break
      try {
        const returned = listener(registration.ns, next, prev, source)
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          // An emit listener may still be an async function; its rejection
          // cannot reach the synchronous INVARIANT rethrow below, so it is
          // contained here instead of becoming an unhandled rejection.
          void Promise.resolve(returned as PromiseLike<unknown>).then(undefined, (error: unknown) => {
            this.warnListenerFailure(registration.ns, error)
          })
        }
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'INVARIANT') {
          invariantFailure ??= error
          continue
        }
        this.warnListenerFailure(registration.ns, error)
      }
    }
    if (invariantFailure !== undefined) throw invariantFailure as Error
  }

  /** Contained-watcher diagnostic shared by the sync and async failure paths. */
  private warnWatcherFailure(ns: SettingsNamespace, error: unknown): void {
    this.ctx.logger.warn('settings: watcher for "%s" failed', ns)
    this.ctx.logger.warn(error)
  }

  /** Contained-listener diagnostic shared by the sync and async failure paths. */
  private warnListenerFailure(ns: SettingsNamespace, error: unknown): void {
    this.ctx.logger.warn('settings: a settings/updated listener for "%s" failed', ns)
    this.ctx.logger.warn(error)
  }
}

/**
 * Project an already-redacted descriptor as detached, lossless Remote data.
 * @param descriptor - descriptor obtained with secret redaction enabled.
 * @returns a namespace view that carries no provider-owned object references.
 */
export function remoteNamespaceView(descriptor: SettingsDescriptor): RemoteSettingsNamespaceView {
  return {
    ns: String(descriptor.ns),
    schema: snapshotSettingsJson(descriptor.schema),
    value: snapshotSettingsJson(descriptor.value),
    ...descriptor.base === undefined ? {} : { base: snapshotSettingsJson(descriptor.base) },
    ...descriptor.user === undefined ? {} : { user: snapshotSettingsJson(descriptor.user) },
    applies: descriptor.applies,
    secrets: (descriptor.secrets ?? []).map(secret => ({ path: [...secret.path], set: secret.set })),
    revision: descriptor.revision,
  }
}

/**
 * Detach lossless JSON through the same validator used by settings writes.
 * This does not redact secrets; callers own whether the input may cross a wire or journal.
 * @param value - JSON-compatible input to snapshot before asynchronous work.
 * @returns a detached value; unsupported numbers, sparse arrays and cycles reject.
 */
export function snapshotSettingsJson(value: unknown): RemoteSettingsJsonValue {
  const detached = cloneJsonShaped({ value }, () => new TypeError('settings descriptor contains non-JSON data'))['value']
  if (detached === undefined) throw new TypeError('settings descriptor contains non-JSON data')
  return detached
}

/**
 * Value mirror of the `FiberState` members {@link isUnloading} compares
 * against: a const enum has no runtime object to import, and the value is
 * needed at runtime (same rationale as the CLI boot driver's mirror).
 */
const FIBER_DISPOSED = 4
const FIBER_UNLOADING = 5

/** Whether the consumer's own fiber is tearing down (not just losing the settings service). */
function isUnloading(ctx: Context): boolean {
  const state: number = ctx.fiber.state
  return state === FIBER_UNLOADING || state === FIBER_DISPOSED
}

/** Hooks a consumer hands to {@link installSettingsSection}. */
export interface SettingsSectionHooks<T> {
  /**
   * Receive the active configuration source: the resolved settings scope
   * while one is attached, the composition entry otherwise. Called before
   * the matching `onChange` at attach and at detach.
   * @param current - thunk returning the currently authoritative value.
   */
  setSource(current: () => T): void
  /**
   * Re-judge anything derived from the source — registration-level facts,
   * memoized resolutions — after an attach, a detach, or a committed change.
   */
  onChange(): void
  /**
   * Reject a resolved section this consumer could not act on, for constraints
   * its schema cannot express. See {@link SettingsRegisterOptions.validate}.
   * @param value - the resolved section, schema-valid by construction.
   */
  validate?: (value: T) => void
  /** Reject newly written unsafe values while allowing stored-value migration. */
  validateWrite?: (value: T) => void
  /** Remove owner-specific secrets from each descriptor layer. */
  redact?: (value: unknown) => RedactedValue
}

/**
 * Install the canonical optional-settings consumer wiring: while a settings
 * service exists, register `ns` with the consumer's composition entry as the
 * `base` layer and point the source thunk at the resolved scope; when the
 * service goes away (disposal, provider reload), fall back to the entry so
 * the consumer keeps working exactly as composed. The registration rides the
 * scoped fiber, so no settings service ever mounted means none of this runs.
 * @param ctx - consumer plugin context owning the wiring.
 * @param ns - the consumer-owned settings namespace.
 * @param schema - schema resolving the namespace (typically the plugin Config).
 * @param entry - the consumer's composition entry config, used as `base`.
 * @param hooks - source sink and change notification.
 */
export function installSettingsSection<T>(
  ctx: Context,
  ns: SettingsNamespace,
  schema: z<T>,
  entry: T,
  hooks: SettingsSectionHooks<T>,
): void {
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(ns, schema, {
      base: entry,
      ...hooks.validate === undefined ? {} : { validate: hooks.validate },
      ...hooks.validateWrite === undefined ? {} : { validateWrite: hooks.validateWrite },
      ...hooks.redact === undefined ? {} : { redact: hooks.redact },
    })
    hooks.setSource(() => scope.get())
    sctx.effect(() => () => {
      // This disposer runs for two different reasons. A settings provider
      // detaching leaves the consumer running, so it must fall back to its
      // composition entry and re-judge what it derived. The consumer's own
      // unload runs it too — and there `onChange` would re-register routes
      // and touch resources the teardown is releasing, so the fallback is
      // pointless and the notification actively harmful.
      if (isUnloading(ctx)) return
      hooks.setSource(() => entry)
      hooks.onChange()
    })
    hooks.onChange()
    scope.watch(() => {
      // A stored change landing while the consumer unloads reaches the watcher
      // before the registration is released, and `onChange` is exactly as
      // harmful here as in the disposer above: it re-registers routes against
      // a fiber whose resources are being let go.
      if (isUnloading(ctx)) return
      hooks.onChange()
    })
  })
}

export default SettingsProvider
