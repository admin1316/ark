/**
 * The model-facing `read_image` tool commits a PNG/JPEG/WebP/GIF file. A path
 * without a file extension is identified from its file signature, while the
 * attachment service's full decode stays authoritative. The mounted `ctx.fs`
 * backend owns path resolution and read access; names only declare media type.
 *
 * Ark 定制：读图不再按模型模态预检。图片一律允许读入，能否识别由模型/上游
 * 在请求期决定，避免在文件系统与附件写入之后才发现能力不符。
 * @module @deepseek-ai/dsh-tool-fs/src/read-image
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment';
/**
 * Identify the media type declared by a supported image file signature.
 * @param data - file bytes read through the current filesystem backend.
 * @returns the detected supported media type, or undefined for other bytes.
 */
export declare function sniffImageMediaType(data: Uint8Array): ImageMediaType | undefined;
/** The structured outcome declared by the `read_image` output schema. */
export interface ImageReadValue {
    path: string;
    image: {
        attachmentId: string;
        mediaType: ImageMediaType;
        bytes: number;
        width: number;
        height: number;
        name?: string;
        /** Orientation-applied file dimensions before normalization; present only when storage reduced it. */
        originalDimensions?: {
            width: number;
            height: number;
        };
    };
}
/**
 * Map a model-supplied path to its declared image media type by extension.
 * @param filePath - the raw `file_path` argument (not yet resolved).
 * @returns the declared media type, or undefined when the path does not claim an image.
 */
export declare function imageMediaTypeForPath(filePath: string): ImageMediaType | undefined;
/**
 * Re-brand a structured image outcome into the durable attachment reference an
 * `ImageBlock` carries.
 * @param image - the image metadata from the output schema.
 * @returns the branded attachment reference.
 */
export declare function imageRefFromValue(image: ImageReadValue['image']): ImageAttachmentRef;
/**
 * Format an image read as the model-facing envelope beside its image block.
 * A downscaled read names the on-disk dimensions and the multiplier that maps
 * coordinates measured on the attached image back onto the original file.
 * @param displayPath - the backend-resolved path rendered in the envelope's `<path>` element.
 * @param image - the image metadata to summarize.
 * @returns the model-facing envelope; the image itself rides the adjacent image block.
 */
export declare function formatImageReadOutput(displayPath: string, image: ImageReadValue['image']): string;
/**
 * Register the `read_image` tool into the given context. The composing plugin
 * owns the attachments gate: `src/index.ts` calls this inside
 * `ctx.inject(['attachments'], …)` so the tool exists only while a durable
 * store is mounted. Execution still re-checks `ctx.get('attachments')` for
 * direct callers; the calling model's own modality no longer blocks the read.
 * @param ctx - the registration scope; execution uses its `fs` service plus
 *   the optional `attachments` service.
 */
export declare function applyReadImageTool(ctx: Context): void;
//# sourceMappingURL=read-image.d.ts.map