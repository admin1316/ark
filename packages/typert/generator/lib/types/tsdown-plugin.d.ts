/**
 * Optional tsdown (rolldown) plugin face of the typert generator. It lowers
 * standard decorators in TypeScript dependencies before bundling, then emits
 * model-driven face artifacts at the package output root. Packages without a
 * Typert or Remote export are skipped.
 * @module @deepseek-ai/dsh-typert-generator/tsdown
 */
import type { WorkspaceEmitResult } from './workspace.ts';
import type { TypertFace } from './model.ts';
/** The subset of the rolldown plugin contract used here (structural; avoids a rolldown type dependency). */
interface TypertPlugin {
    name: string;
    transform: (code: string, id: string) => {
        code: string;
        map: string | undefined;
    } | undefined;
    writeBundle: (options: {
        dir?: string;
    }) => void;
}
/** Generation scope selected by a tsdown build phase. */
export interface TypertPluginOptions {
    /** Emission scope, or transform-only when a separate verified generation process owns artifacts. */
    readonly mode?: 'package' | 'workspace' | 'transform-only';
    /** Independent TypeScript program faces included in this phase. */
    readonly faces?: readonly TypertFace[];
}
/**
 * Create the decorator-lowering and typert-generation plugin for the root tsdown config.
 * @param pluginOptions - package/workspace emission mode and independent program faces.
 * @returns a rolldown-compatible plugin that lowers source decorators and emits local and Host-for-Client artifacts.
 */
export declare function typertPlugin(pluginOptions?: TypertPluginOptions): TypertPlugin;
/**
 * Generate every opted-in contributor after this snapshot passes workspace tsc.
 * Run in a separate process to release compiler state before runtime bundling.
 * @param root - verified workspace root containing the face aggregates.
 * @param faces - independent faces to generate; omission includes both faces.
 * @returns nothing; writes all validated artifacts or throws on analysis/export failure.
 */
export declare function emitVerifiedWorkspaceArtifacts(root: string, faces?: readonly TypertFace[]): void;
/**
 * Write generated reflection artifacts for one validated package output root.
 * @param packageDir - owning package directory.
 * @param artifacts - generated faces for this exact package.
 */
export declare function emitArtifacts(packageDir: string, artifacts: readonly WorkspaceEmitResult[]): void;
export {};
//# sourceMappingURL=tsdown-plugin.d.ts.map