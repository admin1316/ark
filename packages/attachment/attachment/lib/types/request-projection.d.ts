/** Pure request-image geometry shared by attachment providers and token pricing. */
/**
 * Compute aspect-preserving integer dimensions within a hard total-pixel budget.
 * Small images are never enlarged and the result is always inside the budget.
 * @param width - The width input.
 * @param height - The height input.
 * @param maxPixels - The max pixels input.
 * @returns The value produced by request image dimensions.
 */
export declare function requestImageDimensions(width: number, height: number, maxPixels: number): {
    width: number;
    height: number;
};
//# sourceMappingURL=request-projection.d.ts.map