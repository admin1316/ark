/** Credential-header admission and legacy-settings projection for the pi-ai owner. */
import { type CredentialRef } from '@deepseek-ai/dsh-credentials';
import type { RedactedValue } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
/**
 * Hide fields absent from the provider's schema, preserving declared dictionaries and capabilities.
 * @param value - one provider profile, including retained unknown fields.
 * @param schema - the same live schema used to configure this owner.
 * @param opaqueFields - root fields redacted separately by their owning schema or dictionary.
 * @returns a detached profile and paths of removed fields; malformed values fail without echoing data.
 */
export declare function redactProviderCredentialFields(value: Record<string, unknown>, schema: z<never, unknown>, opaqueFields?: readonly string[]): RedactedValue & {
    value: Record<string, unknown>;
};
/**
 * Project an untyped configuration layer through the provider schema.
 * @param value - retained configuration data.
 * @param schema - the owner's live configuration schema.
 * @param opaqueFields - root fields handled separately by their owner.
 * @returns detached public fields and removal paths; malformed data throws a value-free error.
 */
export declare function redactProviderCredentialFields(value: unknown, schema: z<never, unknown>, opaqueFields?: readonly string[]): RedactedValue;
/**
 * Validate headers and separate literal credentials from usable request fields.
 * @param provider - route used in value-free diagnostics.
 * @param source - deployment headers and reference-backed headers.
 * @param schema - the provider profile's live configuration schema.
 * @returns detached headers, validated references and any required migration fields.
 */
export declare function resolveProfileHeaders(provider: string, source: {
    headers?: Record<string, string>;
    credentialHeaders?: Record<string, string>;
}, schema: z<never, unknown>): {
    headers?: Record<string, string>;
    credentialHeaders?: Record<string, CredentialRef>;
    migrationRequired?: {
        headers: string[];
        fields?: string[][];
    };
};
/**
 * Redact retained literal credential headers independently in each settings layer.
 * @param value - raw or resolved provider configuration layer.
 * @param schema - the owner's live configuration schema.
 * @returns detached configuration and secret slots without credential values.
 */
export declare function redactPiAiSecrets(value: unknown, schema: z<never, unknown>): RedactedValue;
//# sourceMappingURL=headers.d.ts.map