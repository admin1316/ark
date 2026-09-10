/**
 * CPython subprocess code runtime for the DeepSeek Harness code-execution seam.
 *
 * The package owns the versionless fd-3 wire protocol between the Node host and
 * the CPython subprocess. The protocol's host-side codec and hostile-frame
 * validators are re-exported so every consumer of the wire shares one
 * vocabulary.
 * @module @deepseek-ai/dsh-code-runtime-python
 */
export { checkDoneValue, encodeJsonPlain, hasNonLosslessNumber, hasUnsafeIntegerToken, logTruncationMarker, validateChildFrame, } from "./protocol.js";
//# sourceMappingURL=index.js.map