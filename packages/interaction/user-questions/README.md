---
description: "Question and answer service for tools, scoped answerers, and a native Host UI provider."
kind: "package-reference"
---

# @deepseek-ai/dsh-user-questions

English | [中文](README.zh.md)

## Summary

User-interaction Service Definition. It owns `ctx.userQuestions`, the service a model-facing tool or permission plugin uses when it needs to pause work and ask the human for a decision. Use it when a consumer must suspend an operation until the user answers.

## Table of Contents

- [Service: `UserQuestionService` (ctx key: `userQuestions`)](#service-userquestionservice-ctx-key-userquestions)
- [Role](#role)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="service-userquestionservice-ctx-key-userquestions"></a>
## Service: `UserQuestionService` (ctx key: `userQuestions`)

### Public API

- `ctx.userQuestions.ask(request): Promise<AskUserQuestionAnswer>` Dispatch the answerer waterfall and wait for the first accepted answer.
- `ctx.userQuestions.registerProvider(provider): () => void` Register the single Host UI fallback used when listeners delegate. Duplicate registration rejects with `DUPLICATE_PROVIDER`; disposing the calling fiber or returned disposer withdraws the provider. Ark's native event service owns its pending requests and their cancellation.

### Key Types

- `AskUserQuestionRequest` — `{ questions: [{ id, question, detail?, header?, options?, multiSelect?, intent? }], agent?, signal? }`; `detail` supplies supporting text that providers render with the question without turning it into an option label. When present, `agent` must be the registry's exact live runtime root.
- `AskUserQuestionOption` — `{ label, description? }`.
- `AskUserQuestionIntent` — `{ kind: 'plan-review', approve }`; the tagged presentation intent below.
- `AskUserQuestionAnswer` — `{ answers: [{ id, selected, custom? }] }`.
- `UserQuestionError` — `HarnessError` subclass with codes such as `EMPTY_QUESTIONS`, `BAD_INTENT`, `NO_PROVIDER`, `ASK_ABORTED`, `CALLER_NOT_LIVE`, and `DELEGATED_CALLER`.

For a single-select question, `custom` overrides the selected choice and `selected` is empty. For a multi-select question, `custom` may supplement the labels in `selected`. A UI may preserve a skipped item as `{ id, selected: [] }`, keeping the existing answer shape while retaining other answers in the batch.

When a request carries an agent, `ask()` authenticates its exact identity through the live `AgentRegistry` and admits only a runtime root. Durable lineage is not authority: a session with historical delegation depth may ask after it is resumed as a new runtime root, while a live child owned by another agent is rejected even if its durable depth is zero. Scoped answerers receive only matching requests. An agentless request reaches unscoped listeners and the Host fallback; `NO_PROVIDER` means neither accepted it.

### Presentation intent

`intent` declares that a question IS a known kind of decision, so a UI that recognises the tag may present it as such — `plan-review` says `detail` is a plan under review, and `dsh-plan-mode` sets it on the `exit_plan_mode` question. An intent changes presentation only: a UI honouring it answers with the same option labels a generic UI would send, and a UI that does not know the tag renders the generic option list, so callers read the same answer fields either way. `approve` names the label that approves rather than relying on option order. `ask()` rejects with `BAD_INTENT` the two assertions no type can carry: an `approve` naming none of that question's own options, and an intent on a question with no `detail` — the thing it declares itself a review of.

<a id="role"></a>
## Role

This is the Service Definition package. Consumers such as `@deepseek-ai/dsh-tool-ask-user` depend on this service; Ark's native event service registers the Host UI fallback. Local plugins may compose scoped answerers before that fallback. A tool call awaits the answer and then resumes the normal agent loop.

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-ask-user`, which retains a successful answer as compact JSON or one of these failures: `Error: ask_user_question was aborted before the user answered`, `Error: ask_user_question requires at least one question`, `Error: human interaction requires the exact live calling agent when an agent is supplied`, `Error: human interaction is unavailable while the calling agent is owned by another live agent; include the unresolved question or decision in the child agent's final result`, `Error: no user-questions answerer accepted the request`, or `Error: <message>`. Waiting for the human adds no tokens.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Provider-owned request lifetime** — the UI provider must withdraw cancelled requests and settle pending answers when it unloads; unregistering only prevents new requests from reaching it.
- **The vocabulary is the question-form shape only** — selectable options plus optional custom text; richer interaction shapes (file pickers, diff-preview confirmations) have no seam vocabulary yet.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
