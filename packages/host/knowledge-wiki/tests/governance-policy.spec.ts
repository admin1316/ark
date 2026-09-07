import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decideCandidateGovernance } from '../src/governance-policy.ts'

function candidate(sources: string): string {
  return `---
title: Canonical admission gate
sources: ${sources}
related: ["concepts/governance"]
---

# Canonical admission gate

## 原则

候选知识必须具备独立证据、明确适用条件和可执行验证步骤，不能依靠单次会话直接晋升。

## 适用条件

适用于自动提炼、语义去重和正式知识晋升流程。

## 验证证据

测试通过后仍需检查来源、边界和回滚门禁，确保同一主题只保留稳定正式页。
`
}

describe('governance source independence', () => {
  it('holds a high-quality candidate supported only by a session', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-governance-session-'))
    const decision = decideCandidateGovernance(
      root,
      '_candidates/sessions/test.md',
      candidate('["session:session-123", "workspace:ark"]'),
      'concepts/canonical-admission-gate.md',
    )
    expect(decision.action).toBe('Hold')
    expect(decision.reasons).toContain('session or workspace context is not independent evidence')
  })

  it('allows an otherwise eligible candidate with traceable independent evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-governance-evidence-'))
    const decision = decideCandidateGovernance(
      root,
      '_candidates/topics/test.md',
      candidate('["repo:admin1316/ark@abc123:docs/architecture.md"]'),
      'concepts/canonical-admission-gate.md',
    )
    expect(decision.action).toBe('Promote')
  })
})
