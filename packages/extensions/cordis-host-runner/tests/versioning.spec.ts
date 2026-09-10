import { describe, expect, it } from 'vitest'
import { AGENT_A, setup } from './helpers.ts'

const HOST = 'return { apply() {} }'

describe('dynamic Plugin versions', () => {
  it('keeps currentPackageId when an update fails and clears nextPackageId after rollback', async () => {
    const { runner } = await setup()
    const first = runner.define({
      sessionId: AGENT_A.id,
      plugin: { kind: 'new', idPrefix: 'clock' },
      name: 'clock v1',
      purpose: 'show time',
      code: { host: HOST },
    })
    await expect(runner.run(AGENT_A, first.pluginId, first.packageId, 'run')).resolves.toMatchObject({ ok: true })

    const second = runner.define({
      sessionId: AGENT_A.id,
      plugin: { kind: 'existing', pluginId: first.pluginId },
      name: 'clock v2',
      purpose: 'show time',
      code: { host: 'throw new Error("broken update")' },
    })
    await expect(runner.run(AGENT_A, first.pluginId, second.packageId, 'update'))
      .resolves.toMatchObject({ ok: false, reason: 'host-half-failed' })
    expect(runner.inventory()[0]).toMatchObject({
      currentPackageId: first.packageId,
      nextPackageId: second.packageId,
    })
    expect(runner.inventory()[0]?.activeRun).toBeUndefined()

    await expect(runner.run(AGENT_A, first.pluginId, first.packageId, 'run')).resolves.toMatchObject({ ok: true })
    expect(runner.inventory()[0]).toMatchObject({
      currentPackageId: first.packageId,
      activeRun: { packageId: first.packageId },
    })
    expect(runner.inventory()[0]?.nextPackageId).toBeUndefined()
  })

  it('refuses an activation whose signal was already aborted and leaves no activation behind', async () => {
    const { runner } = await setup()
    const defined = runner.define({
      sessionId: AGENT_A.id,
      plugin: { kind: 'new', idPrefix: 'clock' },
      name: 'clock',
      purpose: 'show time',
      code: { host: HOST },
    })
    const controller = new AbortController()
    controller.abort()
    await expect(runner.run(AGENT_A, defined.pluginId, defined.packageId, 'run', controller.signal))
      .resolves.toMatchObject({
        ok: false,
        reason: 'host-half-failed',
        message: expect.stringContaining('was cancelled'),
      })

    // The refusal must tear nothing down and record no attempt: the package is
    // still versionless, with no active run and no pending next version.
    const refused = runner.inventory()
    expect(refused).toHaveLength(1)
    expect(refused[0]).not.toHaveProperty('currentPackageId')
    expect(refused[0]).not.toHaveProperty('nextPackageId')
    expect(refused[0]).not.toHaveProperty('activeRun')
    expect(refused[0]).not.toHaveProperty('latestRun')

    // And the same package still starts normally afterwards.
    const started = await runner.run(AGENT_A, defined.pluginId, defined.packageId, 'run')
    expect(started).toMatchObject({ ok: true, status: 'running', currentPackageId: defined.packageId })
    if (!started.ok) throw new Error(started.message)
    expect(runner.inventory()[0]?.activeRun).toEqual({
      packageId: defined.packageId,
      pluginRunId: started.pluginRunId,
    })
  })

  it('does not stop an existing Host run when a later activation attempt is refused', async () => {
    const { runner } = await setup()
    const defined = runner.define({
      sessionId: AGENT_A.id,
      plugin: { kind: 'new', idPrefix: 'panel' },
      name: 'panel',
      purpose: 'render a panel',
      code: { host: HOST },
    })
    const first = await runner.run(AGENT_A, defined.pluginId, defined.packageId, 'run')
    expect(first).toMatchObject({ ok: true, status: 'running' })
    if (!first.ok) throw new Error(first.message)

    // Re-running the live package observes the existing activation instead of
    // restarting it, so the run identity a page attached to stays valid.
    await expect(runner.run(AGENT_A, defined.pluginId, defined.packageId, 'run'))
      .resolves.toMatchObject({ ok: true, pluginRunId: first.pluginRunId, status: 'running' })

    // A version update cancelled before it starts must not tear that run down:
    // the abort is refused before the current run is retracted.
    const second = runner.define({
      sessionId: AGENT_A.id,
      plugin: { kind: 'existing', pluginId: defined.pluginId },
      name: 'panel v2',
      purpose: 'render a panel',
      code: { host: HOST },
    })
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(runner.run(AGENT_A, defined.pluginId, second.packageId, 'update', cancelled.signal))
      .resolves.toMatchObject({ ok: false, reason: 'host-half-failed' })

    expect(runner.inventory()[0]?.activeRun).toEqual({
      packageId: defined.packageId,
      pluginRunId: first.pluginRunId,
    })
    expect(runner.inventory()[0]?.currentPackageId).toBe(defined.packageId)
  })
})
