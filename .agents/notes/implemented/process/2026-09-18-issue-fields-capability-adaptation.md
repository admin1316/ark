# Agent Note: Issue Fields capability adaptation in the Issue policy

Status: implemented

English | [中文](2026-09-18-issue-fields-capability-adaptation.zh.md)

## Problem

The Issue policy read Issue Field values for every referenced Issue through `GET /repos/{owner}/{repo}/issues/{number}/issue-field-values`. Issue Fields are organization-scoped metadata. The [issue fields changelog](https://github.blog/changelog/2026-07-02-issue-fields-are-now-generally-available/) makes them generally available "for all GitHub organizations" (public preview since May); the [organization guide](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/managing-issue-fields-in-your-organization) states that fields "are defined at the organization level and apply across all repositories in your organization"; and the [REST write endpoints](https://docs.github.com/en/rest/issues/issue-field-values) scope values to "organization-level issue fields that have been defined for the repository's organization". A repository owned by a User has no organization to define them, so the endpoint answers `404` — observed for `admin1316/ark` on issues `#28` and `#34`.

That response carried `X-Accepted-Oauth-Scopes: repo`. The header states which OAuth scopes the endpoint accepts; it does not by itself prove that the presented token is authorized or that the resource is reachable, and the credential families carry authority differently — OAuth tokens by scope, fine-grained tokens by repository permission, GitHub App installation tokens by app permission. Authorization for this call is therefore recorded as NOT_VERIFIED rather than ruled out. No token value, scope, or permission was read, printed, or expanded, and the capability conclusion rests on the documented organization scoping plus `owner.type = User` from repository metadata.

The policy treated the `404` as fatal. Every pull request that referenced an Issue failed the required check while taking the snapshot, before any policy rule was evaluated, however valid its references and labels were. Reading the same `404` as success would instead erase real Priority checks. Neither reaction answers the question the policy actually asks: whether this repository can carry Issue Fields at all.

## Decision

Repository metadata decides the capability, and the field endpoint is consulted only where the documented contract applies. `issueFieldCapability(ownerType)` maps `owner.type` from `GET /repos/{owner}/{repo}` to one of four states, and `issueFieldValues` completes them per Issue.

- `SUPPORTED` — an Organization-owned repository whose `GET .../issue-field-values` returned at least one value.
- `EMPTY` — an Organization-owned repository whose endpoint returned an empty list. Priority is `null`, but the field is enforceable, so the existing Priority rules still run.
- `UNSUPPORTED` — a User-owned repository. The endpoint is never called, Priority stays unreadable, and every other policy check continues to run.
- `UNKNOWN_OR_ERROR` — any other `owner.type`, an Organization-owned `404`, a non-array payload, or any `401`, `403`, `410`, `429`, `5xx`, timeout, or transport failure. These reject and fail the run.

An unreadable value never creates a Priority obligation and never discharges one. The obligation exists when the pull request declares a `p0`–`p3`, when a resolving Issue carries a readable Priority, or when the trusted rules otherwise require consistency. When such an obligation is pending and any required value is unreadable, `validatePullRequest` returns a `BLOCKED_UNVERIFIED` error, the CLI exits non-zero, and no success line is printed; a notice cannot substitute for that failure.

| Situation (resolving references) | Priority obligation | Outcome |
|---|---|---|
| None — informational `Related to` references only | none | other checks run; Priority is NOT_APPLICABLE |
| Out of scope — Draft, Bot/App author, or no review request and no review | none | policy not enforced |
| All values readable; no declared Priority and no readable Issue Priority | none | PASS under the existing rules |
| All values readable; a readable Issue Priority and no declared Priority | yes | FAIL `PR Priority 应为 <highest>` |
| All values readable; declared Priority and an Issue without one | yes | FAIL `有 Priority 的解决型 PR 要求每个被解决 Issue 都设置 Priority` |
| All values readable; declared and Issue Priorities disagree | yes | FAIL `PR Priority 应为 <highest>` |
| Any value unreadable; no declared Priority and no readable Issue Priority | none | NOT_APPLICABLE notice, exit 0 |
| Any value unreadable; the pull request declares a Priority | yes | BLOCKED_UNVERIFIED error, non-zero exit |
| Any value unreadable; another resolving Issue Priority is readable | yes | BLOCKED_UNVERIFIED error, non-zero exit |
| Authentication, permission, rate-limit, server, network, timeout, malformed-payload, missing-metadata, or Organization-owned unknown `404` | n/a | run fails closed before validation |

Readable and unreadable values are never mixed into a partial comparison: one unreadable required value blocks the whole consistency verdict instead of dropping it. `EMPTY` stays distinct from `UNSUPPORTED`, `UNKNOWN_OR_ERROR` never degrades into `UNSUPPORTED`, and no Priority is ever invented or copied from the pull-request label.

Every request carries a bounded timeout (`DSH_ISSUE_POLICY_TIMEOUT_MS`, default 30 seconds), so a stalled endpoint rejects instead of hanging the check. The capability is cached per repository slug for the process, so one run never mixes repositories, and it carries no static repository identity: the same code serves `admin1316/ark`, a fork, and an Organization-owned repository.

## Verification

[Issue-management tests](../../../../.github/issue-management/policy.test.mjs) pin the call chain from `pullRequestSnapshot` to `validatePullRequest` over a fake transport: a User-owned repository never calls the organization-only endpoint while kind, area, reference, legacy-label, and pull-request-as-Issue rules still fire; a declared Priority on a User-owned resolving pull request returns `BLOCKED_UNVERIFIED`; a resolving pull request without an obligation returns a NOT_APPLICABLE notice and exit 0; an Organization-owned repository preserves every Priority rule including the highest of several Issues; a partially readable set is never compared partially; `401`, `403`, `404`, `410`, `429`, `500`, invalid JSON, transport failure, timeout, non-array payloads, missing `owner.type`, and metadata failure all reject; two repositories in one process keep separate capability state; the enforcement boundary stays Draft- and review-gated; and the real CLI exits 0 for PASS, non-zero for FAIL and BLOCKED_UNVERIFIED, proven through a loopback server. `pnpm run test:issue-management` runs that file inside `ci-static`.

[Workflow contract tests](../../../../scripts/ci-workflow.spec.ts) pin the `ready_for_review` trigger on [issue-policy.yml](../../../../.github/workflows/issue-policy.yml), and this branch changes no workflow file at all, so the trusted default-branch checkout, the pinned action revision, and the minimal permissions remain in force — which is why the trusted check still runs the previous implementation until this change reaches the default branch.

Organization-path behaviour is verified against the official contract and the controlled call-chain tests. No live Organization-owned repository call was made in this round: the available credential produced no suitable organization sample (`GET /user/orgs` returned an empty list). That means only that this round did not obtain a suitable sample; it is not evidence that no accessible organization exists, not evidence for or against platform support, and it never feeds the capability decision. ORGANIZATION_LIVE_VALIDATION = NOT_RUN.

## Alternatives considered

**Treat a `404` as "no Issue Fields".** This is the smallest patch and clears the false failure, but it converts every capability, permission, and routing fault into a silent pass and removes Priority enforcement from repositories that do have fields.

**Decide the capability from the `404` itself.** The endpoint's documented `404` is generic, so it cannot separate a personal repository from a broken capability or a rejected request. Repository metadata answers the question before the call instead.

**Keep the notice-only handling for a declared Priority.** That is the inconsistency this closeout removes: the log said Priority was unverified while the required check reported success. A pending obligation is a failure, not an explanation.

**Infer "no obligation" from an empty or unreadable read.** An unreadable value is unknown, so treating it as proof that no consistency duty exists would let a missing capability erase the rule. The obligation is defined by the declared and readable triggers instead.

**Skip the Issue policy for personal repositories.** References, labels, and lifecycle duties still apply there; only Priority depends on Issue Fields.

**Probe `GET /orgs/{org}/issue-fields` to disambiguate an Organization-owned `404`.** The workflow's `GITHUB_TOKEN` carries repository-scoped permissions, so an organization endpoint can itself answer `404` or `403` for reasons unrelated to the capability, replacing one ambiguous signal with another.

## Consequences

A User-owned repository keeps its required check meaningful: references, kinds, areas, and labels are enforced, and a resolving pull request that declares a Priority now fails closed with `BLOCKED_UNVERIFIED` instead of passing with a notice. A resolving pull request with no Priority obligation stays NOT_APPLICABLE under the same rules that apply to an Organization-owned Issue that simply has no Priority.

An Organization-owned repository with Issue Fields behaves exactly as before. An Organization-owned repository whose organization has not enabled Issue Fields, or whose endpoint is unavailable, fails the check closed, because Priority cannot be verified there; revisiting that needs a repository-scoped capability signal rather than another reading of the status code.

Native Issue Type validation in `validateIssue` is unchanged. Issue types are documented as inherited from the repository's organization owner, and a User-owned repository cannot set one today; that separate gap is not addressed here.

The Projects status path (`projectContext`, which resolves `organization(login:)`) is likewise unchanged and unresolved for a User-owned repository; this note does not claim that personal repositories are fully supported for Issue management.
