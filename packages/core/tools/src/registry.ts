/**
 * Tool registry surface: scoped registration, restrictions, guards, and model
 * presentation modes (native/code/both) including the generated Code Mode SDK
 * prompt. ToolRuntime owns this registry and keeps the public register/
 * restrict/guard/presentAs/schemas/get/executionMode surface; the execution
 * pipeline lives in {@link ToolExecutor} and receives the registry lookups it
 * needs through this class.
 * @module @deepseek-ai/dsh-tools/src/registry
 */

import { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { CodeRuntime } from '@deepseek-ai/dsh-code-runtime'
import { AnonymousEntries, NamedEntries, ScopedLayers, scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import type { ScopeKey, ScopeLayer } from '@deepseek-ai/dsh-scope'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { ToolProviderResult } from '@deepseek-ai/dsh-system-prompt'
import { createRunCodeTool, RUN_CODE_NAME, SDK_SECTION_ORDER } from './code-mode.ts'
import type { CodeSdkLanguage } from './code-mode.ts'
import { errorMessage } from './executor.ts'
import { assertSupportedJsonSchema } from './json-schema.ts'
import type {
  CodeDispatchLog,
  Config,
  ToolDefinition,
  ToolExecution,
  ToolExecutionInput,
  ToolExecutionMode,
  ToolGuard,
  ToolPresentationMode,
  ToolRestriction,
  ToolRuntime,
} from './index.ts'
import { renderToolsSdk } from './ts-types.ts'
import type { ToolSdkSchema } from './ts-types.ts'
import { renderToolsSdkPy } from './py-types.ts'

/** Keep registry internals independent from the barrel to avoid a runtime cycle. */
function isPtcPresentationMode(mode: ToolPresentationMode): boolean {
  return mode === 'ptc' || mode === 'code'
}

/**
 * Language → SDK-section renderer. The registry looks up the loaded
 * `ctx.codeRuntime.language` in this table when assembling the `tools:sdk`
 * section under a non-native mode; a runtime whose language is not a key
 * fails the assembly loudly (same idiom as `toolOrder` violations). Adding a
 * new backend language is three parallel edits — a {@link CodeSdkLanguage}
 * member, an entry here, and a `RUN_CODE_FLAVORS` entry in `code-mode.ts` for
 * its `run_code` schema strings — plus the renderer function this table points
 * at. The `satisfies` clause pins this table's key set to that union, which
 * the flavor table is checked against too, so any of the three left out is a
 * typecheck failure. What no check reaches is the prose that names the values
 * instead of deriving them: the seam's `dsh-code-runtime` README pair, its
 * `CodeRuntime.language` JSDoc, and `docs/subsystems/code-runtime.md`
 * with its zh pair, plus this package's own README pair and the
 * {@link Config.mode} JSDoc.
 */
/**
 * Prompt order of the `code` collapse statement: after the persona and before
 * the 100-199 per-tool guidance band, so the model reads which tools it may
 * call before it reads what each one is for.
 */
const COLLAPSE_SECTION_ORDER = 99

/**
 * The model-facing statement of the `code` collapse. Names the consequence
 * (the call fails) and the route (inside the program), because a rule the
 * model can only discover by being denied is one it corrects too late.
 */
const CODE_ONLY_INSTRUCTION = `\`${RUN_CODE_NAME}\` is the only tool you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program.`

const SDK_RENDERERS: Record<string, (schemas: ToolSdkSchema[]) => string> = {
  typescript: renderToolsSdk,
  python: renderToolsSdkPy,
} satisfies Record<CodeSdkLanguage, (schemas: ToolSdkSchema[]) => string>

/** One restriction compiled at registration for repeated live-global lookup. */
interface CompiledToolRestriction {
  readonly allow?: ReadonlySet<string>
  readonly deny?: ReadonlySet<string>
}

/** One scope's complete registry view, derived in a single layer traversal. */
interface ToolView {
  /** Visible definitions after restrictions, scoped shadowing, and transport insertion. */
  readonly visible: ReadonlyMap<string, ToolDefinition>
  /** Pre-restriction capability names used by prompt-order validation. */
  readonly knownNames: ReadonlySet<string>
  /** Current global names that a scoped restriction may name. */
  readonly restrictableNames: ReadonlySet<string>
}

/** One scope's complete tool-registry contribution. */
class ToolLayer implements ScopeLayer {
  readonly tools: NamedEntries<ToolDefinition>
  readonly restrictions = new AnonymousEntries<CompiledToolRestriction>()
  readonly guards = new AnonymousEntries<ToolGuard>()
  /**
   * Presentation this scope's agent declared for itself, shadowing the
   * deployment default. One cell rather than an entry table: two answers to
   * "which form does the model see" is a contradiction, not a merge.
   */
  mode: ToolPresentationMode | undefined

  constructor(scope: ScopeKey | undefined) {
    this.tools = new NamedEntries(name => new Error(scope === undefined
      ? `tool "${name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`
      : `tool "${name}" is already registered in this scope`))
  }

  /** Whether every contribution table in this aggregate layer is empty. */
  isEmpty(): boolean {
    return this.tools.isEmpty() && this.restrictions.isEmpty() && this.guards.isEmpty()
      && this.mode === undefined
  }

  /** Whether every compiled restriction in this layer admits a global tool name. */
  admits(name: string): boolean {
    for (const filter of this.restrictions.values()) {
      if ((filter.allow !== undefined && !filter.allow.has(name))
        || (filter.deny !== undefined && filter.deny.has(name))) return false
    }
    return true
  }

  /** First monotonic denial from this layer's live guard registrations. */
  guardReason(exec: ToolExecution): string | undefined {
    for (const guard of this.guards.values()) {
      const reason = guard(exec)
      if (reason !== undefined) return reason
    }
    return undefined
  }
}

/** Resolve the run_code overlap cap at the owning config boundary (direct construction bypasses the Loader schema). */
function resolveMaxParallelSubCalls(value: number | undefined): number {
  const maxParallelSubCalls = value ?? 10
  if (!Number.isInteger(maxParallelSubCalls) || maxParallelSubCalls < 1) {
    throw new Error('maxParallelSubCalls must be a positive integer')
  }
  return maxParallelSubCalls
}

/**
 * Tool registration, restriction, and presentation. Scoped registrations
 * shadow globals; one visibility resolver feeds presentation, lookup, and the
 * execution pipeline's dispatch resolution. The owning {@link ToolRuntime}
 * service is the scoped subject for the `tools/code-dispatch-log` waterfall
 * and the receiver handed to the reserved `run_code` transport.
 *
 * Caller context is never captured: registration methods take the caller's
 * {@link ToolRuntime} and its CALLING context, so a scoped registration's
 * effect attaches to the caller's fiber to unwind with it, exactly as the
 * original `this.ctx` reads did. The constructed `runtime` and its root
 * context serve the internal assembly and `run_code` bridge paths, matching
 * the pre-split instance.
 */
export class ToolRegistry {
  /** The owning service instance, handed to the reserved `run_code` transport. */
  private readonly runtime: ToolRuntime
  /** The construction (root) context: internal assembly and bridge reads. */
  private readonly ctx: Context
  private readonly layers = new ScopedLayers(
    scope => new ToolLayer(scope),
    () => { this.ctx.emit('tools/change') },
  )
  /** Presentation for scopes that declare none; {@link presentAs} shadows it per scope. */
  private readonly defaultMode: ToolPresentationMode
  private readonly maxParallelSubCalls: number
  /**
   * Reserved presentation transport, kept outside the filterable registration
   * layers. Built on first need rather than at construction: which agents run
   * a code mode is no longer known when the service is constructed, and the
   * transport is stateless beyond its closures over the owning runtime.
   */
  private codeTransport: ToolDefinition | undefined

  constructor(runtime: ToolRuntime, ctx: Context, config: Config = {}) {
    this.runtime = runtime
    this.ctx = ctx
    // The schema already defaulted an omitted mode; the ?? narrows the
    // optional-input type for direct (non-Loader) construction in tests.
    this.defaultMode = config.mode ?? 'native'
    this.maxParallelSubCalls = resolveMaxParallelSubCalls(config.maxParallelSubCalls)
    ctx.systemPrompt.tools(context => this.wireSchemas(context.scope))
    if (this.defaultMode !== 'native') {
      ctx.systemPrompt.section(this.collapseSection())
      ctx.systemPrompt.section(this.sdkSection())
    }
  }

  /**
   * The prompt statement of the `code` executor collapse, registered wherever
   * {@link sdkSection} is and rendering empty outside an effective `code`.
   *
   * Every tool contributes its own guidance section naming its tool, none of
   * them qualify how that tool is reached, and they all render before the SDK
   * (orders 100-199 against {@link SDK_SECTION_ORDER}). Without this the model
   * reads a catalog of tools it is told to use and no statement that only
   * `run_code` may be called, so it emits a native call, receives
   * `UNKNOWN_TOOL` for a tool the prompt just declared, and concludes the
   * deployment is inconsistent. {@link COLLAPSE_SECTION_ORDER} places the rule
   * before that guidance rather than after it.
   *
   * `both` renders empty: native calls do execute there, so the rule is false.
   * @returns the section registration.
   */
  private collapseSection(
    mode: ToolPresentationMode = this.defaultMode,
  ): { name: string; order: number; text: (context: { scope?: ScopeKey }) => string } {
    return {
      name: mode === 'ptc' ? 'tools:ptc-only' : 'tools:code-only',
      order: COLLAPSE_SECTION_ORDER,
      // The SAME predicate the executor denies by, so the prompt cannot state
      // a rule the registry does not enforce (see `collapses`).
      text: context => isPtcPresentationMode(this.modeFor(context.scope)) ? CODE_ONLY_INSTRUCTION : '',
    }
  }

  /**
   * The generated-SDK prompt section, registered globally by a code-mode
   * deployment and per scope by {@link presentAs}.
   *
   * The body regenerates from the CALLING scope, and renders empty for an
   * agent presenting natively — an agent that opted out under a code-mode
   * deployment still sees the global registration, and an empty section is
   * dropped from the rendered prompt.
   * @returns the section registration.
   */
  private sdkSection(): { name: string; order: number; text: (context: { scope?: ScopeKey }) => string } {
    return {
      name: 'tools:sdk',
      order: SDK_SECTION_ORDER,
      // Regenerate from the calling scope's visible tools in stable order.
      text: (context) => {
        const mode = this.modeFor(context.scope)
        if (mode === 'native') return ''
        const runtime = this.requireCodeRuntime(mode)
        // Own-property read: a language like `toString`/`constructor` would
        // otherwise resolve an inherited Object.prototype member as a renderer.
        const render = SDK_RENDERERS[runtime.language]
        /* v8 ignore next -- requireCodeRuntime rejects an unknown language before this runs. */
        if (render === undefined) throw new Error(`dsh-tools: no SDK renderer for ${runtime.language}`)
        return render(this.sdkSchemas(context.scope))
      },
    }
  }

  /**
   * The presentation one scope's agent sees: its own declaration, else the
   * deployment default.
   * @param scope - the calling agent, or undefined for the global view.
   * @returns the resolved presentation mode.
   */
  private modeFor(scope?: ScopeKey): ToolPresentationMode {
    // Nearest scope wins along the chain: a preset's standing declaration
    // covers every agent parented under it, and an agent's own (were one ever
    // declared) would override its preset's. The mode decides what the model
    // SEES, which is exactly the class of fact the chain inherits.
    const layers = this.layers.chainLayers(scope)
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      const mode = layers[index]?.mode
      if (mode !== undefined) return mode
    }
    return this.defaultMode
  }

  /**
   * The reserved `run_code` transport, built on first need.
   *
   * It never enters the global layer: per-agent restrictions must not remove
   * it, and a scoped registration must not shadow it. The visibility resolver
   * appends it after resolving the filterable global/scoped capability layers,
   * and only for scopes whose mode actually presents it.
   * @returns the shared transport definition.
   */
  private requireCodeTransport(): ToolDefinition {
    this.codeTransport ??= createRunCodeTool(this.runtime, {
      requireRuntime: () => this.requireCodeRuntime(this.defaultMode),
      // The language-aware description/parameters getters read the runtime
      // without demanding one, so a native-default process can still project
      // the transport for an agent that chose code.
      peekRuntime: () => this.ctx.get('codeRuntime'),
      maxParallel: this.maxParallelSubCalls,
      shapeDispatchLog: dispatch => this.shapeDispatchLog(dispatch),
    })
    return this.codeTransport
  }

  /**
   * Present the calling scope's tools in `mode` instead of the deployment
   * default. Nearest scope on the chain wins, so a preset's standing
   * declaration covers every agent joined under it.
   *
   * Scoped only, and one declaration per scope: this is how an agent preset
   * composes Code Mode agents beside native ones in the same process, and a
   * process-global override would be the `mode` config field instead.
   * @param ctx - the caller-visible context.
   * @param mode - the presentation the covered agents' models see.
   * @returns the exact disposer that restores the deployment default.
   */
  presentAs(ctx: Context, mode: ToolPresentationMode): () => void {
    if (scopeOf(ctx) === undefined) {
      throw new Error('tools.presentAs() requires a scoped context (agent.ctx): a context-global presentation is the `mode` config field on the tools row')
    }
    const dispose = ctx.effect(function* (this: ToolRegistry) {
      yield this.layers.effect(
        ctx,
        (layer) => {
          if (layer.mode !== undefined) {
            throw new Error(`tools.presentAs("${mode}") conflicts with "${layer.mode}" already declared for this scope; one composition selects one presentation`)
          }
          layer.mode = mode
          return () => { layer.mode = undefined }
        },
        { label: 'tools.presentAs()' },
      )
      // The SDK and collapse sections are per scope for the same reason the
      // mode is. Under a deployment that already defaults to a code mode this
      // shadows the global registration with an identical body, which costs
      // nothing and keeps one rule instead of a case analysis.
      if (mode !== 'native') {
        yield ctx.systemPrompt.section(this.collapseSection(mode))
        yield ctx.systemPrompt.section(this.sdkSection())
      }
    }.bind(this), 'tools.presentAs()')
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous composite teardown; direct return preserves disposer identity
    return dispose
  }

  /**
   * Build one scope's wire schemas and names for prompt-order validation.
   * Restrictions do not make known tools invalid, but a mode collapse does.
   */
  private wireSchemas(scope?: ScopeKey): ToolProviderResult {
    const view = this.view(scope)
    const mode = this.modeFor(scope)
    if (mode === 'native') {
      const schemas = [...view.visible.values()].map(definition => this.schemaOf(definition, false))
      return { schemas, knownNames: [...view.knownNames] }
    }
    // Validate the runtime language BEFORE projecting schemas: schemaOf reads
    // run_code's language-aware description/parameters getters, whose own
    // flavor-table guard would otherwise surface first. This keeps the
    // renderer-table rejection the canonical assembly-time error for a
    // language with no SDK renderer.
    this.requireCodeRuntime(mode)
    const schemas = [...view.visible.values()].map(definition => this.schemaOf(definition, false))
    if (isPtcPresentationMode(mode) && mode !== 'both') {
      return {
        schemas: schemas.filter(schema => schema.name === RUN_CODE_NAME),
        knownNames: [RUN_CODE_NAME],
      }
    }
    return { schemas, knownNames: [...view.knownNames, RUN_CODE_NAME] }
  }

  /**
   * Resolve the code runtime or throw the actionable misconfiguration error.
   * Read at use time (assembly / run_code execution), NOT via static
   * `inject`: an inject entry would hold `ctx.tools` — and every tool plugin
   * behind it — hostage to a code runtime existing even under `mode:
   * 'native'` (the loop's optional-backend idiom, same as
   * `sessionPersistence`).
   *
   * Assembly and `run_code` execution read separately, so the language is not
   * bound to a request. Harmless while one published backend exists — both
   * reads return the same flavor — but a reload that swapped in a second
   * language between them would hand a program written against one SDK to the
   * other. Binding it is deferred until a second backend ships (the first
   * point it is testable); rationale in the
   * [language-dispatch note](../../../../.agents/notes/implemented/feature/2026-07-31-code-mode-language-dispatch.md).
   */
  private requireCodeRuntime(mode: ToolPresentationMode): CodeRuntime {
    const runtime = this.ctx.get('codeRuntime')
    if (!runtime) {
      throw new Error(`dsh-tools: mode "${mode}" requires a code runtime — load a ctx.codeRuntime implementation (e.g. @deepseek-ai/dsh-code-runtime-worker-thread) or set tools mode to "native"`)
    }
    if (!Object.hasOwn(SDK_RENDERERS, runtime.language)) {
      const known = Object.keys(SDK_RENDERERS).map(name => JSON.stringify(name)).join(', ')
      throw new Error(`dsh-tools: no SDK renderer registered for runtime language ${JSON.stringify(runtime.language)} (known: ${known})`)
    }
    return runtime
  }

  /**
   * Register globally or in the calling agent scope. Scoped tools shadow
   * globals; duplicates within one layer and the reserved `run_code` name fail.
   * @param ctx - the caller-visible context.
   * @param definition - tool schema, execution, and optional finalization/presentation callbacks.
   * @returns the exact disposer that unregisters the tool.
   */
  register(ctx: Context, definition: ToolDefinition): () => void {
    const name = definition.name
    const output = (definition as Partial<ToolDefinition>).output
    if (output === undefined || typeof output !== 'object'
      || typeof output.render !== 'function'
      || (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function')) {
      throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`)
    }
    assertSupportedJsonSchema(output.schema)
    const timeoutMs = definition.timeoutMs
    if (timeoutMs !== undefined
      && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`)
    }
    // Reserved unconditionally: any agent may select a code mode for itself,
    // so a name free to take under the deployment default would become a
    // collision the moment a preset mounted.
    if (name === RUN_CODE_NAME) {
      throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the Code Mode presentation transport and cannot be registered or shadowed`)
    }
    return this.layers.effect(
      ctx,
      layer => layer.tools.insert(name, definition),
      { label: 'tools.register()' },
    )
  }

  /**
   * Restrict global tools for the calling agent scope. Empty filters, unknown
   * names, scope-local names, and reserved transport names fail. Restrictions
   * intersect; scoped registrations remain visible.
   * @param ctx - the caller-visible context.
   * @param filter - global-tool mask: `allow` (keep only) and/or `deny` (remove).
   * @returns the exact disposer that lifts this restriction.
   */
  restrict(ctx: Context, filter: ToolRestriction): () => void {
    const scope = scopeOf(ctx)
    if (scope === undefined) {
      throw new Error('tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead')
    }
    const allow = filter.allow
    const deny = filter.deny
    if (allow === undefined && deny === undefined) {
      throw new Error('tools.restrict({}) is a no-op: pass `allow` and/or `deny` (an empty filter is almost always a materialized-empty-config bug)')
    }
    const compiled: CompiledToolRestriction = {
      ...allow !== undefined ? { allow: new Set(allow) } : {},
      ...deny !== undefined ? { deny: new Set(deny) } : {},
    }
    if ([...allow ?? [], ...deny ?? []].includes(RUN_CODE_NAME)) {
      throw new Error(`tools.restrict() cannot name reserved Code Mode presentation transport "${RUN_CODE_NAME}"; restrict end-capability tools instead`)
    }
    const known = this.view(scope).restrictableNames
    const unknown = [...allow ?? [], ...deny ?? []].filter(name => !known.has(name))
    if (unknown.length > 0) {
      throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} ${unknown.map(n => `"${n}"`).join(', ')}; known global tools: ${[...known].sort().join(', ') || '(none)'}`)
    }
    return this.layers.effect(
      ctx,
      layer => layer.restrictions.append(compiled),
      { label: 'tools.restrict()' },
    )
  }

  /**
   * Register a monotonic guard after the extensible `tools/pre-execute`
   * waterfall. A plain-context guard applies globally; one registered through
   * `agent.ctx` applies only to that agent. Any matching guard may deny by
   * returning a reason, while no guard can force-allow a call another guard
   * denied. The exact effect disposer is returned for ordered ownership and
   * HMR cleanup.
   * @param ctx - the caller-visible context.
   * @param guard - synchronous check; a returned string denies the execution.
   * @returns the exact disposer that unregisters the guard.
   */
  guard(ctx: Context, guard: ToolGuard): () => void {
    return this.layers.effect(
      ctx,
      layer => layer.guards.append(guard),
      { label: 'tools.guard()', notify: false },
    )
  }

  /**
   * First monotonic denial from the global then the scope chain's guard layers, farthest first.
   * @param exec - the execution the guards inspect.
   * @returns the first denial reason, or undefined when no guard denies the call.
   */
  guardReason(exec: ToolExecution): string | undefined {
    const globalReason = this.layers.global.guardReason(exec)
    if (globalReason !== undefined) return globalReason
    if (exec.agent === undefined) return undefined
    for (const layer of this.layers.chainLayers(exec.agent)) {
      const reason = layer.guardReason(exec)
      if (reason !== undefined) return reason
    }
    return undefined
  }

  /**
   * Resolve every registry fact one scope needs in one layer traversal. The
   * visible map applies restrictions to the INHERITED surface, then the
   * scope's own registrations and the reserved presentation transport; the
   * other sets retain the pre-restriction facts needed by restriction and
   * prompt-order validation.
   *
   * A restriction filters what a scope inherits — the global layer and every
   * ancestor layer on its chain — and never what its OWN layer registers.
   * That exemption is what a per-child capability filter has to keep intact:
   * the delegation runtime registers a child's reporting and structured-output
   * tools into the child's own layer, and a filter naming the capabilities the
   * child may use must not strip the machinery it answers through.
   *
   * Reading the exempt set as "the global layer" instead of "not mine" held
   * only while every model-facing tool sat in the host composition. Once
   * presets moved them onto the agent plane they became an ANCESTOR
   * contribution, so a child's filter silently stopped constraining anything
   * it was given.
   * @param scope - the viewing scope (the agent), or undefined for the global view.
   * @returns the complete derived view for that scope.
   */
  private view(scope?: ScopeKey): ToolView {
    // Scope-chain layers, farthest ancestor first, the exact scope last.
    const layers = this.layers.chainLayers(scope)
    // Chain-blind on purpose: this is the ONE layer whose registrations the
    // scope owns rather than inherits, and it is absent until the scope
    // contributes something.
    const own = this.layers.peek(scope)
    // Inherited surface, nearest ancestor last: a nearer scope's same-name
    // entry shadows a farther one, and the global layer is the farthest.
    const inherited = new Map<string, ToolDefinition>(this.layers.global.tools.entries())
    for (const layer of layers) {
      if (layer === own) continue
      for (const [name, definition] of layer.tools.entries()) inherited.set(name, definition)
    }
    const visible = new Map<string, ToolDefinition>()
    const knownNames = new Set<string>()
    const restrictableNames = new Set<string>()
    for (const [name, definition] of inherited) {
      knownNames.add(name)
      restrictableNames.add(name)
      // Restrictions intersect across the whole chain: any scope on it may
      // mask an inherited name for everything nested inside it.
      if (layers.every(layer => layer.admits(name))) visible.set(name, definition)
    }
    // The scope's own registrations last, shadowing an inherited name and
    // outside the filter above.
    if (own !== undefined) {
      for (const [name, definition] of own.tools.entries()) {
        knownNames.add(name)
        visible.set(name, definition)
      }
    }
    // Presentation infrastructure is resolved last and outside capability
    // filtering. Registration rejects this reserved name, so the insertion is
    // an invariant assertion as well as protection against future layer
    // changes. Per scope: a native agent must not find `run_code` in its
    // dispatch table because some other agent in the process presents it.
    if (this.modeFor(scope) !== 'native') {
      visible.set(RUN_CODE_NAME, this.requireCodeTransport())
    }
    return { visible, knownNames, restrictableNames }
  }

  /**
   * Look up a tool as one scope sees it (scoped
   * shadows global; a restricted-away global reads as absent). Presenters pass
   * the calling agent so the rendered card matches the definition that
   * actually executed.
   * @param name - the tool name as registered.
   * @param scope - the viewing scope (the agent); omitted = the global view.
   * @returns the definition the scope resolves, or undefined when none is visible.
   */
  get(name: string, scope?: ScopeKey): ToolDefinition | undefined {
    return this.view(scope).visible.get(name)
  }

  /**
   * Resolve the definition that MAY EXECUTE for a call, applying the mode
   * collapse at the operation boundary that owns it. The registry view
   * (`get`) is presentation-agnostic; here a MODEL-DIRECT call under `code`
   * may only name the reserved `run_code` transport, while a nested
   * sub-dispatch (a `parent` token set — the `run_code` SDK calling a tool
   * it bound) may call any visible tool. Denial surfaces as `UNKNOWN_TOOL`
   * through the executor, matching an absent definition.
   * @param name - the tool name as registered.
   * @param scope - the viewing scope (the agent); omitted = the global view.
   * @param nested - whether the call is a transport sub-dispatch, not a model-direct call.
   * @returns the definition that may run, or undefined when the call must be rejected.
   */
  resolveExecution(name: string, scope: ScopeKey | undefined, nested: boolean): ToolDefinition | undefined {
    const tool = this.get(name, scope)
    if (tool === undefined) return undefined
    if (this.collapses(name, scope, nested)) return undefined
    return tool
  }

  /**
   * Project visible definitions onto the allowlisted model-facing schema fields,
   * excluding execution and presentation callbacks.
   * @param scope - the viewing scope (the agent); omitted = the global view.
   * @returns one deep-cloned schema per visible tool.
   */
  schemas(scope?: ScopeKey): ToolSchema[] {
    return [...this.view(scope).visible.values()].map(definition => this.schemaOf(definition, true))
  }

  /** Project visible callable tools onto the generated Code Mode SDK contract. */
  private sdkSchemas(scope?: ScopeKey): ToolSdkSchema[] {
    return [...this.view(scope).visible.values()]
      .filter(definition => definition.name !== RUN_CODE_NAME)
      .map((definition): ToolSdkSchema => {
        const output = snapshotJsonValue(definition.output.schema)
        /* v8 ignore next -- registration already validated and retained this schema as lossless JSON. */
        if (output === undefined) {
          throw new Error(`tool "${definition.name}" output schema must be lossless JSON before SDK projection`)
        }
        return {
          ...this.schemaOf(definition, true),
          output,
        }
      })
  }

  /** Project one definition onto the model-facing schema fields. */
  private schemaOf(definition: ToolDefinition, detachParameters: boolean): ToolSchema {
    const { name, description, parameters } = definition
    const detached = detachParameters ? snapshotJsonValue(parameters) : parameters
    if (detached === undefined) {
      throw new Error(`tool "${name}" parameters must be lossless JSON before schema projection`)
    }
    return {
      name,
      description,
      parameters: detached,
    }
  }

  /**
   * Classify a pending call through the caller's visible tool definition. Only
   * an exact `true` is parallel; unknown, hidden, undeclared, invalid, or
   * throwing classifiers are exclusive.
   * @param exec - call name, parsed arguments, and optional agent scope.
   * @returns the fail-closed scheduling mode.
   */
  executionMode(exec: ToolExecutionInput): ToolExecutionMode {
    const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== undefined)
    if (!tool?.isConcurrencySafe) return { kind: 'exclusive' }
    try {
      const concurrencySafe: unknown = tool.isConcurrencySafe(exec.arguments)
      return concurrencySafe === true ? { kind: 'parallel' } : { kind: 'exclusive' }
    } catch {
      return { kind: 'exclusive' }
    }
  }

  /**
   * Run the `tools/code-dispatch-log` waterfall over one settled sub-dispatch
   * and return the content the bridge should log on `tool/code-dispatch`.
   * Contained: when a listener throws, the method logs the original settled
   * content; that failure must not fail the dispatch or omit the settle event. Private:
   * the ONE consumer is the `run_code` bridge this registry constructs, which
   * receives it as a capability parameter (the `requireRuntime` idiom) — the
   * waterfall, not this invoker, is the public extension point.
   */
  private async shapeDispatchLog(dispatch: CodeDispatchLog): Promise<ContentBlock[]> {
    try {
      const legacy = (): Promise<ContentBlock[]> => this.ctx.waterfall(
        scopeTarget(this.runtime, dispatch.agent), 'tools/code-dispatch-log', dispatch,
        () => Promise.resolve(dispatch.content),
      )
      // The alpha spelling is layered over the old hook so existing spill and
      // presentation plugins keep working while new PTC plugins get the
      // canonical name. The legacy hook remains the final continuation.
      return this.modeFor(dispatch.agent) === 'ptc'
        ? await this.ctx.waterfall(
          scopeTarget(this.runtime, dispatch.agent), 'tools/ptc-dispatch-log', dispatch, legacy,
        )
        : await legacy()
    } catch (error: unknown) {
      this.ctx.logger.warn(`tools: code-dispatch-log listener failed for ${dispatch.name}: ${errorMessage(error)}; logging the original settled content`)
      return dispatch.content
    }
  }

  /**
   * Whether the `code` mode collapse denies a model-direct call: only the
   * reserved `run_code` transport may be named. Nested sub-dispatches (a
   * `parent` token set) bypass the collapse. One home for the
   * security-relevant predicate, shared by {@link resolveExecution} and the
   * executor's `createExecution` so the two can never drift apart.
   *
   * Resolved through {@link modeFor}, NOT `defaultMode`: an agent given `code`
   * by an agent preset under a native deployment is the composition
   * `dsh-agent-tool-presentation` exists for, and reading the deployment default would
   * leave exactly that agent uncollapsed — announcing one surface while
   * executing another, which is the bypass this collapse closes.
   * @param name - the tool name as registered.
   * @param scope - the viewing scope whose effective presentation mode applies.
   * @param nested - whether the call is a transport sub-dispatch, not a model-direct call.
   * @returns true when the call collapses to the reserved code-dispatch transport.
   */
  collapses(name: string, scope: ScopeKey | undefined, nested: boolean): boolean {
    return !nested && isPtcPresentationMode(this.modeFor(scope)) && name !== RUN_CODE_NAME
  }
}
