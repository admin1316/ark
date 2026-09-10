import { describe, expect, it } from 'vitest'
import { CordisDynamicPluginId } from '../src/index.ts'
import { AGENT_A, AGENT_B, REVERSE_TOOL_CODE, setup } from './helpers.ts'

const NOOP = 'return { name: "noop", apply() {} }'

describe('Host-only dynamic Cordis lifecycle', () => {
  it('requires Host source and records no browser activation state', async () => {
    const { runner } = await setup()
    expect(() => runner.define({
      sessionId: AGENT_A.id,
      plugin: { kind: 'new', idPrefix: 'host' },
      name: 'empty',
      purpose: 'invalid',
      code: { host: '' },
    })).toThrow('code.host')

    const defined = runner.define({
      sessionId: AGENT_A.id,
      plugin: { kind: 'new', idPrefix: 'host' },
      name: 'noop',
      purpose: 'host fixture',
      code: { host: NOOP },
    })
    await expect(runner.run(AGENT_A, defined.pluginId, defined.packageId, 'run'))
      .resolves.toMatchObject({ ok: true, status: 'running', currentPackageId: defined.packageId })
    expect(runner.inventory()[0]?.packages[0]).toEqual({
      packageId: defined.packageId,
      name: 'noop',
      purpose: 'host fixture',
    })
  })

  it('updates immutable versions and enforces Session ownership', async () => {
    const { runner } = await setup()
    const first = runner.define({
      sessionId: AGENT_A.id,
      plugin: { kind: 'new', idPrefix: 'host' },
      name: 'first',
      purpose: 'first',
      code: { host: NOOP },
    })
    await runner.run(AGENT_A, first.pluginId, first.packageId, 'run')
    const second = runner.define({
      sessionId: AGENT_A.id,
      plugin: { kind: 'existing', pluginId: first.pluginId },
      name: 'second',
      purpose: 'second',
      code: { host: REVERSE_TOOL_CODE },
    })
    await expect(runner.run(AGENT_A, first.pluginId, second.packageId, 'update'))
      .resolves.toMatchObject({ ok: true, currentPackageId: second.packageId })
    await expect(runner.run(AGENT_B, first.pluginId, second.packageId, 'run'))
      .resolves.toMatchObject({ ok: false, reason: 'plugin-missing' })
    expect(runner.inspectPackage(AGENT_A, first.pluginId, second.packageId).code).toEqual({ host: REVERSE_TOOL_CODE })
  })

  it('stops to quiescence and undefines idempotently by ownership', async () => {
    const { runner } = await setup()
    const defined = runner.define({
      sessionId: AGENT_A.id,
      plugin: { kind: 'new', idPrefix: 'host' },
      name: 'noop',
      purpose: 'host fixture',
      code: { host: NOOP },
    })
    await runner.run(AGENT_A, defined.pluginId, defined.packageId, 'run')
    await expect(runner.stop(AGENT_A, defined.pluginId)).resolves.toEqual({ ok: true })
    await expect(runner.stop(AGENT_A, defined.pluginId)).resolves.toMatchObject({ ok: false, reason: 'not-running' })
    await expect(runner.undefine(AGENT_A, defined.pluginId)).resolves.toEqual({ ok: true, wasRunning: false })
    await expect(runner.undefine(AGENT_A, CordisDynamicPluginId('missing-1')))
      .resolves.toMatchObject({ ok: false, reason: 'plugin-missing' })
  })
})
