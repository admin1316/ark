/**
 * Brand the root Session identity as its implicit Team identity.
 * @param id - root Session identity.
 * @returns the unchanged string with the Team brand.
 */
export function TeamId(id) { return id; }
/**
 * Brand a validated Team-local task identity.
 * @param id - task identity.
 * @returns the unchanged string with the task brand.
 */
export function TeamTaskId(id) { return id; }
/**
 * Brand a generated durable message identity.
 * @param id - message identity.
 * @returns the unchanged string with the message brand.
 */
export function TeamMessageId(id) { return id; }
//# sourceMappingURL=brand.js.map