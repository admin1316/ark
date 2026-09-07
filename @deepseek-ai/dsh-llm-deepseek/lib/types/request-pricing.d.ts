/** Provider-side request-image pricing for DeepSeek routes. */
import type { ImageAttachmentAccessResolver, LlmImageRequestPricing } from '@deepseek-ai/dsh-llm';
import type { ImageRequestPolicy } from '@deepseek-ai/dsh-attachment';
import type { DeepSeekCatalogModel, DeepSeekConnectionOptions } from './adapter.ts';
/**
 * Defines the default max request files bytes constant used by this package.
 */
export declare const DEFAULT_MAX_REQUEST_FILES_BYTES: number;
/**
 * Defines the default max images per request constant used by this package.
 */
export declare const DEFAULT_MAX_IMAGES_PER_REQUEST = 600;
/**
 * Defines the default request image pixel budget constant used by this package.
 */
export declare const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 640000;
/**
 * Defines the default low detail image pixel budget constant used by this package.
 */
export declare const DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET: number;
/**
 * Defines the default request image max bytes constant used by this package.
 */
export declare const DEFAULT_REQUEST_IMAGE_MAX_BYTES: number;
/**
 * Resolves the resolve request image policy operation.
 * @param model - The model input.
 * @returns The value produced by resolve request image policy.
 */
export declare function resolveRequestImagePolicy(model: DeepSeekCatalogModel): ImageRequestPolicy;
/**
 * Build a synchronous price function matching DeepSeek request serialization.
 * @param connection - The connection input.
 * @param model - The model input.
 * @param resolveAccess - The resolve access input.
 * @returns The value produced by deep seek image request pricing.
 */
export declare function deepSeekImageRequestPricing(connection: DeepSeekConnectionOptions, model: string, resolveAccess?: ImageAttachmentAccessResolver): LlmImageRequestPricing;
//# sourceMappingURL=request-pricing.d.ts.map