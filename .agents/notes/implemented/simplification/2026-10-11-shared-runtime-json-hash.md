# Agent Note: Shared runtime JSON hash

Status: implemented

English | [中文](2026-10-11-shared-runtime-json-hash.zh.md)

## Problem

The runtime build plan and installed-closure verifier carried separate implementations of the same JSON content-manifest hash. Independent copies let key ordering or serialization diverge without a change to the manifest contract.

## Decision

The [build plan](../../../../integrations/jiuzhang/src/runtime-plan.mjs) imports the existing `jsonSha256` from the [runtime closure owner](../../../../integrations/jiuzhang/src/runtime-closure.mjs). The owner sorts object keys with the existing comparison, preserves array order, serializes with two-space indentation and a trailing newline, and hashes the complete UTF-8 bytes.

The payload walks retain their own policies: runtime closure rejects hardlinks and ignores Finder metadata, while the plan records source content. Sharing the hash does not merge those boundaries or change source-identity inputs.

The closure CLI starts verification without a top-level await, so its exports finish evaluation before it dynamically loads the source plan. That plan can import the shared helpers without waiting for the verifier module that is waiting for the plan. The subprocess contract accepts a matching bound plan and keeps exit code 2 for a changed source plan.

## Alternatives considered

**Keep both implementations.** Content manifests need one hashing rule, and the closure already exports it.

**Create another utility module.** The existing owner has both build and runtime consumers; another file or dependency adds no contract.

**Share directory traversal too.** Its admission and failure policies differ. Hash equality does not establish traversal-policy equivalence.

## Consequences

The plan removes its local sorting and JSON-hash functions. Imports add no new package, filesystem write or process launch. Differential comparison covers complete serialized bytes and digests for finite JSON and file/link manifest objects; the existing runtime-plan and runtime-closure tests retain source binding, package boundaries and tamper rejection. A source edit changes the bound source identity even when the content-hashing rule is unchanged. These checks do not establish installed-candidate or release acceptance.
