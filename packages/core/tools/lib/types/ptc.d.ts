/**
 * PTC-mode compatibility entry point.
 *
 * The implementation remains in the existing code-mode module so old imports
 * and persisted Code Mode records keep working. New callers can use this
 * module while the model-facing presentation is named PTC.
 *
 * @module @deepseek-ai/dsh-tools/src/ptc
 */
export { CodeRunFailedError, createRunCodeTool, RUN_CODE_NAME, SDK_SECTION_ORDER, } from './code-mode.ts';
export type { CodeSdkLanguage, RunCodeBridgeOptions, } from './code-mode.ts';
//# sourceMappingURL=ptc.d.ts.map