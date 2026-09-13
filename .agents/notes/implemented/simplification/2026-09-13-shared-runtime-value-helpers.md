# Agent Note: Share runtime value helpers without weakening ownership checks

Status: implemented

English | [中文](2026-09-13-shared-runtime-value-helpers.zh.md)

## Problem

Session JSON validation and LLM deep freezing duplicated the value utility implementation. Settings structural equality differed in one important condition: an inherited property could satisfy the utility's key lookup, while Settings required an own property. Replacing the Settings implementation without preserving that condition would weaken change detection and provider-transaction comparisons.

## Decision

`dsh-util-values` owns lossless JSON validation and snapshots, iterative deep freezing, and structural JSON equality. Session's existing JSON exports and LLM's existing `deepFreeze` exports forward to that owner. Settings imports and re-exports the shared equality function; equality requires matching own record keys through `Object.hasOwn`.

Public module paths and generic signatures remain available. JSON validation still rejects negative zero, sparse arrays, exotic prototypes, cyclic values, and discarded own properties, while allowing ordinary values across JavaScript realms. Snapshots read each property once and propagate throwing getters. Freezing still guards cycles and leaves live abort signals mutable. Settings' separate schema-result freezer retains its existing lifecycle.

The three consuming packages declare the utility as a runtime dependency and reference its compiler project. No new runtime registry, state, timer, or service is introduced.

## Alternatives considered

**Keep duplicate implementations.** This allows fixes to diverge across persistence, request publication, and Settings consumers.

**Forward Settings equality without changing the utility.** Matching a value inherited from a prototype can conceal a different own-key set. The shared predicate retains Settings' stricter ownership check.

**Change every caller to a new public path.** Existing public exports can forward directly without a second implementation or caller churn.

## Consequences

The Session JSON and LLM freeze behavior suites continue exercising their established public exports. Equality regressions cover both the utility and Settings exports with inherited, nested inherited, and null-prototype records. Provider transaction and offline migration tests exercise downstream comparisons. These checks do not establish a full repository build or Native release acceptance.
