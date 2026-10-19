import { describe, expect, it } from 'vitest'
import { invoiceOracle, paginationOracle, singleLineOracle } from './knowledge-task-oracles.ts'

const invoices = 'invoice_id,status,currency,amount\nI001,approved,USD,100.00\nI002,approved,EUR,80.25\nI003,pending,USD,999.99\nI004,approved,JPY,12000\nI005,approved,EUR,0.05\nI006,approved,USD,-2.50\nI007,approved,XYZ,10.00\nI008,approved,USD,12.345\nI009,approved,CNY,1.00\n'
const rates = 'currency,minor_units,usd_numerator,usd_denominator\nUSD,2,1,1\nEUR,2,11,10\nJPY,0,1,150\nCNY,2,1,7\n'
const correctInvoice = '{"approved_invoice_count":6,"pending_invoice_count":1,"rejected_row_ids":["I007","I008"],"usd_total_cents":26598,"usd_cents_by_currency":{"USD":9750,"EUR":8834,"JPY":8000,"CNY":14}}'
const terms = 'row_id,quantity,unit_value\nL01,17,29\nL02,23,-11\nL03,-7,31\n'

describe('fixed invoice content oracle', () => {
  it('recomputes the original task, including row rounding, pending, refunds, and rejected rows', () => {
    expect(invoiceOracle(invoices, rates, correctInvoice)).toMatchObject({ result: 'pass', checks: 10 })
    expect(invoiceOracle(invoices.replaceAll('\n', '\r\n'), rates.trimEnd(), JSON.stringify(JSON.parse(correctInvoice), null, 2)).result).toBe('pass')
  })
  it.each([
    ['final pane correct but progress prose exists', `Reading the files.\n${correctInvoice}`],
    ['code fence', `\u0060\u0060\u0060json\n${correctInvoice}\n\u0060\u0060\u0060`],
    ['curly quotes', correctInvoice.replaceAll('"', '“')],
    ['wrong total', correctInvoice.replace('26598', '26599')],
    ['extra key', correctInvoice.replace('{', '{"success":true,')],
    ['duplicate top key', correctInvoice.replace('{', '{"approved_invoice_count":6,')],
    ['duplicate nested key', correctInvoice.replace('"USD":9750', '"USD":9750,"USD":9750')],
    ['trailing JSON', `${correctInvoice}\n{}`],
    ['no answer', ''],
  ])('rejects %s', (_name, output) => { expect(invoiceOracle(invoices, rates, output).result).toBe('fail') })
  it('rounds half cents away from zero on each row and preserves negative/zero amounts', () => {
    const source = 'invoice_id,status,currency,amount\nA,approved,USD,0.005\nB,approved,USD,-0.005\nC,approved,USD,0\nD,approved,USD,-0\nE,pending,unknown,not-a-number\nF,approved,USD,not-a-number\n'
    const answer = '{"approved_invoice_count":4,"pending_invoice_count":1,"rejected_row_ids":["F"],"usd_total_cents":0,"usd_cents_by_currency":{"USD":0}}'
    expect(invoiceOracle(source, rates.replace('USD,2,', 'USD,3,'), answer).result).toBe('pass')
    const half = 'invoice_id,status,currency,amount\nA,approved,USD,0.005\nB,approved,USD,0.005\n'
    const result = JSON.parse(invoiceOracle(half, rates.replace('USD,2,', 'USD,3,'), '{}').expected) as { usd_total_cents: number }
    expect(result.usd_total_cents).toBe(2)
  })
  it.each([
    ['duplicate currency', `${rates}USD,2,1,1\n`],
    ['unsupported currency code', rates.replace('USD,2,', 'usd,2,')],
    ['negative minor units', rates.replace('USD,2,', 'USD,-1,')],
    ['oversized minor units', rates.replace('USD,2,', 'USD,19,')],
    ['zero rate', rates.replace('USD,2,1,1', 'USD,2,0,1')],
    ['zero divisor', rates.replace('USD,2,1,1', 'USD,2,1,0')],
    ['noncanonical integer', rates.replace('USD,2,1,1', 'USD,02,1,1')],
  ])('blocks uncovered rate material: %s', (_name, source) => { expect(() => invoiceOracle(invoices, source, correctInvoice)).toThrow() })
  it.each([
    ['duplicate id', invoices.replace('I002', 'I001')],
    ['unsupported id', invoices.replace('I001', 'I:001')],
    ['unknown status', invoices.replace('pending', 'cancelled')],
    ['unsafe JSON result', invoices.replace('100.00', '99999999999999999999.00')],
  ])('blocks uncovered invoice material: %s', (_name, source) => { expect(() => invoiceOracle(source, rates, correctInvoice)).toThrow() })
})

describe('complete single-line integer oracle', () => {
  it('recomputes signed integers, large integers and a valid empty dataset', () => {
    expect(singleLineOracle(terms, 'SUM=23').result).toBe('pass')
    expect(singleLineOracle(terms, 'SUM=23\n').result).toBe('pass')
    expect(singleLineOracle('row_id,quantity,unit_value\nA,9007199254740993,9\n', 'SUM=81064793292668937').result).toBe('pass')
    expect(singleLineOracle('row_id,quantity,unit_value\n', 'SUM=0').result).toBe('pass')
  })
  it.each(['SUM=023', 'SUM=+23', 'SUM=2.3e1', 'SUM=２３', 'SUM=23\n\n', 'SUM=23\r\n', ' SUM=23', 'SUM=23 ', 'Computing.\nSUM=23', 'SUM=-0'])('rejects the whole output %j', (output) => {
    expect(singleLineOracle(terms, output).result).toBe('fail')
  })
  it.each([
    'row_id,quantity,unit_value\nA,+1,2', 'row_id,quantity,unit_value\nA,01,2', 'row_id,quantity,unit_value\nA,-0,2',
    'row_id,quantity,unit_value\nA,1.5,2', 'row_id,quantity,unit_value\nA,1,2\nA,3,4',
    'row_id,quantity,unit_value\n"A",1,2', 'row_id,quantity,unit_value\rA,1,2', 'wrong,header',
    'row_id,quantity,unit_value\nA,1', 'row_id,quantity,unit_value\nA,,2', 'row_id,quantity,unit_value\nA,1,2,extra',
    `row_id,quantity,unit_value\n${'A'.repeat(257)},1,2`, 'x'.repeat(2 * 1024 * 1024 + 1),
  ])('blocks unsupported CSV/integer input', (source) => { expect(() => singleLineOracle(source, 'SUM=0')).toThrow() })
})

function repaired(items: readonly object[], page: number, pageSize: number) {
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1) throw new RangeError('invalid parameter')
  const start = (page - 1) * pageSize
  return { items: items.slice(start, start + pageSize), page, pageSize, totalItems: items.length,
    totalPages: Math.ceil(items.length / pageSize) }
}

describe('independent pagination behavior oracle', () => {
  it('checks every registered behavior, including partial pages and safe-integer extremes', () => {
    expect(paginationOracle(repaired)).toMatchObject({ result: 'pass', checks: 853 })
  })
  it('detects the original full-page endpoint defect without claiming every page is broken', () => {
    expect(paginationOracle((items: object[], page: number, size: number) => ({ ...repaired(items, page, size), items: items.slice((page - 1) * size, page * size - 1) })).result).toBe('fail')
  })
  it('detects a preserved-value clone that loses element identity', () => {
    expect(paginationOracle((items: object[], page: number, size: number) => ({ ...repaired(items, page, size), items: repaired(items, page, size).items.map(item => ({ ...item })) })).result).toBe('fail')
  })
  it('detects a wrong exception and a non-Error throw', () => {
    expect(paginationOracle(() => { throw new TypeError('wrong') }).result).toBe('fail')
    expect(paginationOracle(() => { throw 'non-error' })).toMatchObject({ result: 'fail', detail: 'non-error' })
  })
  it('blocks an absent export', () => { expect(() => paginationOracle(null)).toThrow(/export/u) })
})
