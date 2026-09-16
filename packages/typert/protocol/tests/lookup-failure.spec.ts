import { describe, expect, it } from 'vitest'
import {
  isRemoteFailurePayload,
  isTypertRemoteFailure,
  TypertLookupFailure,
} from '@deepseek-ai/dsh-typert-protocol'

describe('TypertLookupFailure public identity', () => {
  it('preserves the adapter failure identity and mirrors its string code and details', () => {
    const failure = { code: 'agent-busy', message: 'owned by another caller', details: { agent: 'a1' } }
    const error = new TypertLookupFailure(failure)

    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(TypertLookupFailure)
    expect(error.name).toBe('TypertLookupFailure')
    expect(error.message).toBe('Typert lookup policy rejected the requested identity')
    expect(error.failure).toBe(failure)
    expect(error.code).toBe('agent-busy')
    expect(error.details).toBe(failure.details)
    expect(isRemoteFailurePayload(error.failure)).toBe(true)
    expect(isTypertRemoteFailure(error)).toBe(true)
  })

  it('leaves code and details undefined when the adapter rejects with a non-object failure', () => {
    const error = new TypertLookupFailure('lookup policy rejected')

    expect(error).toBeInstanceOf(TypertLookupFailure)
    expect(error.failure).toBe('lookup policy rejected')
    expect(error.code).toBeUndefined()
    expect(error.details).toBeUndefined()
    expect(error.message).toBe('Typert lookup policy rejected the requested identity')
    expect(isTypertRemoteFailure(error)).toBe(false)
  })

  it('leaves code undefined when the failure record carries no string code', () => {
    const withoutCode = new TypertLookupFailure({ message: 'owned by another caller' })
    expect(withoutCode.code).toBeUndefined()
    expect(withoutCode.details).toBeUndefined()

    const nonStringCode = new TypertLookupFailure({ code: 7, message: 'owned by another caller' })
    expect(nonStringCode.code).toBeUndefined()
    expect(nonStringCode.details).toBeUndefined()
    expect(isTypertRemoteFailure(nonStringCode)).toBe(false)
  })

  it('mirrors a string code without inventing details the record does not carry', () => {
    const failure = { code: 'lookup-denied', message: 'identity not visible to this caller' }
    const error = new TypertLookupFailure(failure)

    expect(error.failure).toBe(failure)
    expect(error.code).toBe('lookup-denied')
    expect(error.details).toBeUndefined()
    // A complete payload needs object details, so this rejection stays unclassified.
    expect(isRemoteFailurePayload(error.failure)).toBe(false)
    expect(isTypertRemoteFailure(error)).toBe(false)
  })

  it('classifies a wrapped failure only once code, message, and details are complete', () => {
    const partial = new TypertLookupFailure({ code: 'lookup-denied', message: 'missing details' })
    expect(isTypertRemoteFailure(partial)).toBe(false)

    const complete = new TypertLookupFailure({ code: 'lookup-denied', message: 'complete', details: {} })
    expect(isTypertRemoteFailure(complete)).toBe(true)
  })
})
