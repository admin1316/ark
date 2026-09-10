/** Zero-cost Team identity constructors; validation belongs to the input owner. */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TeamId as TeamIdBrand, TeamTaskId as TeamTaskIdBrand, TeamMessageId as TeamMessageIdBrand } from './types.ts'

/** Lead-session identity shared by the Team log and its callers. */
export type TeamId = TeamIdBrand
/** Stable task identity within one Team. */
export type TeamTaskId = TeamTaskIdBrand
/** Stable identity of a durable Team message. */
export type TeamMessageId = TeamMessageIdBrand

/**
 * Brand the root Session identity as its implicit Team identity.
 * @param id - root Session identity.
 * @returns the unchanged string with the Team brand.
 */
export function TeamId(id: SessionId | string): TeamIdBrand { return id as TeamIdBrand }

/**
 * Brand a validated Team-local task identity.
 * @param id - task identity.
 * @returns the unchanged string with the task brand.
 */
export function TeamTaskId(id: string): TeamTaskIdBrand { return id as TeamTaskIdBrand }

/**
 * Brand a generated durable message identity.
 * @param id - message identity.
 * @returns the unchanged string with the message brand.
 */
export function TeamMessageId(id: string): TeamMessageIdBrand { return id as TeamMessageIdBrand }
