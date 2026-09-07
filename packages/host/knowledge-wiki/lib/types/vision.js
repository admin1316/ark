/**
 * Image-path classification for the isolated multimodal ingest stage.
 * @module @deepseek-ai/dsh-knowledge-wiki/vision
 */
import { extname } from 'node:path';
const MIME_BY_EXT = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
};
/**
 * Whether a file path looks like a supported image.
 * @param path - The path input.
 * @returns The value produced by is image path.
 */
export function isImagePath(path) {
    return extname(path).toLowerCase() in MIME_BY_EXT;
}
//# sourceMappingURL=vision.js.map