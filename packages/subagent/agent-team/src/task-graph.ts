/** Complete dependency validation for active Team tasks. */
import type { TeamTaskId, TeamTaskSnapshot } from './types.ts'

/** Dependency failures mapped to stable Team command errors. */
export type TeamTaskGraphViolation = 'missing' | 'duplicate' | 'cycle'

/** Task dependency error retained for command error mapping. */
export class TeamTaskGraphError extends Error {
  constructor(message: string, readonly violation: TeamTaskGraphViolation) {
    super(message)
    this.name = 'TeamTaskGraphError'
  }
}

/**
 * Validate the entire active task graph with one candidate replacement.
 * @param current - task snapshots before the proposed event.
 * @param candidate - new or next-revision task snapshot.
 * @throws for missing, duplicate, self-referential, or cyclic dependencies.
 */
export function assertTaskGraphCandidate(current: ReadonlyMap<TeamTaskId, TeamTaskSnapshot>, candidate: TeamTaskSnapshot): void {
  const tasks = new Map(current)
  tasks.set(candidate.id, candidate)
  for (const task of tasks.values()) {
    if (task.status === 'deleted') continue
    const seen = new Set<TeamTaskId>()
    for (const blockerId of task.blockedBy) {
      if (blockerId === task.id) throw new TeamTaskGraphError(`team task "${task.id}" cannot block itself`, 'cycle')
      if (seen.has(blockerId)) throw new TeamTaskGraphError(`team task "${task.id}" repeats blocker "${blockerId}"`, 'duplicate')
      const blocker = tasks.get(blockerId)
      if (blocker === undefined || blocker.status === 'deleted') {
        throw new TeamTaskGraphError(`blocker task "${blockerId}" for "${task.id}" is missing or deleted`, 'missing')
      }
      seen.add(blockerId)
    }
  }
  const visiting = new Set<TeamTaskId>()
  const visited = new Set<TeamTaskId>()
  const visit = (id: TeamTaskId): void => {
    if (visiting.has(id)) throw new TeamTaskGraphError(`task dependency cycle includes "${id}"`, 'cycle')
    if (visited.has(id)) return
    const task = tasks.get(id)
    if (task === undefined || task.status === 'deleted') return
    visiting.add(id)
    for (const blockerId of task.blockedBy) visit(blockerId)
    visiting.delete(id)
    visited.add(id)
  }
  for (const task of tasks.values()) visit(task.id)
}
