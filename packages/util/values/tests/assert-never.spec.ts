import { describe, expect, it } from 'vitest'
import { assertNever } from '../src/index.ts'

/**
 * One closed frame union a decoder trusts: the `kind` discriminant is the only
 * variant selector, so a switch handling every member has `never` in its default branch.
 */
type FrameKind = { readonly kind: 'message' } | { readonly kind: 'notice' }

/** One closed scalar union whose discriminant is the runtime typeof. */
type WireScalar = string | number

/** Exhaustive consumer that names its switch site in the failure message. */
function frameLabel(frame: FrameKind): string {
  switch (frame.kind) {
    case 'message':
      return 'message'
    case 'notice':
      return 'notice'
    default:
      return assertNever(frame, 'frame kind')
  }
}

/** Exhaustive consumer without a switch-site label. */
function encodeScalar(value: WireScalar): string {
  switch (typeof value) {
    case 'string':
      return value
    case 'number':
      return String(value)
    default:
      return assertNever(value)
  }
}

/**
 * Rewrite one accepted property with a value outside its declared type — the
 * runtime escape these exhaustive consumers exist to report. defineProperty is
 * deliberate: the escape happens in the value, not in a cast.
 */
function escapeProperty(holder: object, key: string, value: unknown): void {
  Object.defineProperty(holder, key, { value, enumerable: true, configurable: true, writable: true })
}

describe('assertNever', () => {
  it('takes a never value and returns never so an unhandled variant fails compilation', () => {
    // Compile-time pins: the parameter must accept only `never`, and the return
    // type must be `never` — an unhandled variant then fails compilation.
    type Parameter = Parameters<typeof assertNever>[0]
    type Result = ReturnType<typeof assertNever>
    const parameterProbe: Parameter = undefined as never
    const resultProbe: Result = parameterProbe
    expect([typeof parameterProbe, typeof resultProbe]).toEqual(['undefined', 'undefined'])
  })

  it('reports a variant that escaped its closed union with the switch site and JSON rendering', () => {
    const frame: FrameKind = { kind: 'message' }
    escapeProperty(frame, 'kind', 'rogue')

    expect(() => frameLabel(frame)).toThrow(new Error('unreachable variant in frame kind: {"kind":"rogue"}'))
  })

  it('omits the switch site and renders with String() when JSON.stringify cannot', () => {
    const holder: { scalar: WireScalar } = { scalar: 'value' }
    escapeProperty(holder, 'scalar', undefined)

    expect(() => encodeScalar(holder.scalar)).toThrow(new Error('unreachable variant: undefined'))
  })

  it('still encodes every declared variant without reaching the guard', () => {
    expect(frameLabel({ kind: 'message' })).toBe('message')
    expect(frameLabel({ kind: 'notice' })).toBe('notice')
    expect(encodeScalar('text')).toBe('text')
    expect(encodeScalar(7)).toBe('7')
  })
})
