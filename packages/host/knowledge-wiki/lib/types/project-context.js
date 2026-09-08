/**
 * Freeze the project identity used by one asynchronous operation.
 * @param projectRoot - The project root input.
 * @param mainRoot - The main root input.
 * @param mainWikiRoot - The main wiki root input.
 * @param generation - The generation input.
 * @returns The value produced by create project execution context.
 */
export function createProjectExecutionContext(projectRoot, mainRoot, mainWikiRoot, generation) {
    return Object.freeze({
        projectRoot,
        wikiRoot: projectRoot === mainRoot ? mainWikiRoot : `${projectRoot}/wiki`,
        generation,
        startedAt: Date.now(),
    });
}
/**
 * Describes the project execution context value used by this package.
 */
//# sourceMappingURL=project-context.js.map