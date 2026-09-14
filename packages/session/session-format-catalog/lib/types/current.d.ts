/** Current installed Session validation used after vocabulary-aware format restoration. */
import type { SessionFormatArtifact, SessionFormatHeader } from '@deepseek-ai/dsh-session-format';
/**
 * Validate current logical metadata through the installed Session package.
 * @param header - detached current logical header.
 * @returns nothing after successful validation.
 */
export declare function validateInstalledCurrentSessionHeader(header: SessionFormatHeader): void;
/**
 * Validate an unseeded artifact through the installed Session package.
 * Foreign versions and catalog inheritance are rejected before restoration.
 * @param artifact - vocabulary-restored current logical artifact.
 * @returns nothing after successful validation.
 */
export declare function validateInstalledCurrentSessionArtifact(artifact: SessionFormatArtifact): void;
//# sourceMappingURL=current.d.ts.map