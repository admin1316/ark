/** Credential-header admission and legacy-settings projection for the pi-ai owner. */
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials';
import { isCredentialHeaderName } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';
import assert from 'node:assert/strict';
function required(value) {
    assert(value !== undefined, 'llm-pi-ai cannot redact an incomplete configuration schema');
    return value;
}
function accepts(value, schema) {
    try {
        z.resolve(value, schema, {});
        return true;
    }
    catch {
        return false; /* Schema rejection must not expose its value-bearing diagnostic. */
    }
}
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function redactProviderCredentialFields(value, schema, opaqueFields = ['headers', 'credentialHeaders']) {
    const secrets = [];
    const ancestors = new Set();
    const assertJson = (entry) => {
        if (entry === null || typeof entry !== 'object')
            return;
        if (ancestors.has(entry))
            throw new TypeError('llm-pi-ai cannot safely redact cyclic provider settings');
        ancestors.add(entry);
        try {
            if (!Array.isArray(entry) && Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null) {
                throw new TypeError('llm-pi-ai cannot safely redact non-JSON provider settings');
            }
            Object.values(entry).forEach(assertJson);
        }
        finally {
            ancestors.delete(entry);
        }
    };
    const alternatives = (nodes) => nodes.flatMap(node => node.type === 'union' ? alternatives(required(node.list)) : [node]);
    const visit = (entry, nodes, path) => {
        if (entry === undefined || entry === null)
            return entry;
        const choices = alternatives(nodes);
        if (typeof entry !== 'object') {
            if (!choices.some(node => accepts(entry, node)))
                throw new TypeError('llm-pi-ai cannot safely redact malformed provider settings');
            return entry;
        }
        if (Array.isArray(entry)) {
            const elements = choices.filter(node => node.type === 'array').map(node => required(node.inner));
            if (elements.length === 0)
                throw new TypeError('llm-pi-ai cannot safely redact malformed provider settings');
            return entry.map((item, index) => visit(item, elements, [...path, String(index)]));
        }
        const objects = choices.filter(node => node.type === 'object' || node.type === 'dict');
        if (objects.length === 0)
            throw new TypeError('llm-pi-ai cannot safely redact malformed provider settings');
        return Object.fromEntries(Object.entries(entry).flatMap(([name, item]) => {
            // Union members may share a container while declaring different public fields.
            const children = objects.flatMap(node => node.type === 'dict'
                ? accepts(name, required(node.sKey)) ? [required(node.inner)] : []
                : Object.hasOwn(required(node.dict), name) ? [required(required(node.dict)[name])] : []);
            if (children.length === 0) {
                secrets.push({ path: [...path, name], set: item !== undefined });
                return [];
            }
            return [[name, path.length === 0 && opaqueFields.includes(name) ? item : visit(item, children, [...path, name])]];
        }));
    };
    let snapshot;
    try {
        snapshot = structuredClone(value);
    }
    catch {
        throw new TypeError('llm-pi-ai cannot safely redact non-serializable provider settings');
    }
    assertJson(snapshot);
    return { value: visit(snapshot, [schema], []), secrets };
}
/**
 * Validate headers and separate literal credentials from usable request fields.
 * @param provider - route used in value-free diagnostics.
 * @param source - deployment headers and reference-backed headers.
 * @param schema - the provider profile's live configuration schema.
 * @returns detached headers, validated references and any required migration fields.
 */
export function resolveProfileHeaders(provider, source, schema) {
    const headers = new Map();
    const credentialHeaders = new Map();
    const legacy = [];
    const fields = redactProviderCredentialFields(source, schema).secrets.filter(field => field.set).map(field => field.path);
    const seen = new Set();
    const admit = (name, value) => {
        try {
            new Headers([[name, value]]);
        }
        catch {
            throw new Error(`llm-pi-ai: provider "${provider}" has an invalid request header`);
        }
        const normalized = name.toLowerCase();
        if (seen.has(normalized))
            throw new Error(`llm-pi-ai: provider "${provider}" repeats a request header case-insensitively`);
        seen.add(normalized);
    };
    for (const [name, value] of Object.entries(source.headers ?? {})) {
        admit(name, value);
        if (isCredentialHeaderName(name) && value.trim() !== '')
            legacy.push(name);
        else
            headers.set(name, value);
    }
    for (const [name, reference] of Object.entries(source.credentialHeaders ?? {})) {
        admit(name, '');
        credentialHeaders.set(name, credentialRef(reference));
    }
    return { ...headers.size === 0 ? {} : { headers: Object.fromEntries(headers) },
        ...credentialHeaders.size === 0 ? {} : { credentialHeaders: Object.fromEntries(credentialHeaders) },
        ...legacy.length === 0 && fields.length === 0 ? {} : { migrationRequired: {
                headers: legacy.sort(), ...fields.length === 0 ? {} : { fields },
            } } };
}
/**
 * Redact retained literal credential headers independently in each settings layer.
 * @param value - raw or resolved provider configuration layer.
 * @param schema - the owner's live configuration schema.
 * @returns detached configuration and secret slots without credential values.
 */
export function redactPiAiSecrets(value, schema) {
    if (value === undefined)
        return { value, secrets: [] };
    if (!record(value))
        throw new TypeError('llm-pi-ai cannot safely redact malformed provider settings');
    const root = redactProviderCredentialFields(value, schema, ['providers']);
    const result = root.value;
    const providers = result.providers;
    if (providers === undefined)
        return { value: result, secrets: root.secrets };
    if (!record(providers))
        throw new TypeError('llm-pi-ai cannot safely redact malformed provider settings');
    const secrets = [...root.secrets];
    for (const [provider, profile] of Object.entries(providers)) {
        if (!record(profile))
            throw new TypeError('llm-pi-ai cannot safely redact a malformed provider profile');
        const redacted = redactProviderCredentialFields(profile, required(required(required(schema.dict)['providers']).inner));
        const projected = redacted.value;
        providers[provider] = projected;
        secrets.push(...redacted.secrets.map(field => ({ ...field, path: ['providers', provider, ...field.path] })));
        if (projected.apiKeyEnv !== undefined && projected.apiKeyEnv !== null && projected.apiKeyEnv !== ''
            && (typeof projected.apiKeyEnv !== 'string' || !isCredentialRefName(projected.apiKeyEnv))) {
            throw new TypeError('llm-pi-ai cannot expose a malformed credential reference');
        }
        if (projected.credentialHeaders !== undefined && projected.credentialHeaders !== null) {
            if (!record(projected.credentialHeaders)
                || Object.values(projected.credentialHeaders).some(value => typeof value !== 'string' || !isCredentialRefName(value))) {
                throw new TypeError('llm-pi-ai cannot expose malformed credential-header references');
            }
        }
        if (projected.headers === undefined)
            continue;
        if (!record(projected.headers))
            throw new TypeError('llm-pi-ai cannot safely redact malformed provider headers');
        projected.headers = Object.fromEntries(Object.entries(projected.headers).filter(([name, entry]) => {
            if (!isCredentialHeaderName(name) || entry === '') {
                if (typeof entry !== 'string')
                    throw new TypeError('llm-pi-ai cannot safely redact malformed provider headers');
                return true;
            }
            secrets.push({ path: ['providers', provider, 'headers', name], set: entry !== undefined });
            return false;
        }));
    }
    return { value: result, secrets };
}
//# sourceMappingURL=headers.js.map