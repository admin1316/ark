# Agent Note: Verify Workspace binding before a first prompt

Status: implemented

English | [中文](2026-10-10-native-first-prompt-workspace-binding.zh.md)

## Problem

A Workspace selected in the new-conversation composer does not prove that the Host created the Session under that Workspace. If the returned Session has another working directory or the Workspace registry does not own it, dispatching the first prompt can execute the user's task in the wrong project.

## Decision

Before a first prompt is sent, the native client sends the selected `workspaceId`, refreshes the authoritative Workspace and Session lists, and checks that the Session is listed by the selected Workspace and that its normalized `cwd` matches the selected Workspace path. Explicit blank-Session creation performs the same check before navigation. A mismatch fails closed: the prompt is not sent, the draft and selected Workspace remain visible, and the composer receives an actionable error. Because the Host has already returned a mismatched Session, the restored draft discards that creation identity so a retry requests a distinct Session.

This check validates Host ownership and working-directory metadata; it does not sandbox file reads to the Workspace. Read-only mode continues to restrict writes according to its existing policy.

## Verification

The native AppModel contract fixture covers the first-submit wire request, a returned Session with the wrong `cwd`, a correctly registered Session, draft preservation, prompt suppression, and creation-identity rotation before retry. The Jiuzhang Node tests pass 97/97, and the native contract executable passes all 53/53 contract groups.

## Alternatives considered

**Trust the requested `workspaceId` without checking the returned Session.** The request can be correct while the persisted Session metadata or Workspace membership is wrong, so the first task would still run outside the selected project.

**Send the prompt and report a mismatch after the Host refresh.** The model may already have read or changed project files by the time the client detects the wrong Session, so post-dispatch reporting cannot contain the failure.

**Reuse the same creation identity after a confirmed mismatch.** The Host has already created a blank Session with that identity; a retry could collide with the existing mismatched Session instead of creating one under the selected Workspace.

## Consequences

New-conversation submission waits for one additional navigation refresh before dispatch. When the Host returns inconsistent Workspace ownership or `cwd`, Ark preserves the user draft and requires a fresh Session identity before retrying. A successful metadata check does not prove that read-only tools are unable to inspect files outside the Workspace; that guarantee would require a separate filesystem-boundary design and acceptance test.
