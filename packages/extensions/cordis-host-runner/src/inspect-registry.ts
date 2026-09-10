/** Host registry for model-visible, read-only Cordis capability queries. */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type {
  CordisInspectMethodManifest,
  CordisInspectPlatform,
  CordisInspectProviderManifest,
  CordisInspectProviderView,
} from './types.ts'

/** Context supplied to one Host inspect query. */
export interface HostCordisInspectQueryContext {
  signal: AbortSignal
  agent: Agent
}

/** Local registration paired with its serializable manifest. */
export interface HostCordisInspectProviderRegistration {
  manifest: CordisInspectProviderManifest
  query(method: string, input: JsonValue | undefined, context: HostCordisInspectQueryContext): Promise<JsonValue>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host registry for Cordis inspect providers. */
    cordisInspect: CordisInspectRegistryService
  }
}

/** Registry behind the model-facing inspect tools. */
export class CordisInspectRegistryService extends Service {
  private readonly providers = new Map<string, HostCordisInspectProviderRegistration>()

  /** Register the process-global Host registry. */
  constructor(ctx: Context) {
    super(ctx, 'cordisInspect')
  }

  /**
   * Register one Host provider.
   * @param registration - Provider manifest and query implementation.
   * @returns A disposer that removes the provider when it is no longer owned.
   */
  register(registration: HostCordisInspectProviderRegistration): () => void {
    const manifest = validateManifest(registration.manifest)
    if (this.providers.has(manifest.id)) throw new Error(`Host Cordis inspect provider "${manifest.id}" is already registered`)
    const stored = { ...registration, manifest }
    this.providers.set(manifest.id, stored)
    return () => {
      if (this.providers.get(manifest.id) === stored) this.providers.delete(manifest.id)
    }
  }

  /**
   * Return the complete Host provider directory.
   * @returns Serializable provider views in registration order.
   */
  list(): CordisInspectProviderView[] {
    return [...this.providers.values()].map(provider => ({
      platform: 'host',
      ...provider.manifest,
      methods: [...provider.manifest.methods],
    }))
  }

  /**
   * Execute one Host provider query.
   * @param platform - Requested inspect platform; only `host` is supported.
   * @param providerId - Registered provider identity.
   * @param methodName - Provider method to invoke.
   * @param input - JSON input validated against the method schema.
   * @param agent - Session agent making the query.
   * @param signal - Cancellation signal for the query lifecycle.
   * @returns Schema-validated JSON provider output.
   */
  async query(
    platform: CordisInspectPlatform,
    providerId: string,
    methodName: string,
    input: JsonValue | undefined,
    agent: Agent,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    assertHostPlatform(platform)
    const registration = this.providers.get(providerId)
    if (registration === undefined) throw new Error(`Host Cordis inspect provider "${providerId}" is not registered`)
    const method = findMethod(registration.manifest, methodName)
    validateInput(providerId, method, input)
    signal.throwIfAborted()
    const data = await registration.query(methodName, input, { agent, signal })
    signal.throwIfAborted()
    return validateOutput(providerId, method, data)
  }
}

/** Retain a runtime boundary guard even though the current typed surface exposes only Host. */
function assertHostPlatform(platform: string): asserts platform is CordisInspectPlatform {
  if (platform !== 'host') throw new Error(`Cordis inspect platform ${JSON.stringify(platform)} is not available`)
}

function validateManifest(manifest: CordisInspectProviderManifest): CordisInspectProviderManifest {
  if (manifest.id.trim() === '') throw new Error('Cordis inspect provider id must not be empty')
  if (manifest.description.trim() === '') throw new Error(`Cordis inspect provider "${manifest.id}" needs a description`)
  const names = new Set<string>()
  const methods = manifest.methods.map((method) => {
    if (method.name.trim() === '') throw new Error(`Cordis inspect provider "${manifest.id}" has an empty method name`)
    if (names.has(method.name)) throw new Error(`Cordis inspect provider "${manifest.id}" repeats method "${method.name}"`)
    if (method.description.trim() === '') throw new Error(`Cordis inspect method ${manifest.id}.${method.name} needs a description`)
    assertSupportedJsonSchema(method.inputSchema)
    assertSupportedJsonSchema(method.outputSchema)
    names.add(method.name)
    return Object.freeze({ ...method })
  })
  return Object.freeze({ ...manifest, methods: Object.freeze(methods) })
}

function findMethod(manifest: CordisInspectProviderManifest, name: string): CordisInspectMethodManifest {
  const method = manifest.methods.find(candidate => candidate.name === name)
  if (method === undefined) throw new Error(`Cordis inspect provider "${manifest.id}" has no method "${name}"`)
  return method
}

function validateInput(provider: string, method: CordisInspectMethodManifest, input: JsonValue | undefined): void {
  const violations = validateJsonSchemaValue(method.inputSchema as JsonSchemaNode, input ?? {}, 'input')
  if (violations.length > 0) throw new Error(`Host Cordis inspect ${provider}.${method.name} rejected input: ${violations.join('; ')}`)
}

function validateOutput(provider: string, method: CordisInspectMethodManifest, data: JsonValue): JsonValue {
  const snapshot = snapshotJsonValue(data)
  if (snapshot === undefined) throw new Error(`Host Cordis inspect ${provider}.${method.name} returned a non-JSON value`)
  const violations = validateJsonSchemaValue(method.outputSchema as JsonSchemaNode, snapshot, 'output')
  if (violations.length > 0) throw new Error(`Host Cordis inspect ${provider}.${method.name} returned invalid output: ${violations.join('; ')}`)
  return snapshot
}
