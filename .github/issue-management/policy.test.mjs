import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  countVisibleUnits,
  issueFieldCapability,
  nextResolvingIssueStatus,
  parseReferences,
  pullRequestPolicyNotices,
  pullRequestSnapshot,
  resetRepositoryMetadataCache,
  retainIssueReferences,
  resolvingIssueStatusCommand,
  repositoryIdentity,
  requiresPullRequestPolicy,
  validateBody,
  validateIssue,
  validatePullRequest,
} from './policy.mjs'

const withDetails = (summary) =>
  `${summary}\n\n<details><summary>验收与细节</summary>待补充。</details>`

const legalIssue = {
  title: '完成议题管理校验',
  body: withDetails('完成议题管理校验。'),
  assignees: [],
  labels: [],
  type: 'Idea',
  priority: null,
  status: 'In review',
  state: 'open',
  stateReason: null,
}

const canonicalKinds = [
  'kind/feature',
  'kind/bug-fix',
  'kind/doc',
  'kind/testing',
  'kind/cleanup',
  'kind/dependency',
]

// Keep an independent oracle rather than importing the implementation's reserved set.
const legacyLabels = [
  'kind/bug',
  'kind/documentation',
  'feature',
  'bug-fix',
  'doc',
  'cleanup',
  'testing',
  'dependencies',
  'ci',
  'cli',
  'llm',
  'web-search',
]

const reviewedPull = (labels) => ({
  isDraft: false,
  authorType: 'User',
  reviewRequestCount: 1,
  reviewCount: 0,
  labels,
  references: { all: [2], resolving: [], related: [2] },
  issues: new Map([[2, { priority: null }]]),
})

test('counts only text outside details', () => {
  assert.deepEqual(countVisibleUnits('支持 GitHub Project。<details>隐藏文字</details>'), {
    units: 4,
    balanced: true,
    detailsCount: 1,
    allCollapsed: true,
  })
})

test('requires a balanced default-collapsed details region', () => {
  assert.deepEqual(validateBody({ body: '完成工作。', assignees: [] }), [
    '正文必须包含默认收起的 <details> 区域',
  ])
  assert.deepEqual(
    validateBody({
      body: '完成工作。\n\n<details open><summary>细节</summary>待补充。</details>',
      assignees: [],
    }),
    ['details 必须默认收起，不得设置 open'],
  )
  assert.deepEqual(
    validateBody({ body: '完成工作。\n\n<details><summary>细节</summary>', assignees: [] }),
    ['details 标签必须成对闭合'],
  )
})

test('requires Owner for multiple assignees', () => {
  assert.deepEqual(
    validateBody({
      body: withDetails('完成工作。'),
      assignees: ['tianyicui', 'tianyicui-bot'],
    }),
    ['多个 Assignees 时首个非空行必须是 Owner: @login'],
  )
})

test('accepts an intended Owner while assignment permission is pending', () => {
  assert.deepEqual(
    validateBody({
      body: withDetails('Owner: @octocat\n\n完成工作。'),
      assignees: [],
    }),
    [],
  )
  assert.deepEqual(
    validateBody({
      body: withDetails('Owner: @octocat\n\n完成工作。'),
      assignees: ['hubot'],
    }),
    ['零或一个 Assignee 时不得写 Owner 行'],
  )
})

test('allows optional metadata in every open Status', () => {
  assert.deepEqual(validateIssue(legalIssue), [])
  for (const status of ['Inbox', 'Backlog', 'Ready', 'In progress', 'In review']) {
    assert.deepEqual(validateIssue({ ...legalIssue, status }), [])
  }
})

test('rejects metadata prefixes in an Issue title', () => {
  const errors = validateIssue({ ...legalIssue, title: '[Bug] 修复恢复错误' })
  assert.ok(errors.includes('Issue 标题不得带 Type、Priority、Status、area 或 Owner 前缀'))
})

test('reserves PR kind and legacy labels for pull requests', () => {
  for (const label of [
    ...canonicalKinds,
    'kind/experimental',
    ...legacyLabels,
  ]) {
    assert.ok(
      validateIssue({ ...legalIssue, labels: [label] }).some((error) =>
        error.startsWith('Issue 不得使用 PR kind 或旧版标签：'),
      ),
      label,
    )
  }
  assert.deepEqual(validateIssue({ ...legalIssue, labels: ['area/web', 'source/member'] }), [])
})

test('keeps terminal Status aligned with the native close reason', () => {
  assert.deepEqual(
    validateIssue({ ...legalIssue, status: 'Done', state: 'closed', stateReason: 'completed' }),
    [],
  )
  assert.deepEqual(
    validateIssue({
      ...legalIssue,
      status: 'No action',
      state: 'closed',
      stateReason: 'not_planned',
    }),
    [],
  )
  assert.ok(validateIssue({ ...legalIssue, status: 'Done' }).includes('Done 必须对应 Completed 关闭原因'))
})

test('separates resolving and informational references', () => {
  assert.deepEqual(
    parseReferences({
      body: 'Fixes #12\nRelated to #4\nRefs deepseekharness/dsh-test#7',
      repository: 'deepseekharness/dsh-test',
    }),
    { all: [4, 7, 12], resolving: [12], related: [4, 7] },
  )
})

test('does not treat pull request references as Issue associations', () => {
  const references = {
    all: [123, 1180, 1181],
    resolving: [123, 1180],
    related: [1181],
  }
  const issues = new Map([
    [1180, {}],
    [1181, {}],
  ])

  assert.deepEqual(retainIssueReferences(references, issues), {
    all: [1180, 1181],
    resolving: [1180],
    related: [1181],
  })
})

test('allows informational references without cross-object constraints', () => {
  const errors = validatePullRequest({
    isDraft: false,
    authorType: 'User',
    reviewRequestCount: 1,
    reviewCount: 0,
    labels: ['kind/cleanup', 'area/infra'],
    references: { all: [4], resolving: [], related: [4] },
    issues: new Map([[4, { type: 'Bug', priority: 'P0', labels: ['area/web'] }]]),
  })
  assert.deepEqual(errors, [])
})

test('enforces highest resolving Priority without Type or area synchronization', () => {
  const pull = {
    isDraft: false,
    authorType: 'User',
    reviewRequestCount: 0,
    reviewCount: 1,
    labels: ['kind/cleanup', 'p0', 'area/web'],
    references: { all: [2, 3], resolving: [2, 3], related: [] },
    issues: new Map([
      [2, { type: 'Feature', priority: 'P2', labels: ['area/web'] }],
      [3, { type: 'Bug', priority: 'P0', labels: ['area/session'] }],
    ]),
  }
  assert.deepEqual(validatePullRequest(pull), [])
  assert.ok(
    validatePullRequest({ ...pull, labels: ['kind/cleanup', 'p2', 'area/web'] }).includes(
      'PR Priority 应为 p0',
    ),
  )
})

test('requires policy only after a human PR enters review', () => {
  assert.equal(
    requiresPullRequestPolicy({
      isDraft: false,
      authorType: 'User',
      reviewRequestCount: 1,
      reviewCount: 0,
    }),
    true,
  )
  assert.equal(
    requiresPullRequestPolicy({
      isDraft: false,
      authorType: 'User',
      reviewRequestCount: 0,
      reviewCount: 0,
    }),
    false,
  )
})

test('maps only explicit review handoffs to review status commands', () => {
  assert.equal(
    resolvingIssueStatusCommand('pull_request', {
      action: 'review_requested',
    }),
    'review-requested',
  )
  assert.equal(
    resolvingIssueStatusCommand('pull_request_review', {
      action: 'submitted',
      review: { state: 'changes_requested' },
    }),
    'changes-requested',
  )
  for (const state of ['approved', 'commented']) {
    assert.equal(
      resolvingIssueStatusCommand('pull_request_review', {
        action: 'submitted',
        review: { state },
      }),
      null,
    )
  }
  assert.equal(
    resolvingIssueStatusCommand('pull_request_review', {
      action: 'dismissed',
      review: { state: 'changes_requested' },
    }),
    null,
  )
})

test('keeps ordinary pull request events as forward-only implementation signals', () => {
  for (const action of ['opened', 'edited', 'synchronize', 'reopened', 'labeled', 'unlabeled']) {
    assert.equal(resolvingIssueStatusCommand('pull_request', { action }), 'implementation')
  }
  assert.equal(
    resolvingIssueStatusCommand('pull_request', { action: 'review_request_removed' }),
    null,
  )
})

test('toggles automation-owned work on request changes and repeated review request', () => {
  for (const status of ['Inbox', 'Backlog', 'Ready']) {
    assert.equal(nextResolvingIssueStatus(status, 'implementation'), 'In progress')
    assert.equal(nextResolvingIssueStatus(status, 'review-requested'), 'In review')
    assert.equal(nextResolvingIssueStatus(status, 'changes-requested'), 'In progress')
  }
  let status = nextResolvingIssueStatus(
    'In review',
    'changes-requested',
    'dsh-issue-management',
  )
  assert.equal(status, 'In progress')
  status = nextResolvingIssueStatus(status, 'review-requested')
  assert.equal(status, 'In review')
})

test('preserves human review status and terminal Issues', () => {
  assert.equal(nextResolvingIssueStatus('In progress', 'implementation'), null)
  assert.equal(nextResolvingIssueStatus('In review', 'implementation'), null)
  assert.equal(nextResolvingIssueStatus('In review', 'review-requested'), null)
  assert.equal(nextResolvingIssueStatus('In review', 'changes-requested', 'tianyicui'), null)
  assert.equal(nextResolvingIssueStatus('In review', 'changes-requested'), null)
  assert.equal(nextResolvingIssueStatus('Done', 'review-requested'), null)
  assert.equal(nextResolvingIssueStatus('No action', 'changes-requested'), null)
  assert.equal(nextResolvingIssueStatus(null, 'review-requested'), null)
})

test('keeps lifecycle projection independent of PR metadata enforcement', () => {
  const pull = {
    isDraft: false,
    authorType: 'User',
    reviewRequestCount: 1,
    reviewCount: 0,
    labels: [],
    references: { all: [2], resolving: [2], related: [] },
    issues: new Map([[2, { priority: null }]]),
  }

  assert.ok(validatePullRequest(pull).length > 0)
  assert.equal(nextResolvingIssueStatus('Inbox', 'review-requested'), 'In review')
})

test('exempts Draft, Bot, and App PRs', () => {
  const invalid = {
    isDraft: false,
    labels: [],
    references: { all: [], resolving: [], related: [] },
    issues: new Map(),
    reviewRequestCount: 1,
    reviewCount: 0,
  }
  assert.deepEqual(validatePullRequest({ ...invalid, authorType: 'Bot' }), [])
  assert.deepEqual(validatePullRequest({ ...invalid, authorType: 'App' }), [])
  assert.deepEqual(validatePullRequest({ ...invalid, authorType: 'User', isDraft: true }), [])
  assert.ok(validatePullRequest({ ...invalid, authorType: 'User' }).length > 0)
})

test('requires repository PR labels in the enforcement scope', () => {
  const errors = validatePullRequest({
    isDraft: false,
    authorType: 'User',
    reviewRequestCount: 1,
    reviewCount: 0,
    labels: [],
    references: { all: [2], resolving: [], related: [2] },
    issues: new Map([[2, { priority: null }]]),
  })
  assert.ok(errors.includes('PR 必须恰好有一个允许的 kind/*，当前为 0'))
  assert.ok(errors.includes('PR 必须至少有一个 area/*'))
})

test('accepts exactly the canonical kinds with extensible areas', () => {
  for (const kind of canonicalKinds) {
    assert.deepEqual(validatePullRequest(reviewedPull([kind, 'area/future-domain'])), [], kind)
  }
})

test('rejects multiple, unknown, legacy, and Issue-source PR labels', () => {
  assert.ok(
    validatePullRequest(
      reviewedPull(['kind/feature', 'kind/doc', 'area/web']),
    ).includes('PR 必须恰好有一个允许的 kind/*，当前为 2'),
  )
  assert.ok(
    validatePullRequest(reviewedPull(['kind/experimental', 'area/web'])).includes(
      'PR 含不支持的 kind/*：kind/experimental',
    ),
  )
  for (const label of legacyLabels) {
    assert.ok(
      validatePullRequest(reviewedPull(['kind/feature', 'area/web', label])).some((error) =>
        error.startsWith('PR 含旧版标签：'),
      ),
      label,
    )
  }
  assert.ok(
    validatePullRequest(
      reviewedPull(['kind/feature', 'area/web', 'source/internal-pr']),
    ).includes('source/* 仅用于 Issue：source/internal-pr'),
  )
})

test('allows missing Priority only when resolving Issues are also unprioritized', () => {
  const pull = {
    isDraft: false,
    authorType: 'User',
    reviewRequestCount: 1,
    reviewCount: 0,
    labels: ['kind/feature', 'area/web'],
    references: { all: [2], resolving: [2], related: [] },
    issues: new Map([[2, { priority: null }]]),
  }
  assert.deepEqual(validatePullRequest(pull), [])
  assert.ok(
    validatePullRequest({ ...pull, issues: new Map([[2, { priority: 'P2' }]]) }).includes(
      'PR Priority 应为 p2',
    ),
  )
  assert.ok(
    validatePullRequest({ ...pull, labels: [...pull.labels, 'p2'] }).includes(
      '有 Priority 的解决型 PR 要求每个被解决 Issue 都设置 Priority',
    ),
  )
})

test('resolves the repository identity from the workflow context', () => {
  assert.deepEqual(repositoryIdentity({ GITHUB_REPOSITORY: 'admin1316/ark' }), {
    owner: 'admin1316',
    name: 'ark',
    slug: 'admin1316/ark',
  })
  assert.deepEqual(repositoryIdentity({ GITHUB_REPOSITORY: 'some-fork/ark' }).slug, 'some-fork/ark')
  assert.throws(() => repositoryIdentity({}), /GITHUB_REPOSITORY/u)
  assert.throws(() => repositoryIdentity({ GITHUB_REPOSITORY: 'deepseek-harness' }), /GITHUB_REPOSITORY/u)
})

test('keeps no static repository identity in the configuration', () => {
  const configuration = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'))
  assert.equal(configuration.organization, undefined)
  assert.equal(configuration.repository, undefined)
})

test('resolves same-repository references against the current identity only', () => {
  const repository = repositoryIdentity({ GITHUB_REPOSITORY: 'admin1316/ark' }).slug
  const references = parseReferences({
    body: '修复 admin1316/ark#12，并跟踪 deepseek-harness/deepseek-harness#34。',
    repository,
  })
  assert.deepEqual(references.all, [12])
  assert.ok(!references.all.includes(34))
})

const FAKE_API_HOST = 'https://api.github.test'

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    json: async () => (typeof payload === 'string' ? JSON.parse(payload) : payload),
  }
}

function issuePayload(number, overrides = {}) {
  return {
    number,
    node_id: 'I_' + number,
    title: '议题 ' + number,
    body: withDetails('正文。'),
    assignees: [],
    labels: [],
    type: { name: 'Task' },
    state: 'open',
    state_reason: null,
    ...overrides,
  }
}

function pullPayload(number, overrides = {}) {
  const { labels = [], ...rest } = overrides
  return {
    number,
    draft: false,
    user: { type: 'User' },
    body: 'Related to #' + (number + 1),
    labels: labels.map((name) => ({ name })),
    ...rest,
  }
}

// A fake transport over the real snapshot -> validation call chain.
function installFakeApi(options) {
  const { fields = {}, issues = {}, pull } = options
  const owners = options.repositories ?? { [options.repository]: options.ownerType ?? 'User' }
  resetRepositoryMetadataCache()
  const originalFetch = globalThis.fetch
  const previousRepository = process.env.GITHUB_REPOSITORY
  const previousToken = process.env.GH_TOKEN
  const calls = []
  process.env.GITHUB_REPOSITORY = options.repository ?? Object.keys(owners)[0]
  process.env.GH_TOKEN = 'fake-token'
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url))
    const path = parsed.pathname + parsed.search
    calls.push(path)
    const metadataMatch = /^\/repos\/([^/]+)\/([^/]+)$/u.exec(path)
    if (metadataMatch) {
      const slug = metadataMatch[1] + '/' + metadataMatch[2]
      if (options.metadataStatus && options.metadataStatus !== 200) {
        return jsonResponse(options.metadataStatus, { message: 'metadata failure' })
      }
      if (options.metadataNetworkError) throw new Error('metadata network down')
      if (!(slug in owners)) return jsonResponse(404, { message: 'Not Found' })
      const owner = owners[slug] === 'MISSING' ? {} : { type: owners[slug] }
      return jsonResponse(200, { full_name: slug, owner })
    }
    const pullMatch = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/u.exec(path)
    if (pull && pullMatch && Number(pullMatch[3]) === pull.number) return jsonResponse(200, pull)
    const reviewersMatch = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/requested_reviewers$/u.exec(path)
    if (pull && reviewersMatch && Number(reviewersMatch[3]) === pull.number) {
      return jsonResponse(200, options.reviewRequests ?? { users: [], teams: [] })
    }
    const reviewsMatch = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/reviews$/u.exec(parsed.pathname)
    if (pull && reviewsMatch && Number(reviewsMatch[3]) === pull.number) {
      return jsonResponse(200, options.reviews ?? [])
    }
    const issueMatch = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/u.exec(path)
    if (issueMatch) {
      const issue = issues[Number(issueMatch[1])]
      return issue ? jsonResponse(200, issue) : jsonResponse(404, { message: 'Not Found' })
    }
    const fieldMatch = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/issue-field-values$/u.exec(parsed.pathname)
    if (fieldMatch) {
      const entry = fields[Number(fieldMatch[1])]
      if (entry === undefined) return jsonResponse(200, [])
      if (Array.isArray(entry)) return jsonResponse(200, entry)
      if (entry.networkError) throw new Error('fields network down')
      if (typeof entry.raw === 'string') {
        return {
          ok: entry.status === 200,
          status: entry.status,
          text: async () => entry.raw,
          json: async () => JSON.parse(entry.raw),
        }
      }
      if (entry.status !== 200) return jsonResponse(entry.status, { message: 'field failure' })
      return jsonResponse(200, entry.body)
    }
    throw new Error('unexpected request: ' + path + ' (' + FAKE_API_HOST + ')')
  }
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch
      if (previousRepository === undefined) delete process.env.GITHUB_REPOSITORY
      else process.env.GITHUB_REPOSITORY = previousRepository
      if (previousToken === undefined) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = previousToken
    },
  }
}

async function withFakeApi(options, run) {
  const fake = installFakeApi(options)
  try {
    return await run(fake)
  } finally {
    fake.restore()
  }
}

const reviewedRequests = { users: [{ login: 'reviewer' }], teams: [] }

test('decides Issue Fields capability from repository metadata alone', () => {
  assert.equal(issueFieldCapability('Organization'), 'SUPPORTED')
  assert.equal(issueFieldCapability('User'), 'UNSUPPORTED')
  for (const ownerType of [undefined, null, 'Bot', '']) {
    assert.equal(issueFieldCapability(ownerType), 'UNKNOWN_OR_ERROR', String(ownerType))
  }
})

test('does not call the organization-only field endpoint on a User-owned repository', async () => {
  await withFakeApi(
    {
      repository: 'personal-owner/ark',
      ownerType: 'User',
      pull: pullPayload(33, { body: 'Fixes #34', labels: [] }),
      issues: { 34: issuePayload(34) },
      reviewRequests: reviewedRequests,
    },
    async ({ calls }) => {
      const pull = await pullRequestSnapshot(33)
      assert.ok(!calls.some((path) => path.includes('issue-field-values')), calls.join(' '))
      assert.equal(pull.issues.get(34).priorityCapability, 'UNSUPPORTED')
      assert.equal(pull.issues.get(34).priority, null)
      const errors = validatePullRequest(pull)
      assert.ok(errors.includes('PR 必须恰好有一个允许的 kind/*，当前为 0'))
      assert.ok(errors.includes('PR 必须至少有一个 area/*'))
      assert.ok(!errors.some((error) => error.includes('Priority')), errors.join(' '))
      const notices = pullRequestPolicyNotices(pull)
      assert.equal(notices.length, 1)
      assert.match(notices[0], /#34/u)
      assert.match(notices[0], /不构成 Priority 通过/u)
    },
  )
})

test('reads Issue Field values on an Organization-owned repository as before', async () => {
  await withFakeApi(
    {
      repository: 'team-owner/ark',
      ownerType: 'Organization',
      pull: pullPayload(33, { body: 'Fixes #34', labels: ['kind/feature', 'area/web', 'p0'] }),
      issues: { 34: issuePayload(34) },
      fields: { 34: [{ issue_field_name: 'Priority', single_select_option: { name: 'P0' } }] },
      reviewRequests: reviewedRequests,
    },
    async ({ calls }) => {
      const pull = await pullRequestSnapshot(33)
      assert.ok(calls.some((path) => path.includes('/issues/34/issue-field-values')))
      assert.equal(pull.issues.get(34).priority, 'P0')
      assert.equal(pull.issues.get(34).priorityCapability, 'SUPPORTED')
      assert.deepEqual(validatePullRequest(pull), [])
      assert.deepEqual(pullRequestPolicyNotices(pull), [])
      assert.ok(
        validatePullRequest({ ...pull, labels: ['kind/feature', 'area/web', 'p2'] }).includes(
          'PR Priority 应为 p0',
        ),
      )
    },
  )
})

test('distinguishes empty field values from an unsupported capability', async () => {
  await withFakeApi(
    {
      repository: 'team-owner/ark',
      ownerType: 'Organization',
      pull: pullPayload(33, { body: 'Fixes #34', labels: ['kind/feature', 'area/web', 'p2'] }),
      issues: { 34: issuePayload(34) },
      fields: { 34: [] },
      reviewRequests: reviewedRequests,
    },
    async () => {
      const pull = await pullRequestSnapshot(33)
      assert.equal(pull.issues.get(34).priorityCapability, 'EMPTY')
      assert.equal(pull.issues.get(34).priority, null)
      assert.ok(
        validatePullRequest(pull).includes(
          '有 Priority 的解决型 PR 要求每个被解决 Issue 都设置 Priority',
        ),
      )
      assert.deepEqual(pullRequestPolicyNotices(pull), [])
    },
  )
  await withFakeApi(
    {
      repository: 'personal-owner/ark',
      ownerType: 'User',
      pull: pullPayload(33, { body: 'Fixes #34', labels: ['kind/feature', 'area/web', 'p2'] }),
      issues: { 34: issuePayload(34) },
      reviewRequests: reviewedRequests,
    },
    async () => {
      const pull = await pullRequestSnapshot(33)
      assert.equal(pull.issues.get(34).priorityCapability, 'UNSUPPORTED')
      assert.ok(!validatePullRequest(pull).some((error) => error.includes('Priority')))
      assert.equal(pullRequestPolicyNotices(pull).length, 1)
    },
  )
})

test('keeps reference, pull-request, and label violations under an unsupported capability', async () => {
  const base = { repository: 'personal-owner/ark', ownerType: 'User', reviewRequests: reviewedRequests }
  await withFakeApi(
    { ...base, pull: pullPayload(33, { body: 'Related to #99', labels: ['kind/feature', 'area/web'] }), issues: {} },
    async () => {
      await assert.rejects(() => pullRequestSnapshot(33), /issues\/99: 404/u)
    },
  )
  await withFakeApi(
    {
      ...base,
      pull: pullPayload(33, { body: 'Related to #34', labels: ['kind/feature', 'area/web'] }),
      issues: { 34: issuePayload(34, { pull_request: { url: 'https://example.test/pr/34' } }) },
    },
    async () => {
      const pull = await pullRequestSnapshot(33)
      assert.equal(pull.issues.size, 0)
      assert.ok(validatePullRequest(pull).includes('PR 正文必须引用至少一个同仓库 Issue'))
    },
  )
  await withFakeApi(
    {
      ...base,
      pull: pullPayload(33, { body: 'Related to other-owner/other-repo#7', labels: ['kind/feature', 'area/web'] }),
      issues: {},
    },
    async () => {
      const pull = await pullRequestSnapshot(33)
      assert.ok(validatePullRequest(pull).includes('PR 正文必须引用至少一个同仓库 Issue'))
    },
  )
  await withFakeApi(
    {
      ...base,
      pull: pullPayload(33, { body: 'Related to #34', labels: ['kind/feature', 'area/web', 'doc'] }),
      issues: { 34: issuePayload(34) },
    },
    async () => {
      const pull = await pullRequestSnapshot(33)
      assert.ok(validatePullRequest(pull).includes('PR 含旧版标签：doc'))
    },
  )
})

test('fails closed on metadata and field API failures', async () => {
  const base = {
    repository: 'team-owner/ark',
    ownerType: 'Organization',
    pull: pullPayload(33, { body: 'Related to #34', labels: ['kind/feature', 'area/web'] }),
    issues: { 34: issuePayload(34) },
  }
  const cases = [
    ['404', { status: 404 }, /Issue Fields 返回 404/u],
    ['403', { status: 403 }, /403/u],
    ['429', { status: 429 }, /429/u],
    ['500', { status: 500 }, /500/u],
    ['invalid JSON', { status: 200, raw: 'not-json' }, /not valid JSON|Unexpected/u],
    ['network', { networkError: true }, /fields network down/u],
    ['non-array payload', { status: 200, body: { message: 'nope' } }, /不是数组/u],
  ]
  for (const [label, entry, pattern] of cases) {
    await withFakeApi({ ...base, fields: { 34: entry } }, async () => {
      await assert.rejects(() => pullRequestSnapshot(33), pattern, label)
    })
  }
  await withFakeApi({ ...base, ownerType: 'MISSING' }, async ({ calls }) => {
    await assert.rejects(() => pullRequestSnapshot(33), /owner\.type/u)
    assert.ok(!calls.some((path) => path.includes('issue-field-values')))
  })
  await withFakeApi({ ...base, metadataStatus: 500 }, async () => {
    await assert.rejects(() => pullRequestSnapshot(33), /500/u)
  })
  await withFakeApi({ ...base, metadataNetworkError: true }, async () => {
    await assert.rejects(() => pullRequestSnapshot(33), /metadata network down/u)
  })
})

test('keeps capability state per repository within one process', async () => {
  await withFakeApi(
    {
      repositories: { 'personal-owner/ark': 'User', 'team-owner/ark': 'Organization' },
      pull: pullPayload(33, { body: 'Related to #34', labels: ['kind/feature', 'area/web'] }),
      issues: { 34: issuePayload(34) },
      fields: { 34: [{ issue_field_name: 'Priority', single_select_option: { name: 'P1' } }] },
    },
    async ({ calls }) => {
      const personal = await pullRequestSnapshot(33)
      assert.equal(personal.issues.get(34).priorityCapability, 'UNSUPPORTED')
      process.env.GITHUB_REPOSITORY = 'team-owner/ark'
      const organization = await pullRequestSnapshot(33)
      assert.equal(organization.issues.get(34).priorityCapability, 'SUPPORTED')
      assert.equal(organization.issues.get(34).priority, 'P1')
      assert.equal(calls.filter((path) => path === '/repos/personal-owner/ark').length, 1)
      assert.equal(calls.filter((path) => path === '/repos/team-owner/ark').length, 1)
      const fieldCalls = calls.filter((path) => path.includes('issue-field-values'))
      assert.equal(fieldCalls.length, 1)
      assert.ok(fieldCalls[0].startsWith('/repos/team-owner/ark/'), fieldCalls.join(' '))
    },
  )
})

test('keeps Draft and pre-review boundaries while capability is unsupported', async () => {
  await withFakeApi(
    {
      repository: 'personal-owner/ark',
      ownerType: 'User',
      pull: pullPayload(33, { draft: true, body: '', labels: [] }),
      issues: {},
      reviewRequests: reviewedRequests,
    },
    async () => {
      const pull = await pullRequestSnapshot(33)
      assert.deepEqual(validatePullRequest(pull), [])
      assert.deepEqual(pullRequestPolicyNotices(pull), [])
    },
  )
  await withFakeApi(
    {
      repository: 'personal-owner/ark',
      ownerType: 'User',
      pull: pullPayload(33, { body: 'Related to #34', labels: [] }),
      issues: { 34: issuePayload(34) },
    },
    async ({ calls }) => {
      const pull = await pullRequestSnapshot(33)
      assert.equal(pull.issues.get(34).priorityCapability, 'UNSUPPORTED')
      assert.equal(pull.issues.get(34).priority, null)
      assert.ok(!calls.some((path) => path.includes('issue-field-values')), calls.join(' '))
      assert.equal(requiresPullRequestPolicy(pull), false)
      assert.deepEqual(validatePullRequest(pull), [])
      assert.deepEqual(pullRequestPolicyNotices(pull), [])
    },
  )
})
