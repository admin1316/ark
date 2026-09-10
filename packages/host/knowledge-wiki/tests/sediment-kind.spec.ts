import { describe, expect, it } from 'vitest'
import { classifyKind, pageRelPath, buildPage, classifyWithLlm, KIND_CLASSIFY_PROMPT } from '../src/auto-sediment.ts'

describe('classifyKind', () => {
  it('question input with problem vocabulary in reply → problem-solving', () => {
    expect(classifyKind('知识库配置会被重置吗', '不会。配置已写入磁盘并验证生效，重启后保持。')).toBe('problem-solving')
    expect(classifyKind('为什么搜索不生效', '原因是索引缓存过期，重建后已确认恢复正常。')).toBe('problem-solving')
    expect(classifyKind('现在知识库你们都可以调用吗', '可以，全链路已修复并验证通过。')).toBe('problem-solving')
  })

  it('statement of a problem with resolution → problem-solving', () => {
    expect(classifyKind('页面显示空白', '根因是渲染组件挂载失败，已回退版本解决。')).toBe('problem-solving')
  })

  it('general knowledge Q&A without problem vocabulary → concept', () => {
    expect(classifyKind('请简述知识图谱可视化的布局思路', '通常有三种思路：视觉编码分层、聚类聚合、交互式多尺度呈现。')).toBe('concept')
    expect(classifyKind('介绍一下这个项目', '这是一个基于 Cordis 的插件化 agent 框架。')).toBe('concept')
  })

  it('question-like input but no problem vocabulary in reply → concept', () => {
    expect(classifyKind('有哪些好用的图标库', '推荐 lucide、heroicons 和 phosphor。')).toBe('concept')
  })

  it('defect complaint without question word + fix action in reply → problem-solving', () => {
    expect(classifyKind('线太粗了 1.8x就好', '把焦点线加粗从 3x 调回 1.8x，全部完成，更新 log。')).toBe('problem-solving')
    expect(classifyKind('球滑到的地方还是灰色没有颜色', '原因是渲染状态未更新，已修复并验证。')).toBe('problem-solving')
  })

  it('「有一个问题」句式（问题词被冠词隔开）→ problem-solving', () => {
    expect(classifyKind('还有一个问题在点到时候 我在去点其他钱又不显示颜色是灰色 我需要有显示', '明白这个问题。根因是点击节点时同时触发了 clickStage，用防御修复。')).toBe('problem-solving')
  })

  it('positive remark with 太… but no fix action → concept', () => {
    expect(classifyKind('这个功能太好了', '谢谢，后续会继续优化。')).toBe('concept')
  })
})

describe('pageRelPath kind routing', () => {
  it('problem-solving → candidate turns/问题解决/', () => {
    expect(pageRelPath('problem-solving', 'foo-s1-t1')).toBe('_candidates/turns/问题解决/foo-s1-t1.md')
  })
  it('concept → candidate turns/会话沉淀/', () => {
    expect(pageRelPath('concept', 'foo-s1-t1')).toBe('_candidates/turns/会话沉淀/foo-s1-t1.md')
  })
})

describe('KIND_CLASSIFY_PROMPT few-shot examples', () => {
  it('pins the two historical misclassification cases (口语缺陷抱怨/无问号)', () => {
    expect(KIND_CLASSIFY_PROMPT).toContain('线太粗了 1.8x就好')
    expect(KIND_CLASSIFY_PROMPT).toContain('不显示颜色是灰色')
    expect(KIND_CLASSIFY_PROMPT).toContain('有哪些好用的图标库')
  })
})

describe('classifyWithLlm', () => {
  const ok = (json: string) => async () => json

  it('parses valid kind + title', async () => {
    const r = await classifyWithLlm(ok('{"kind": "problem-solving", "title": "颜色反馈修复"}'), '不显示颜色', '根因是 clickStage，已修复。')
    expect(r).toEqual({ kind: 'problem-solving', title: '颜色反馈修复' })
  })

  it('rejects invalid kind → null (caller falls back to heuristic)', async () => {
    expect(await classifyWithLlm(ok('{"kind": "other"}'), 'a', 'b')).toBeNull()
    expect(await classifyWithLlm(ok('不是 JSON'), 'a', 'b')).toBeNull()
  })

  it('propagates API failure → caller catch falls back to heuristic', async () => {
    await expect(classifyWithLlm(() => Promise.reject(new Error('API down')), 'a', 'b')).rejects.toThrow('API down')
  })

  it('trims empty title to null', async () => {
    const r = await classifyWithLlm(ok('{"kind": "concept", "title": "  "}'), 'a', 'b')
    expect(r?.kind).toBe('concept')
    expect(r?.title).toBeNull()
  })
})

describe('buildPage kind', () => {
  const pair = {
    sessionId: 's1', turn: 1,
    input: '为什么搜索不生效', output: '原因是缓存过期，重建后恢复。', tools: ['bash'],
  }
  it('problem-solving page carries kind + 问题解决 tags', () => {
    const page = buildPage('为什么搜索不生效', pair, '2026-08-19', '技能强化', 'problem-solving')
    expect(page).toContain('kind: problem-solving')
    expect(page).toContain('tags: [问题解决, 自动生成]')
    expect(page).toContain('针对一个具体问题的解决记录')
  })
  it('concept page carries kind: concept + 会话沉淀 tags by default', () => {
    const page = buildPage('为什么搜索不生效', pair, '2026-08-19', '技能强化')
    expect(page).toContain('kind: concept')
    expect(page).toContain('tags: [会话沉淀, 自动生成]')
  })
})
