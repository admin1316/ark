/** One user-invocable skill row exposed by the Native skill catalog. */
export interface RemoteSkillEntry {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly modelInvocable: boolean
}

/** User-invocable catalog for a resolved session project and scope. */
export interface RemoteSkillCatalog {
  readonly skills: readonly RemoteSkillEntry[]
}
