/** Validate the fixed schema-2 ledger without changing it. */
export function validateKnowledgeCostLedger(ledger: unknown): boolean

/** Read existing capacity, including pending reserves, for one explicit output cap. */
export function knowledgeCostAdmissionCapacity(ledger: unknown, maxTokens: number): Readonly<{
  remainingRequests: number
  remainingBudgetMicroCny: number
  perRequestReserveMicroCny: number
}>
