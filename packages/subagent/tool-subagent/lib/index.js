import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { assertSubagentMaxDepth, parentAgentOptionsForDelegation, settleRun } from "@deepseek-ai/dsh-subagent";
import { FIRST_PARTY_SECTION_ORDER } from "@deepseek-ai/dsh-system-prompt";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
z.object({
	provider: z.string().min(1).required(),
	model: z.string().min(1).required()
});
/**
* Stable identity for one provider/model pair.
* @param route - The route input.
* @returns The value produced by model route key.
*/
function modelRouteKey(route) {
	return `${route.provider}\0${route.model}`;
}
/**
* Reject malformed or duplicate route policy entries at a boundary.
* @param routes - The routes input.
* @returns The value produced by assert allowed model routes.
*/
function assertAllowedModelRoutes(routes) {
	if (!Array.isArray(routes)) throw new Error("subagent model selection requires an array of routes");
	const seen = /* @__PURE__ */ new Set();
	for (const candidate of routes) {
		if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate) || !("provider" in candidate) || typeof candidate.provider !== "string" || !("model" in candidate) || typeof candidate.model !== "string" || candidate.provider.length === 0 || candidate.model.length === 0) throw new Error("subagent model selection requires non-empty provider and model ids");
		const route = {
			provider: candidate.provider,
			model: candidate.model
		};
		const key = modelRouteKey(route);
		if (seen.has(key)) throw new Error(`subagent model selection repeats route "${route.provider}/${route.model}"`);
		seen.add(key);
	}
}
/**
* Whether a call explicitly selects any child LLM value.
* @param request - The request input.
* @returns The value produced by has delegation model request.
*/
function hasDelegationModelRequest(request) {
	return request.provider !== void 0 || request.model !== void 0 || request.reasoning_effort !== void 0 || request.max_tokens !== void 0;
}
function assertNonEmpty(value, field) {
	if (value !== void 0 && value.length === 0) throw new Error(`child LLM \`${field}\` must be non-empty`);
}
/**
* Merge model-supplied route fields over configured child defaults.
* @param parentOptions - The parent options input.
* @param configured - The configured input.
* @param request - The request input.
* @param enabled - The enabled input.
* @returns The value produced by requested agent options.
*/
function requestedAgentOptions(parentOptions, configured, request, enabled) {
	if (!hasDelegationModelRequest(request)) return configured;
	if (!enabled) throw new Error("child model selection is disabled for this tool instance");
	assertNonEmpty(request.provider, "provider");
	assertNonEmpty(request.model, "model");
	assertNonEmpty(request.reasoning_effort, "reasoning_effort");
	if (request.max_tokens !== void 0 && (!Number.isSafeInteger(request.max_tokens) || request.max_tokens <= 0)) throw new Error("child LLM `max_tokens` must be a positive safe integer");
	if (request.provider === void 0 !== (request.model === void 0)) throw new Error("child LLM `provider` and `model` must be supplied together");
	const baselineProvider = configured?.provider ?? parentOptions.provider;
	const baselineModel = configured?.model ?? parentOptions.model;
	const routeChanged = request.provider !== void 0 && (request.provider !== baselineProvider || request.model !== baselineModel);
	const { reasoningEffort: _configuredReasoningEffort, ...configuredWithoutReasoning } = configured ?? {};
	return {
		...routeChanged && request.reasoning_effort === void 0 ? configuredWithoutReasoning : configured,
		...request.provider === void 0 ? {} : {
			provider: request.provider,
			model: request.model
		},
		...request.reasoning_effort === void 0 ? {} : { reasoningEffort: ReasoningEffortId(request.reasoning_effort) },
		...request.max_tokens === void 0 ? {} : { maxTokens: request.max_tokens }
	};
}
/**
* Enforce the session-captured route allowlist for explicit choices.
* @param policy - The policy input.
* @param parentOptions - The parent options input.
* @param requested - The requested input.
* @param request - The request input.
*/
function assertAllowedModelSelection(policy, parentOptions, requested, request) {
	if (policy === void 0 || !hasDelegationModelRequest(request)) return;
	const provider = requested?.provider ?? parentOptions.provider;
	const model = requested?.model ?? parentOptions.model;
	if (provider === void 0 || model === void 0) throw new Error("cannot select child LLM values without an effective provider and model");
	if (policy.routes.some((route) => route.provider === provider && route.model === model)) return;
	throw new Error(`child LLM route "${provider}/${model}" is not allowed for this Session`);
}
/**
* Resolve and validate one exact child route through the live LLM adapter.
* @param llm - The llm input.
* @param parentOptions - The parent options input.
* @param requested - The requested input.
* @param signal - The signal input.
* @param inheritParentReasoningEffort - The inherit parent reasoning effort input.
*/
async function preflightChildLlmRoute(llm, parentOptions, requested, signal, inheritParentReasoningEffort = true) {
	const provider = requested?.provider ?? parentOptions.provider;
	const model = requested?.model ?? parentOptions.model;
	if (provider === void 0 || model === void 0) throw new Error("cannot select child LLM values without an effective provider and model");
	const routeChanged = provider !== parentOptions.provider || model !== parentOptions.model;
	const reasoningEffort = requested?.reasoningEffort ?? (inheritParentReasoningEffort && !routeChanged ? parentOptions.reasoningEffort : void 0);
	await llm.resolveCallConfig({
		provider,
		model,
		...reasoningEffort === void 0 ? {} : { reasoningEffort },
		...requested?.maxTokens === void 0 ? {} : { maxTokens: requested.maxTokens }
	}, signal);
}
//#endregion
//#region lib/types/list-models.js
/** Model-facing discovery of LLM routes available to child Agents. */
function registeredProvider(llm, policy, providerID) {
	const provider = llm.listProviders().find((candidate) => candidate.id === providerID);
	if (provider !== void 0) return provider;
	const available = llm.listProviders().filter((candidate) => policy.routes.some((route) => route.provider === candidate.id)).map((candidate) => candidate.id).join(", ") || "(none)";
	throw new Error(`LLM provider "${providerID}" is not registered; available providers: ${available}`);
}
function modelLine(provider, model) {
	return `${provider}/${model.id} — ${model.name}${model.description === void 0 ? "" : `: ${model.description}`}`;
}
async function listSubagentModels(ctx, policy, request, signal) {
	const llm = ctx.get("llm");
	if (llm === void 0) throw new Error("cannot discover child LLM routes because the `llm` service is unavailable");
	if (request.model !== void 0 && request.provider === void 0) throw new Error("`model` requires `provider`");
	if (request.provider === void 0) {
		const providers = llm.listProviders().filter((provider) => policy.routes.some((route) => route.provider === provider.id));
		return providers.length === 0 ? "(no LLM providers)" : providers.map((provider) => `${provider.id} — ${provider.name}`).join("\n");
	}
	if (request.provider.length === 0) throw new Error("`provider` must be non-empty");
	const allowedRoutes = policy.routes.filter((route) => route.provider === request.provider);
	if (allowedRoutes.length === 0) throw new Error(`LLM provider "${request.provider}" is not allowed for this Session`);
	const provider = registeredProvider(llm, policy, request.provider);
	if (request.model === void 0) {
		const models = (await llm.listModels(provider.id)).filter((model) => allowedRoutes.some((route) => route.model === model.id));
		return models.length === 0 ? `(no advertised models for ${provider.id})` : models.map((model) => modelLine(provider.id, model)).join("\n");
	}
	if (request.model.length === 0) throw new Error("`model` must be non-empty");
	if (!allowedRoutes.some((route) => route.model === request.model)) throw new Error(`child LLM route "${provider.id}/${request.model}" is not allowed for this Session`);
	const model = await llm.resolveModelInfo(provider.id, request.model, signal);
	const efforts = model.reasoning?.efforts.map((effort) => `${effort.id}${model.reasoning?.defaultEffort === effort.id ? " (default)" : ""} — ${effort.name}` + (effort.description === void 0 ? "" : `: ${effort.description}`)).join("\n") || "(no advertised reasoning efforts)";
	return `${modelLine(provider.id, model)}\nReasoning efforts:\n${efforts}`;
}
/**
* Register discovery for one session-captured route policy.
* @param ctx - The ctx input.
* @param policy - The policy input.
*/
function registerListSubagentModels(ctx, policy) {
	ctx.tools.register(defineTool({
		name: "list_subagent_models",
		description: "Discover LLM routes for subagents without changing the current Agent. Call with no arguments to list registered providers, with `provider` to list its advertised models, or with `provider` and `model` to inspect that exact model and its reasoning efforts. Use the returned ids with a delegation tool.",
		parameters: {
			provider: {
				type: "string",
				description: "Registered LLM provider id. Omit to list providers."
			},
			model: {
				type: "string",
				description: "Exact model id to inspect. Requires provider; omit to list that provider's models."
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, result) => [{
				type: "text",
				text: result
			}]
		},
		execute(args, exec) {
			return listSubagentModels(ctx, policy, args, exec.signal);
		}
	}));
}
//#endregion
//#region lib/types/model-selection-state.js
/** Durable per-session state for the user-controlled model-selection opt-in. */
/**
* Read the session-captured route list, or undefined for fixed-route sessions.
* @param session - The session input.
* @returns The value produced by subagent model selection policy.
*/
function subagentModelSelectionPolicy(session) {
	const event = session.events.find((candidate) => candidate.type === "subagent/model-selection-policy");
	if (event?.type !== "subagent/model-selection-policy") return void 0;
	const { allowedModels } = event.data;
	assertAllowedModelRoutes(allowedModels);
	if (allowedModels.length === 0) throw new Error("subagent/model-selection-policy requires at least one route");
	return allowedModels.map((route) => ({ ...route }));
}
/**
* Append the allowlist once, before the session can make a model-facing choice.
* @param session - The session input.
* @param allowedModels - The allowed models input.
*/
function recordSubagentModelSelection(session, allowedModels) {
	if (subagentModelSelectionPolicy(session) !== void 0) return;
	assertAllowedModelRoutes(allowedModels);
	if (allowedModels.length === 0) throw new Error("subagent model selection requires at least one allowed model");
	session.append("subagent/model-selection-policy", { allowedModels: allowedModels.map((route) => ({ ...route })) });
}
//#endregion
//#region lib/types/index.js
/**
* Model-facing delegation through one configured `ctx.subagents` provider.
* Provider lifecycle controls tool registration and context-sensitive schema
* wording. Foreground calls always dispose the run after collection.
* Background policy is selected by this plugin's configuration: one-shot
* calls own a plain Task, while continuable calls use
* `ctx.subagents.startContinuable()`.
* @module @deepseek-ai/dsh-tool-subagent
*/
const name = "tool-subagent";
const inject = [
	"tools",
	"subagents",
	"systemPrompt"
];
/** Prompt order after bounded delegation policy and before child reporting. */
const SUBAGENT_SECTION_ORDER = FIRST_PARTY_SECTION_ORDER.TOOL_SUBAGENT;
const Config = z.object({
	provider: z.string().required(),
	toolName: z.string().default("subagent"),
	modelSelectionSettings: z.boolean().default(false),
	enableRunInBackground: z.boolean().default(true),
	backgroundMode: z.union(["one-shot", "continuable"]).default("one-shot"),
	agentOptions: z.object({
		provider: z.string(),
		model: z.string(),
		reasoningEffort: z.string().min(1),
		maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
	}).default(void 0),
	persona: z.string(),
	toolFilter: z.object({
		allow: z.array(z.string()).default(void 0),
		deny: z.array(z.string()).default(void 0)
	}).default(void 0),
	maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const("provider-managed")]).default(3)
});
/** Render text blocks from the canonical JSON block array without trusting arbitrary values. */
function outputValueText(values) {
	return values.filter((value) => typeof value === "object" && value !== null && !Array.isArray(value) && value.type === "text" && typeof value.text === "string").map((value) => value.text).join("");
}
/** Settle pending startup without rejecting the task producer contract. */
async function settleStart(start, signal) {
	try {
		return await settleRun(await start);
	} catch (error) {
		return signal.aborted && !(error instanceof AggregateError) ? { status: "killed" } : {
			status: "failed",
			detail: String(error)
		};
	}
}
/** A non-`completed` stop reason means the child did not finish cleanly. */
function stopReasonError(result) {
	switch (result.stopReason) {
		case "completed": return;
		case "aborted": return "subagent run was cancelled";
		case "error": return "subagent run failed";
		case "max-tokens": return "subagent run hit its token limit before finishing";
		case "refusal": return "subagent declined the task";
		default: return `subagent run ended abnormally (${String(result.stopReason)})`;
	}
}
/**
* Append provider-authored failure detail and the child's preserved partial
* answer to a stop-reason error, keeping diagnostic text separate from the
* child's assistant output.
* @param error - the stop-reason headline.
* @param result - the child's terminal result.
* @returns the headline, diagnostic, and partial text that are present.
*/
function withDiagnosticAndPartialText(error, result) {
	const diagnostic = result.diagnostic === void 0 ? "" : `\nDiagnostic: ${result.diagnostic}`;
	const text = result.output.filter((block) => block.type === "text").map((block) => block.text).join("");
	return `${error}${diagnostic}${text.length === 0 ? "" : `\nPartial output before the run ended:\n${text}`}`;
}
/**
* Collect and release one foreground run without letting disposal replace an
* independent result failure.
*/
async function settleForegroundRun(run) {
	const [execution] = await Promise.allSettled([run.result.then((result) => {
		const error = stopReasonError(result);
		if (error !== void 0) throw new Error(withDiagnosticAndPartialText(error, result));
		return {
			kind: "foreground",
			runId: run.id,
			output: result.output
		};
	})]);
	const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())]);
	if (execution.status === "rejected") {
		if (disposal.status === "rejected") throw new AggregateError([execution.reason, disposal.reason], `subagent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`);
		throw execution.reason;
	}
	if (disposal.status === "rejected") throw disposal.reason;
	return execution.value;
}
/**
* Model-facing wording from the provider's conversation-history descriptor
* ({@link SubagentProvider.inheritsParentContext}).
* A fresh child needs a standalone prompt; a forked child already sees the
* conversation's completed turns — telling the model to restate everything
* (or, worse, that the child "does not see this conversation") would be false
* for a fork.
* @param inheritsConversation - whether the child's conversation is seeded
*   with the parent's completed turns; this says nothing about tool, service,
*   scope, or authority inheritance.
* @returns the tool `description` and the `prompt` parameter description.
*/
function providerWording(inheritsConversation) {
	if (inheritsConversation) return {
		description: "Delegate a task to a subagent that inherits this conversation: a child agent seeded with all completed turns so far (it does not see the current in-flight turn). Use this when the subtask builds on this conversation's context — a follow-up analysis, a review, a continuation — without consuming this conversation's context for the work itself. You receive its result, not its intermediate steps.",
		promptDescription: "The task for the subagent. It already sees this conversation's completed turns, so build on them freely and state only what is new."
	};
	return {
		description: "Delegate a self-contained task to a subagent (a separate agent that works in its own context) to offload focused, independent work — research, a scoped implementation, an analysis — so it does not consume this conversation's context. The subagent returns its result, not its intermediate steps. Give it a complete, standalone prompt: it does not see this conversation.",
		promptDescription: "The complete, self-contained task for the subagent. It does not share this conversation's context, so include everything it needs."
	};
}
/** Resolve the model's optional scheduling request into one execution route. */
function resolveDelegationRun(request, options) {
	if (!options.backgroundEnabled) {
		if (request.run_in_background === true) throw new Error("run_in_background is disabled for this tool instance (enableRunInBackground: false)");
		return { runInBackground: false };
	}
	return { runInBackground: request.run_in_background ?? options.continuable };
}
function apply(ctx, config) {
	if (config.maxDepth !== "provider-managed") assertSubagentMaxDepth(config.maxDepth);
	if (config.toolFilter !== void 0 && config.toolFilter.allow === void 0 && config.toolFilter.deny === void 0) throw new Error("tool-subagent: `toolFilter` is configured but names neither `allow` nor `deny` — remove the key or fill the filter");
	const backgroundEnabled = config.enableRunInBackground !== false;
	const continuable = (config.backgroundMode ?? "one-shot") === "continuable";
	const toolName = config.toolName ?? "subagent";
	const modelSelectionCapable = config.modelSelectionSettings === true;
	const modelSelectionSettings = modelSelectionCapable ? ctx.get("subagentModelSelection") : void 0;
	if (modelSelectionCapable && modelSelectionSettings === void 0) throw new Error("tool-subagent: `modelSelectionSettings` requires @deepseek-ai/dsh-tool-subagent/model-selection-settings in the Host scope");
	const selectionForParent = (parent) => {
		if (!modelSelectionCapable) return {
			policy: void 0,
			enabled: false
		};
		const existing = subagentModelSelectionPolicy(parent.session);
		if (existing !== void 0) return {
			policy: { routes: existing },
			enabled: true
		};
		const current = modelSelectionSettings?.current();
		if (current?.enabled !== true) return {
			policy: void 0,
			enabled: false
		};
		recordSubagentModelSelection(parent.session, current.allowedModels);
		return {
			policy: { routes: current.allowedModels },
			enabled: true
		};
	};
	if (modelSelectionCapable) {
		const current = modelSelectionSettings?.current();
		if (current?.enabled === true) registerListSubagentModels(ctx, { routes: current.allowedModels });
	}
	let disposeTool;
	const mount = (provider) => {
		if (typeof config.maxDepth === "number" && !provider.capabilities.depthLimit) throw new Error(`tool-subagent: provider "${provider.name}" cannot enforce maxDepth (no depthLimit capability) — set maxDepth: 'provider-managed' to leave the recursion budget to the provider`);
		if (modelSelectionCapable && provider.capabilities.agentOptions === false) throw new Error(`tool-subagent: provider "${provider.name}" does not support child model selection`);
		const wording = providerWording(provider.inheritsParentContext);
		if (continuable && provider.prepareContinuable === void 0) throw new Error(`tool-subagent: provider "${provider.name}" does not support \`backgroundMode: continuable\``);
		disposeTool = ctx.tools.register(defineTool({
			name: toolName,
			description: wording.description + (backgroundEnabled ? continuable ? " This tool runs in the background by default, returns a durable subagent id after its initial inbox receipt is flushed, and keeps the child conversation available for later turns. When that run settles, the runtime sends the parent a durable outcome notice and avoids repeating a byte-identical explicit report; `send_message` starts a later turn in the same child conversation. Set `run_in_background: false` only when your next action depends on receiving the result." : " This call waits for the result by default. Set `run_in_background: true` to return a job id; collect with `job_output` and stop with `job_kill`." : " This call waits for the subagent and returns its result.") + (modelSelectionCapable ? " When enabled for this session, use `provider`, `model`, `reasoning_effort`, and `max_tokens` to choose an authorized child route and output budget; use `list_subagent_models` before selecting a route. Omit them to inherit the configured values." : ""),
			parameters: {
				description: {
					type: "string",
					required: true,
					description: "A short (3-5 word) description of the delegated task, for display."
				},
				prompt: {
					type: "string",
					required: true,
					description: wording.promptDescription
				},
				...modelSelectionCapable ? {
					provider: {
						type: "string",
						description: "Authorized child LLM provider. Supply together with model; omit both to inherit the configured route."
					},
					model: {
						type: "string",
						description: "Exact child model id. Supply together with provider; omit both to inherit the configured route."
					},
					reasoning_effort: {
						type: "string",
						description: "Provider-owned reasoning effort for the selected child route."
					},
					max_tokens: {
						type: "integer",
						description: "Positive safe-integer maximum output tokens for each child model request."
					}
				} : {},
				...backgroundEnabled ? { run_in_background: {
					type: "boolean",
					description: continuable ? "Whether to run in the background and return a durable subagent id immediately. Defaults to true. Set false to wait for the result when your next action depends on it." : "Whether to run as a background job and return its id. Defaults to false; collect with job_output or stop with job_kill."
				} } : {}
			},
			output: {
				schema: { oneOf: [
					{
						type: "object",
						additionalProperties: false,
						properties: {
							kind: {
								type: "string",
								required: true,
								const: "background"
							},
							jobId: {
								type: "string",
								required: true
							}
						}
					},
					{
						type: "object",
						additionalProperties: false,
						properties: {
							kind: {
								type: "string",
								required: true,
								const: "continuable"
							},
							subagentId: {
								type: "string",
								required: true
							}
						}
					},
					{
						type: "object",
						additionalProperties: false,
						properties: {
							kind: {
								type: "string",
								required: true,
								const: "foreground"
							},
							runId: {
								type: "string",
								required: true
							},
							output: {
								type: "array",
								required: true,
								items: { type: "json" }
							}
						}
					}
				] },
				render: (_args, value) => [{
					type: "text",
					text: value.kind === "background" ? `started background subagent job ${value.jobId}` : value.kind === "continuable" ? `started subagent ${value.subagentId}` : outputValueText(value.output)
				}]
			},
			presentCall: (args) => ({
				card: "generic",
				title: `Delegate: ${args.description}`,
				kind: "other",
				rawInput: {
					semanticKind: "subagent",
					description: args.description
				}
			}),
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				const parent = exec.agent;
				if (!parent) throw new Error("subagent tool requires a calling agent (exec.agent was undefined)");
				const modelRequest = args;
				const parentOptions = parentAgentOptionsForDelegation(parent);
				const selection = selectionForParent(parent);
				const requestedOptions = requestedAgentOptions(parentOptions, config.agentOptions, modelRequest, selection.enabled);
				assertAllowedModelSelection(selection.policy, parentOptions, requestedOptions, modelRequest);
				const hasEffectiveRoute = requestedOptions?.provider !== void 0 && requestedOptions.model !== void 0;
				if (hasDelegationModelRequest(modelRequest) || hasEffectiveRoute) {
					const llm = ctx.get("llm");
					if (llm === void 0) throw new Error("cannot resolve the selected child LLM route because the `llm` service is unavailable");
					await preflightChildLlmRoute(llm, parentOptions, requestedOptions, exec.signal);
				}
				const maxDepth = typeof config.maxDepth === "number" ? config.maxDepth : void 0;
				const request = {
					label: args.description,
					prompt: [{
						type: "text",
						text: args.prompt
					}],
					parent,
					...requestedOptions !== void 0 ? { agentOptions: requestedOptions } : {},
					...config.persona !== void 0 ? { persona: config.persona } : {},
					...config.toolFilter !== void 0 ? { toolFilter: config.toolFilter } : {},
					...maxDepth !== void 0 ? { maxDepth } : {}
				};
				if (resolveDelegationRun(args, {
					backgroundEnabled,
					continuable
				}).runInBackground) {
					if (continuable) return {
						kind: "continuable",
						subagentId: (await ctx.subagents.startContinuable({
							provider: config.provider,
							label: args.description,
							request,
							signal: exec.signal
						})).childId
					};
					const jobs = ctx.get("jobs");
					if (jobs === void 0) throw new Error("background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs");
					return {
						kind: "background",
						jobId: jobs.start({
							kind: "subagent",
							label: args.description,
							owner: parent,
							run: () => {
								const controller = new AbortController();
								return {
									cancel: (reason) => {
										controller.abort(reason ?? "background subagent task killed");
									},
									done: settleStart(ctx.subagents.start(config.provider, {
										...request,
										signal: controller.signal
									}), controller.signal)
								};
							}
						})
					};
				}
				return settleForegroundRun(await ctx.subagents.start(config.provider, {
					...request,
					signal: exec.signal
				}));
			}
		}));
	};
	ctx.on("subagent/provider-added", (provider) => {
		if (provider.name === config.provider && disposeTool === void 0) mount(provider);
	});
	ctx.on("subagent/provider-removed", (name) => {
		if (name !== config.provider || disposeTool === void 0) return;
		disposeTool();
		disposeTool = void 0;
	});
	const present = ctx.subagents.getProvider(config.provider);
	if (present !== void 0) mount(present);
	else ctx.logger.info(`subagent provider "${config.provider}" not registered yet; the "${config.toolName ?? "subagent"}" tool will register when it appears`);
	if (backgroundEnabled && continuable) ctx.systemPrompt.section({
		name: `tool:${toolName}`,
		order: SUBAGENT_SECTION_ORDER,
		text: (context) => disposeTool === void 0 || ctx.tools.get(toolName, context.scope) === void 0 ? "" : `Use ${toolName} in the background by default. Start independent delegations together in one assistant message and continue useful work while they run. Set \`run_in_background: false\` only when your next action depends on that subagent's result. When a background run settles, the runtime sends you a durable outcome notice and does not repeat a byte-identical explicit report.`
	});
}
//#endregion
export { Config, apply, inject, name };
