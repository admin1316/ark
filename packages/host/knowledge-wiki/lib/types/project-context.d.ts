/** Captures the project and generation identity used by one asynchronous operation. */
export interface ProjectExecutionContext {
    readonly projectRoot: string;
    readonly wikiRoot: string;
    readonly generation: number;
    readonly startedAt: number;
}
/**
 * Freeze the project identity used by one asynchronous operation.
 * @param projectRoot - The project root input.
 * @param mainRoot - The main root input.
 * @param mainWikiRoot - The main wiki root input.
 * @param generation - The generation input.
 * @returns The value produced by create project execution context.
 */
export declare function createProjectExecutionContext(projectRoot: string, mainRoot: string, mainWikiRoot: string, generation: number): ProjectExecutionContext;
/**
 * Describes the project execution context value used by this package.
 */
//# sourceMappingURL=project-context.d.ts.map