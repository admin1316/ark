/**
 * Platform-gated access to the optional Windows ACL backend. The package is
 * never resolved on non-win32 hosts; Windows fails loudly when the reviewed
 * backend is absent or exports an incompatible contract.
 *
 * @module @deepseek-ai/dsh-sandbox-local/windows-acl-backend
 */
/** One live ACL grant owned by the Windows backend. */
export interface WindowsAclWriteGrant {
    add(path: string, standing?: boolean): void;
    dispose(): void;
}
/** The Windows-only functions consumed by the shared local sandbox owner. */
export interface WindowsAclBackend {
    AclWriteGrant: {
        create(writeSid: string): WindowsAclWriteGrant;
    };
    assertTempRootOutsideWorkspace(workspaceRoot: string, tempRoot: string): void;
    tempWriteSid(path: string): string;
    workspaceWriteSid(path: string): string;
    resolveRunnerEntry(specifier: string): string;
}
interface WindowsAclLoadOptions {
    importer?: () => Promise<unknown>;
    resolver?: (specifier: string) => string;
}
/**
 * Load the optional Windows backend only for an actual win32 runtime.
 * @param platform - runtime platform whose backend may be loaded.
 * @param options - injected importer/resolver for the platform contract test.
 * @returns the typed backend on win32 and `undefined` everywhere else.
 */
export declare function loadWindowsAclBackend(platform: string, options?: WindowsAclLoadOptions): Promise<WindowsAclBackend | undefined>;
export {};
//# sourceMappingURL=windows-acl-backend.d.ts.map