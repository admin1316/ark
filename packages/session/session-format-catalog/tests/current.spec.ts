import { describe, expect, it } from 'vitest'
import { sessionFormatCatalog } from '../src/index.ts'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionFormatArtifact, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'
import {
  validateInstalledCurrentSessionArtifact,
  validateInstalledCurrentSessionHeader,
} from '../src/current.ts'

const currentHeader: SessionFormatHeader = {
  version: SESSION_FORMAT_VERSION,
  id: 'installed-current',
  createdAt: 1,
  isSeeded: false,
  delegationDepth: 0,
}

describe('installed current Session restoration', () => {
  it('distinguishes an unsupported future header from malformed offline input', () => {
    expect(sessionFormatCatalog.readHeader({ type: 'session', version: 4 })).toMatchObject({
      status: 'unsupported', storedVersion: 4, targetVersion: 3,
    })
    expect(sessionFormatCatalog.readHeader({ type: 'session', version: 'broken' })).toMatchObject({
      status: 'malformed', targetVersion: 3,
    })
    expect(sessionFormatCatalog.readHeader({ type: 'session', version: 3, id: 12 })).toMatchObject({
      status: 'malformed', targetVersion: 3,
    })
  })

  it.each([0, 1, 2, 3])('classifies readable v%i offline while refusing its v3 result in the installed runtime', (version) => {
    const header = { type: 'session', version, id: 'offline-admission', createdAt: 1, delegationDepth: 0,
      ...(version >= 2 ? { isSeeded: false } : {}) }
    expect(sessionFormatCatalog.readHeader(header).status).toBe(version === 3 ? 'current' : 'migration-required')
    const restore = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })
    expect(() => restore.finish()).toThrow(/installed Session format is v0, got v3/)
  })

  it('rejects version skew before entering current Session validation', () => {
    const foreignVersion = SESSION_FORMAT_VERSION + 1
    const refusal = `installed Session format is v${SESSION_FORMAT_VERSION}, got v${foreignVersion}`
    expect(() => { validateInstalledCurrentSessionHeader({ ...currentHeader, version: foreignVersion }) })
      .toThrow(refusal)
    const artifact: SessionFormatArtifact = {
      header: { ...currentHeader, version: foreignVersion },
      inheritedEventCount: 0,
      events: [],
    }
    expect(() => { validateInstalledCurrentSessionArtifact(artifact) })
      .toThrow(refusal)
  })

  it('preserves installed request-header admission without asserting v3 starts-series semantics', () => {
    const artifact = (reason: string): SessionFormatArtifact => ({
      header: { ...currentHeader },
      inheritedEventCount: 0,
      events: [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        {
          type: 'request/header', seq: 1, time: 2,
          data: {
            header: { config: { provider: 'mock', model: 'mock' } },
            reason,
          },
        },
      ],
    })

    expect(() => { validateInstalledCurrentSessionArtifact(artifact('fallback')) })
      .toThrow(/request\/header.*reason/)
    for (const reason of ['initial', 'resume', 'change']) {
      expect(() => { validateInstalledCurrentSessionArtifact(artifact(reason)) }).not.toThrow()
    }
    const malformed = artifact('initial')
    const invalid: SessionFormatArtifact = {
      ...malformed,
      events: [{ type: 'request/header', seq: 0, time: 1, data: { header: { config: {} }, reason: 'initial' } }],
    }
    expect(() => { validateInstalledCurrentSessionArtifact(invalid) }).toThrow(/lacks provider\/model/)
    expect(() => {
      validateInstalledCurrentSessionArtifact({
        ...invalid,
        events: [{ type: 'request/header-delta', seq: 0, time: 1, data: {} }],
      })
    }).toThrow(/unsupported legacy request\/header-delta/)
  })

  it('accepts an unseeded current header and empty artifact', () => {
    expect(() => { validateInstalledCurrentSessionHeader({ ...currentHeader }) }).not.toThrow()
    expect(() => {
      validateInstalledCurrentSessionArtifact({
        header: { ...currentHeader }, inheritedEventCount: 0, events: [],
      })
    }).not.toThrow()
  })

  it.each([-1, -0, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 2])(
    'rejects an invalid inherited event count %s before restoration', (inheritedEventCount) => {
      expect(() => {
        validateInstalledCurrentSessionArtifact({
          header: { ...currentHeader }, inheritedEventCount,
          events: [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }],
        })
      }).toThrow(/inherited event count must be/)
    },
  )

  it('refuses a nonzero cut instead of dropping inherited history metadata', () => {
    expect(() => {
      validateInstalledCurrentSessionArtifact({
        header: { ...currentHeader }, inheritedEventCount: 1,
        events: [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }],
      })
    }).toThrow(/does not support a nonzero catalog inherited event count/)
  })

  it('refuses a seeded catalog header even when its inherited prefix is empty', () => {
    const header = { ...currentHeader, isSeeded: true }
    expect(() => { validateInstalledCurrentSessionHeader(header) }).toThrow(/does not support inherited catalog seeds/)
    expect(() => {
      validateInstalledCurrentSessionArtifact({
        header, inheritedEventCount: 0, events: [],
      })
    }).toThrow(/does not support inherited catalog seeds/)
  })
})
