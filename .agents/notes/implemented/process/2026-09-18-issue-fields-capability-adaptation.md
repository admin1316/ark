# Agent Note: Issue Fields capability adaptation in the Issue policy

Status: implemented

English | [中文](2026-09-18-issue-fields-capability-adaptation.zh.md)

## Problem

The Issue policy read Issue Field values for every referenced Issue through `GET /repos/{owner}/{repo}/issues/{number}/issue-field-values`. Issue Fields are organization-scoped metadata. The [issue fields changelog](https://github.blog/changelog/2026-07-02-issue-fields-are-now-generally-available/) makes them generally available "for all GitHub organizations" (public preview since May); the [organization guide](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/managing-issue-fields-in-your-organization) states that fields "are defined at the organization level and apply across all repositories in your organization"; and the [REST write endpoints](https://docs.github.com/en/rest/issues/issue-field-values) scope values to "organization-level issue fields that have been defined for the repository's organization". A repository owned by a User has no organization to define them, so the endpoint answers `404` — observed for `admin1316/ark` on issues `#28` and `#34`, where `X-Accepted-Oauth-Scopes: repo` ruled out the token scope as the cause.

The policy treated that response as fatal. Every pull request that referenced an Issue failed the required check while taking the snapshot, before any policy rule was evaluated, however valid its references and labels were. Reading the same `404` as success would instead erase real Priority checks. Neither reaction answers the question the policy actually asks: whether this repository can carry Issue Fields at all.

## Decision

Repository metadata decides the capability, and the field endpoint is consulted only where the documented contract applies. `issueFieldCapability(ownerType)` maps `owner.type` from `GET /repos/{owner}/{repo}` to one of four states, and `issueFieldValues` completes them per Issue.

- `SUPPORTED` — an Organization-owned repository whose `GET .../issue-field-values` returned at least one value.
- `EMPTY` — an Organization-owned repository whose endpoint returned an empty list. Priority is `null`, but the field is enforceable, so the existing Priority rules still run.
- `UNSUPPORTED` — a User-owned repository. The endpoint is never called, Priority stays unreadable, and every other policy check continues to run.
- `UNKNOWN_OR_ERROR` — any other `owner.type`, an Organization-owned `404`, a non-array payload, or any `401`, `403`, `429`, `5xx`, timeout, or transport failure. These reject and fail the run.

Priority consistency for resolving pull requests is enforced only when every resolving Issue's capability is readable. Where the capability is `UNSUPPORTED` that comparison is skipped, and `pullRequestPolicyNotices` prints an explicit `::notice::` naming the Issues, stating that Priority was not verified and does not constitute a Priority pass. The run also prints the observed capability states, so a log distinguishes "no values" from "cannot read values".

The capability is cached per repository slug for the process, so one run never mixes repositories, and it carries no static repository identity: the same code serves `admin1316/ark`, a fork, and an Organization-owned repository.

## Verification

[Issue-management tests](../../../../.github/issue-management/policy.test.mjs) pin the call chain from `pullRequestSnapshot` to `validatePullRequest` over a fake transport: a User-owned repository never calls the organization-only endpoint while kind, area, reference, legacy-label, and pull-request-as-Issue rules still fire; an Organization-owned repository still parses `Priority` and enforces the highest resolving Priority; `EMPTY` and `UNSUPPORTED` stay distinguishable; `404`, `403`, `429`, `500`, invalid JSON, transport failure, non-array payloads, missing `owner.type`, and metadata failure all reject; two repositories in one process keep separate capability state; and Draft and pre-review boundaries are unchanged. `pnpm run test:issue-management` runs that file inside `ci-static`.

[Workflow contract tests](../../../../scripts/ci-workflow.spec.ts) pin the `ready_for_review` trigger on [issue-policy.yml](../../../../.github/workflows/issue-policy.yml), and this branch changes no workflow file at all, so the trusted default-branch checkout, the pinned action revision, and the minimal permissions remain in force — which is why the trusted check still runs the previous implementation until this change reaches the default branch.

## Alternatives considered

**Treat a `404` as "no Issue Fields".** This is the smallest patch and clears the false failure, but it converts every capability, permission, and routing fault into a silent pass and removes Priority enforcement from repositories that do have fields.

**Decide the capability from the `404` itself.** The endpoint's documented `404` is generic, so it cannot separate a personal repository from a broken capability or a rejected request. Repository metadata answers the question before the call instead.

**Skip the Issue policy for personal repositories.** References, labels, and lifecycle duties still apply there; only Priority depends on Issue Fields.

**Probe `GET /orgs/{org}/issue-fields` to disambiguate an Organization-owned `404`.** The workflow's `GITHUB_TOKEN` carries repository-scoped permissions, so an organization endpoint can itself answer `404` or `403` for reasons unrelated to the capability, replacing one ambiguous signal with another.

**Hardcode the repository or add per-repository switches.** The identity is already resolved per run from `GITHUB_REPOSITORY`, and a static switch would recreate the original assumption in configuration.

## Consequences

A User-owned repository keeps its required check meaningful: references, kinds, areas, and labels are enforced, and the one rule that cannot exist there is reported as unverified instead of silently satisfied or permanently failed. An Organization-owned repository with Issue Fields behaves exactly as before.

An Organization-owned repository whose organization has not enabled Issue Fields, or whose endpoint is unavailable, fails the check closed. That is deliberate, because Priority cannot be verified there, and the failure names the capability contradiction; revisiting it needs a repository-scoped capability signal rather than another reading of the status code.

Native Issue Type validation in `validateIssue` is unchanged. Issue types are documented as inherited from the repository's organization owner, and a User-owned repository cannot set one today; that separate gap is not addressed here.
