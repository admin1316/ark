/**
 * Cooperative local text extraction. Office/PDF parsing is deliberately
 * refused here and must run through the injected owned stage executor.
 * @module @deepseek-ai/dsh-knowledge-wiki/file-extract
 */
/**
 * Extract readable text from one project file.
 * @param absolutePath - absolute filesystem path.
 * @returns extracted text, or null when the format is unsupported.
 */
export declare function extractFileText(absolutePath: string): Promise<string | null>;
//# sourceMappingURL=file-extract.d.ts.map