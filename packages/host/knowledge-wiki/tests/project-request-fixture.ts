import type { WikiProjectRequest } from '../src/types.ts'

/** Bind legacy unit fixtures to their explicitly selected synthetic workspace. */
export function projectRequest(service: object): WikiProjectRequest {
  const internal = service as {
    projectToken(root: string): WikiProjectRequest['projectContext']
    captureProjectContext(): { projectRoot: string }
  }
  return { projectContext: internal.projectToken(internal.captureProjectContext().projectRoot) }
}
