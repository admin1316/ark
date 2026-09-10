/**
 * Normalize a required human-authored string.
 * @param value - raw input.
 * @param field - diagnostic field name.
 * @param maxLength - normalized character limit.
 * @returns trimmed non-empty text.
 */
export declare function requiredText(value: string, field: string, maxLength: number): string;
/**
 * Normalize an advisory workspace-relative path prefix, not a write lock.
 * @param value - authored path prefix.
 * @returns slash-separated relative prefix.
 */
export declare function writeScope(value: string): string;
//# sourceMappingURL=validation.d.ts.map