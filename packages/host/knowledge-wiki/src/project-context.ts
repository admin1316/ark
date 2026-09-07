/** Captures the project and generation identity used by one asynchronous operation. */
export interface ProjectExecutionContext {
  readonly projectRoot: string
  readonly wikiRoot: string
  readonly generation: number
  readonly startedAt: number
}

/**
 * Freeze the project identity used by one asynchronous operation.
 * @param projectRoot - The project root input.
 * @param mainRoot - The main root input.
 * @param mainWikiRoot - The main wiki root input.
 * @param generation - The generation input.
 * @returns The value produced by create project execution context.
 */
export function createProjectExecutionContext(
  projectRoot: string,
  mainRoot: string,
  mainWikiRoot: string,
  generation: number,
): ProjectExecutionContext {
  return Object.freeze({
    projectRoot,
    wikiRoot: projectRoot === mainRoot ? mainWikiRoot : `${projectRoot}/wiki`,
    generation,
    startedAt: Date.now(),
  })
}
/**
 * Describes the project execution context value used by this package.
 */
