/** Fixed pilot oracles; unsupported source material throws instead of receiving a passing verdict. */

import assert from 'node:assert/strict'
import { canonicalJson } from '../../packages/host/knowledge-wiki/src/verifier.ts'

/** An independently computed task verdict, without any learning or authority claim. */
export interface TaskOracleResult {
  readonly result: 'pass' | 'fail'
  readonly checks: number
  readonly expected: string
  readonly detail: string
}

function csv(text: string, header: readonly string[]): string[][] {
  // The registered pilot uses unquoted CSV. Broader CSV is an uncovered task.
  if (Buffer.byteLength(text) > 2 * 1024 * 1024 || text.includes('"') || /\r(?!\n)/u.test(text)) {
    throw new Error('pilot source must be bounded unquoted CSV')
  }
  const lines = text.replace(/\r\n/gu, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.shift() !== header.join(',')) throw new Error('pilot CSV header differs from the registered task')
  const rows = lines.map(line => line.split(','))
  if (rows.some(row => row.length !== header.length || row.some(cell => cell === '' || cell.length > 256))) {
    throw new Error('pilot CSV row is missing, oversized, or has extra cells')
  }
  return rows
}

function uniqueId(value: string, seen: Set<string>): void {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || seen.has(value)) throw new Error('pilot source identifier is unsupported or duplicated')
  seen.add(value)
}

function integer(value: string): bigint {
  if (!/^(?:0|-?[1-9][0-9]*)$/u.test(value)) throw new Error('pilot source integer must be canonical decimal')
  return BigInt(value)
}

function safeNumber(value: bigint): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result)) throw new Error('invoice result is outside the JSON safe-integer pilot range')
  return result
}

function roundAway(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n
  const magnitude = negative ? -numerator : numerator
  const quotient = magnitude / denominator
  const rounded = quotient + (2n * (magnitude % denominator) >= denominator ? 1n : 0n)
  return negative ? -rounded : rounded
}

/**
 * Recompute the registered invoice task using integer rational arithmetic and the whole assistant output.
 * @param invoices - Exact, frozen unquoted invoice CSV bytes decoded as UTF-8.
 * @param rates - Exact, frozen rate CSV bytes decoded as UTF-8.
 * @param output - Every visible assistant text block in the task's complete turn, in order.
 * @returns A pass only for one JSON object with precisely the computed values; valid formatting may vary.
 * @throws When source material is malformed or outside the fixed pilot's coverage.
 */
export function invoiceOracle(invoices: string, rates: string, output: string): TaskOracleResult {
  const rateMap = new Map<string, { minor: number; numerator: bigint; denominator: bigint }>()
  const currencies = new Set<string>()
  for (const [currency, minor, numerator, denominator] of csv(rates, ['currency', 'minor_units', 'usd_numerator', 'usd_denominator']) as [string, string, string, string][]) {
    uniqueId(currency, currencies)
    if (!/^[A-Z]{3}$/u.test(currency)) throw new Error('invoice currency must be a three-letter code')
    const minorUnits = integer(minor)
    const top = integer(numerator)
    const bottom = integer(denominator)
    if (minorUnits < 0n || minorUnits > 18n || top <= 0n || bottom <= 0n) throw new Error('invoice rate is outside the registered positive rational range')
    rateMap.set(currency, { minor: Number(minorUnits), numerator: top, denominator: bottom })
  }
  let approved = 0
  let pending = 0
  const rejected: string[] = []
  const byCurrency = new Map<string, bigint>()
  const ids = new Set<string>()
  const rows = csv(invoices, ['invoice_id', 'status', 'currency', 'amount']) as [string, string, string, string][]
  for (const [id, status, currency, amount] of rows) {
    uniqueId(id, ids)
    if (status === 'pending') { pending += 1; continue }
    if (status !== 'approved') throw new Error('invoice status is outside the registered task')
    const rate = rateMap.get(currency)
    const match = /^(-?)([0-9]+)(?:\.([0-9]+))?$/u.exec(amount)
    if (rate === undefined || match === null || (match[3]?.length ?? 0) > rate.minor) { rejected.push(id); continue }
    const fraction = match[3] ?? ''
    const units = BigInt(`${match[2]}${fraction}`) * (match[1] === '-' ? -1n : 1n)
    const cents = roundAway(units * rate.numerator * 100n, 10n ** BigInt(fraction.length) * rate.denominator)
    byCurrency.set(currency, (byCurrency.get(currency) ?? 0n) + cents)
    approved += 1
  }
  const value = {
    approved_invoice_count: approved,
    pending_invoice_count: pending,
    rejected_row_ids: rejected.sort(),
    usd_total_cents: safeNumber([...byCurrency.values()].reduce((sum, cents) => sum + cents, 0n)),
    usd_cents_by_currency: Object.fromEntries([...byCurrency].map(([currency, cents]) => [currency, safeNumber(cents)])),
  }
  const expected = canonicalJson(value)
  let pass = false
  try {
    const parsed: unknown = JSON.parse(output)
    // JSON.parse discards duplicate keys. Tokenize whole JSON strings before counting keys.
    const keys = [...output.matchAll(/"(?:[^"\\]|\\.)*"/gu)]
      .filter(token => /^\s*:/u.test(output.slice(token.index + token[0].length)))
      .map(token => JSON.parse(token[0]) as string)
    pass = new Set(keys).size === keys.length && canonicalJson(parsed) === expected
  } catch {
    // Invalid whole-output JSON is a task failure, not an unsupported source task.
  }
  return { result: pass ? 'pass' : 'fail', checks: rows.length + 1, expected, detail: 'Exact per-row rational rounding and complete-output JSON' }
}

/**
 * Recompute the single-line integer task without floating-point arithmetic.
 * @param source - Exact frozen unquoted integer-terms CSV.
 * @param output - Complete ordered assistant text for the turn, including any progress prose.
 * @returns A pass only for the exact canonical SUM line, optionally followed by one LF.
 * @throws When the source does not satisfy the fixed pilot CSV/integer contract.
 */
export function singleLineOracle(source: string, output: string): TaskOracleResult {
  const rows = csv(source, ['row_id', 'quantity', 'unit_value']) as [string, string, string][]
  const ids = new Set<string>()
  let sum = 0n
  for (const [id, quantity, unit] of rows) {
    uniqueId(id, ids)
    sum += integer(quantity) * integer(unit)
  }
  const expected = `SUM=${String(sum)}`
  return { result: output === expected || output === `${expected}\n` ? 'pass' : 'fail', checks: rows.length + 1, expected, detail: 'Exact integer sum and one complete output line' }
}

type Pagination = (items: readonly object[], page: unknown, pageSize: unknown) => unknown

/**
 * Check an already confined, frozen pagination module against an independent indexed-selection oracle.
 * @param paginate - Export from the registered code snapshot; callers must not import arbitrary code into a signer.
 * @returns A verdict for full/partial/empty/out-of-range pages, input ownership, and invalid parameters.
 * @throws When the supplied export is absent; module execution/confinement belongs to the fixed external runner.
 */
export function paginationOracle(paginate: unknown): TaskOracleResult {
  if (typeof paginate !== 'function') throw new Error('registered pagination module has no paginate export')
  const execute = paginate as Pagination
  let checks = 0
  try {
    for (let count = 0; count <= 37; count += 1) {
      const items = Object.freeze(Array.from({ length: count }, (_, id) => Object.freeze({ id })))
      for (const size of [1, 2, 3, 7, 40]) {
        const totalPages = Math.ceil(count / size)
        for (const page of new Set([1, 2, Math.max(1, totalPages), totalPages + 1, Number.MAX_SAFE_INTEGER])) {
          const start = (page - 1) * size
          const expectedItems = items.filter((_, index) => index >= start && index < start + size)
          const result = execute(items, page, size) as { items: object[] }
          checks += 1
          assert.deepEqual(result, { items: expectedItems, page, pageSize: size, totalItems: count, totalPages })
          assert.notEqual(result.items, items)
          for (const [index, item] of expectedItems.entries()) assert.equal(result.items[index], item)
        }
      }
    }
    for (const invalid of [undefined, null, true, false, '1', '', 0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      checks += 2
      assert.throws(() => execute([{}], invalid, 2), RangeError)
      assert.throws(() => execute([{}], 1, invalid), RangeError)
    }
    return { result: 'pass', checks, expected: 'pagination-contract-v1', detail: 'Independent index selection, unchanged inputs, and positive safe integers' }
  } catch (error: unknown) {
    return { result: 'fail', checks, expected: 'pagination-contract-v1', detail: error instanceof Error ? error.message : String(error) }
  }
}
