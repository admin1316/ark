/** Client-safe projection types for the Native `skills/list` Remote method. */
/** One user-invocable skill row. */
export interface RemoteSkillEntry {
    readonly name: string;
    readonly description: string;
    readonly whenToUse?: string;
    readonly modelInvocable: boolean;
}
/** Effective user-invocable catalog for one resolved session project/scope. */
export interface RemoteSkillCatalog {
    readonly skills: readonly RemoteSkillEntry[];
}
//# sourceMappingURL=types.d.ts.map