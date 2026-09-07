import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  decideCandidateGovernance,
  governancePolicyVersion,
  resolveGovernedWikiPath,
} from '../src/governance-policy.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'wiki-governance-'))
  roots.push(value)
  return value
}

it('fails closed when durable-path inspection encounters a non-missing filesystem error', () => {
  const value = root()
  writeFileSync(join(value, 'not-a-directory'), 'file', 'utf8')
  expect(() => resolveGovernedWikiPath(value, 'not-a-directory/child.md', true)).toThrow()
})

function page(options: {
  title?: string
  body?: string
  sources?: string
  related?: string
  extra?: string
} = {}): string {
  const title = options.title ?? 'Canonical admission method'
  const body = options.body ?? [
    '## 原则',
    '稳定知识必须记录方法、约束、决策、根因、风险和回滚边界。'.repeat(4),
    '## 适用条件',
    '适用于候选晋升流程，前提是存在独立来源和明确限制。',
    '## 验证证据',
    '- 测试通过并完成实际请求验收，记录输入、输出和回滚点。',
  ].join('\n')
  return `---
title: ${title}
sources: ${options.sources ?? '["repo:ark/docs/architecture.md"]'}
related: ${options.related ?? '["concepts/governance"]'}
${options.extra ?? ''}---

# ${title}

${body}
`
}

function writeCanonical(wikiRoot: string, relativePath: string, content: string): void {
  const full = join(wikiRoot, relativePath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

describe('governance disposition matrix', () => {
  it('publishes the deterministic policy identity', () => {
    expect(governancePolicyVersion()).toBe('wiki-governance-v3')
  })

  it('deduplicates, merges, and holds against an explicit canonical target', () => {
    const wikiRoot = root()
    const target = 'concepts/topic.md'
    const canonical = page()
    writeCanonical(wikiRoot, target, canonical)

    expect(decideCandidateGovernance(wikiRoot, '_candidates/a.md', canonical, target))
      .toMatchObject({ action: 'Deduplicate', targetPath: target })

    const shortCanonical = page({ body: 'alpha beta gamma' })
    writeCanonical(wikiRoot, target, shortCanonical)
    const superset = page({ body: 'alpha beta gamma\n' + page().split('\n\n').slice(2).join('\n\n') })
    expect(decideCandidateGovernance(wikiRoot, '_candidates/a.md', superset, target))
      .toMatchObject({ action: 'Merge', targetPath: target })

    const divergent = page({ body: [
      '## 原则',
      'completely different durable constraint and decision '.repeat(20),
      '## 适用条件',
      '适用于另一流程并记录边界。',
      '## 验证证据',
      '- 测试通过后执行验收和回滚检查。',
    ].join('\n') })
    expect(decideCandidateGovernance(wikiRoot, '_candidates/a.md', divergent, target))
      .toMatchObject({ action: 'Hold', reasons: ['same target but bodies diverge'] })

    const ineligible = page({ body: 'A merely descriptive paragraph '.repeat(5), sources: '["session:1"]' })
    expect(decideCandidateGovernance(wikiRoot, '_candidates/a.md', ineligible, target).reasons)
      .toContain('candidate is not eligible to change canonical knowledge')
  })

  it('finds recursive canonical matches and ignores non-Markdown entries', () => {
    const wikiRoot = root()
    mkdirSync(join(wikiRoot, 'concepts', 'nested'), { recursive: true })
    mkdirSync(join(wikiRoot, 'entities'), { recursive: true })
    writeFileSync(join(wikiRoot, 'concepts', 'ignore.txt'), 'not canonical', 'utf8')
    writeFileSync(join(wikiRoot, 'concepts', 'nested', 'weak.md'), page({ title: 'Other', body: 'unrelated' }), 'utf8')
    writeFileSync(join(wikiRoot, 'entities', 'topic.md'), page(), 'utf8')
    mkdirSync(join(wikiRoot, 'findings'), { recursive: true })
    writeFileSync(join(wikiRoot, 'findings', 'later-weak.md'), '# Weak\nminimal unrelated body', 'utf8')

    const decision = decideCandidateGovernance(wikiRoot, '_candidates/a.md', page())
    expect(decision).toMatchObject({
      action: 'Deduplicate',
      targetPath: 'entities/topic.md',
    })
  })

  it('handles empty bodies and title fallbacks while comparing weak canonical pages', () => {
    const wikiRoot = root()
    mkdirSync(join(wikiRoot, 'concepts'), { recursive: true })
    writeFileSync(join(wikiRoot, 'concepts', 'empty.md'), '---\nsources: []\n---\n', 'utf8')
    writeFileSync(join(wikiRoot, 'concepts', 'heading.md'), '# B\nsmall body', 'utf8')
    writeFileSync(join(wikiRoot, 'concepts', 'z.md'), 'body without a heading', 'utf8')

    const decision = decideCandidateGovernance(
      wikiRoot,
      '_candidates/topics/a.md',
      page({ title: 'A', body: 'stable nonmatching material '.repeat(10), related: '[]' }),
    )
    expect(['Archive', 'Hold']).toContain(decision.action)
  })

  it('promotes eligible candidates, archives low quality, and holds uncertain work', () => {
    const wikiRoot = root()
    const promoted = decideCandidateGovernance(
      wikiRoot,
      '_candidates/topics/a.md',
      page(),
      'concepts/a.md',
    )
    expect(promoted.action).toBe('Promote')
    expect(promoted.confidence).toBeLessThanOrEqual(0.98)

    const archived = decideCandidateGovernance(
      wikiRoot,
      '_candidates/topics/a.md',
      page({ body: 'A'.repeat(90), sources: '[]', related: '[]' }),
    )
    expect(archived.action).toBe('Archive')
    expect(archived.targetPath).toBeUndefined()

    const held = decideCandidateGovernance(
      wikiRoot,
      '_candidates/topics/a.md',
      page({ body: 'A durable but unverified explanation '.repeat(5), sources: '["repo:one"]', related: '[]' }),
    )
    expect(held.action).toBe('Hold')
    expect(held.reasons).toContain('insufficient confidence for autonomous disposition')
  })
})

describe('governance quality and rejection evidence', () => {
  it.each([
    {
      label: 'command title',
      path: '_candidates/sessions/a.md',
      content: page({ title: '继续', body: '稳定方法和验证证据 '.repeat(20) }),
      reason: 'title is a conversational command',
    },
    {
      label: 'pasted placeholder',
      path: '_candidates/topics/a.md',
      content: page({ title: 'pasted-image-available', body: '稳定方法 '.repeat(30) }),
      reason: 'pasted-image placeholder',
    },
    {
      label: 'incident',
      path: '_candidates/incidents/a.md',
      content: page(),
      reason: 'incident history belongs in Evidence or Archive, not Canonical',
    },
    {
      label: 'incomplete reflection',
      path: '_candidates/reflections/a.md',
      content: page({ extra: 'candidate_kind: reflection\nepistemic_status: hypothesis\nindependent_source_count: 0\n' }),
      reason: 'reflection is missing failure, cause, counterfactual, prevention, or applicability',
    },
    {
      label: 'very short',
      path: '_candidates/topics/a.md',
      content: page({ body: 'too short' }),
      reason: 'knowledge body is too short',
    },
    {
      label: 'session question',
      path: '_candidates/sessions/a.md',
      content: page({ title: '为什么这样？', body: '普通回答内容 '.repeat(20) }),
      reason: 'generic session Q&A without durable project knowledge',
    },
    {
      label: 'transcript process pollution',
      path: '_candidates/topics/a.md',
      content: page({ body: '本轮输入 使用工具 bash read '.repeat(20) }),
      reason: 'conversation transcript markers remain in the body',
    },
    {
      label: 'tool log flood',
      path: '_candidates/topics/a.md',
      content: page({ body: 'bash read edit git: abcdef1 tarball 编译打包 API Error Cogitated '.repeat(8) }),
      reason: 'tool and progress log pollution',
    },
    {
      label: 'unverified completion claim',
      path: '_candidates/topics/a.md',
      content: page({ body: '已修复 全部完成 bash read '.repeat(20) }),
      reason: 'assistant completion claim has no independent verification',
    },
  ])('archives $label with its reason', ({ path, content, reason }) => {
    const decision = decideCandidateGovernance(root(), path, content, 'concepts/a.md')
    expect(decision.action).toBe('Archive')
    expect(decision.reasons).toContain(reason)
  })

  it('keeps complete but unverified reflections in review', () => {
    const body = [
      '## 失败模式', '故障说明',
      '## 根因假设', '根因说明',
      '## 反事实做法', '替代方法',
      '## 防复发动作', '验证步骤',
      '## 适用条件', '适用边界',
      '稳定原则、风险、回滚和验收。'.repeat(15),
    ].join('\n')
    const decision = decideCandidateGovernance(
      root(),
      '_candidates/reflections/a.md',
      page({
        body,
        sources: '["repo:one"]',
        extra: 'candidate_kind: reflection\nepistemic_status: hypothesis\nindependent_source_count: 1\n',
      }),
      'methodology/reflection.md',
    )
    expect(decision.action).toBe('Hold')
    expect(decision.reasons).toContain('reflection remains a hypothesis until independently verified')
    expect(decision.reasons).toContain('reflection has fewer than two independent sources')
  })

  it('records missing, session-only, unstable, transcript, and score penalties', () => {
    const noSource = decideCandidateGovernance(
      root(),
      '_candidates/topics/a.md',
      page({
        body: '## 方法\n原则和验证证据与适用条件。'.repeat(20),
        sources: '[]',
      }),
      'concepts/a.md',
    )
    expect(noSource.reasons).toContain('candidate has no source evidence')
    expect(noSource.reasons).toContain('candidate has no independent source evidence')
    const missingSourceField = decideCandidateGovernance(
      root(),
      '_candidates/topics/missing-source.md',
      page().replace(/^sources:.*\n/mu, ''),
      'concepts/missing-source.md',
    )
    expect(missingSourceField.reasons).toContain('candidate has no source evidence')

    const polluted = decideCandidateGovernance(
      root(),
      '_candidates/topics/a.md',
      page({
        title: 'A title that is intentionally much longer than forty eight characters for scoring',
        body: 'A'.repeat(200) + ' /Users/hui/project git: abcdef1 bash read',
        sources: '["session:one", "workspace:ark"]',
        related: '[]',
      }),
    )
    expect(polluted.reasons).toContain('session or workspace context is not independent evidence')
    expect(polluted.reasons).toContain('local path, build artifact, or revision detail is not stable knowledge')
    expect(polluted.reasons).toContain('deterministic quality score 0/10')
  })

  it('scores non-hard transcript and completion claims before holding them', () => {
    const transcript = decideCandidateGovernance(
      root(),
      '_candidates/topics/a.md',
      page({ body: '本轮结论 稳定原则、适用条件和验收边界。'.repeat(12) }),
    )
    expect(transcript.reasons).toContain('conversation transcript markers remain in the body')

    const claim = decideCandidateGovernance(
      root(),
      '_candidates/topics/a.md',
      page({ body: '已修复。稳定原则、适用条件、风险和操作边界。'.repeat(12) }),
    )
    expect(claim.reasons).toContain('assistant completion claim has no independent verification')

    const hardClaim = decideCandidateGovernance(
      root(),
      '_candidates/topics/a.md',
      page({ body: '已修复。稳定原则和适用条件。 bash read '.repeat(4) }),
    )
    expect(hardClaim.action).toBe('Archive')
  })

  it('evaluates every reflection admission gate without treating hypotheses as canonical', () => {
    const reflectionBody = [
      '## 失败模式', '失败说明',
      '## 根因假设', '根因与原则说明',
      '## 反事实做法', '替代流程',
      '## 防复发动作', '验证步骤和回滚检查',
      '## 适用条件', '适用边界和限制',
      '## 验证证据', '测试通过并完成验收。',
      '稳定方法和决策不变量。'.repeat(12),
    ].join('\n')
    const make = (extra: string, sources = '["repo:one", "repo:two"]', body = reflectionBody) => page({
      body,
      sources,
      extra: `candidate_kind: reflection\n${extra}`,
    })

    expect(decideCandidateGovernance(
      root(), '_candidates/reflections/verified.md',
      make('epistemic_status: verified\nindependent_source_count: 2\n'),
      'methodology/verified.md',
    ).action).toBe('Promote')

    for (const [index, content] of [
      make('epistemic_status: disputed\nindependent_source_count: 2\n'),
      make('epistemic_status: verified\nindependent_source_count: 1\n'),
      make('epistemic_status: verified\nindependent_source_count: 2\n', '["repo:one", "session:two"]'),
      make(
        'epistemic_status: verified\nindependent_source_count: 2\n',
        '["repo:one", "repo:two"]',
        reflectionBody
          .replace('## 验证证据', '## 记录')
          .replace('测试通过并完成验收。', '记录操作步骤但尚无外部证明。'),
      ),
    ].entries()) {
      expect(decideCandidateGovernance(
        root(), '_candidates/reflections/review.md', content, 'methodology/review.md',
      ).action, `reflection gate case ${index}`).toBe('Hold')
    }
  })
})
