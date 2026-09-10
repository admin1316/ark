/**
 * Structural secret redaction for settings values. `role('secret')` fields are
 * removed from a value before it crosses a wire boundary; a sidecar records
 * each schema-declared secret position and whether it currently holds a value,
 * so a configuration surface can render a write-only input without ever
 * receiving the secret itself.
 * @module @deepseek-ai/dsh-settings/redact
 */
/** Whether a value is a plain data object the walker may recurse into. */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function children(node) {
    return [...Object.values(node.dict ?? {}), ...[node.inner, node.sKey].filter(child => child !== undefined), ...node.list ?? []];
}
function assertPublicKeys(node) {
    if (node.sKey !== undefined && containsSecret(node.sKey))
        throw new TypeError('settings cannot expose secret dictionary keys');
}
function containsSecret(node, seen = new Set()) {
    if (seen.has(node))
        return false;
    seen.add(node);
    return node.meta?.role === 'secret' || children(node).some(child => containsSecret(child, seen));
}
function setProperty(record, key, value) {
    Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
}
function walk(node, value, path, secrets) {
    if (node === undefined)
        return value;
    if (node.meta?.role === 'secret') {
        secrets.push({ path, set: value !== undefined });
        return undefined;
    }
    const shapeMatches = node.type === 'object' || node.type === 'dict' ? isRecord(value)
        : node.type === 'array' || node.type === 'tuple' ? Array.isArray(value) : true;
    if (value !== undefined && !shapeMatches && containsSecret(node)) {
        throw new TypeError('settings cannot safely redact a malformed secret-bearing container');
    }
    switch (node.type) {
        case 'object': {
            const properties = node.dict ?? {};
            const source = isRecord(value) ? value : undefined;
            const rebuilt = {};
            if (source !== undefined) {
                for (const [key, entry] of Object.entries(source)) {
                    if (Object.hasOwn(properties, key))
                        continue;
                    setProperty(rebuilt, key, entry);
                }
            }
            for (const [key, child] of Object.entries(properties)) {
                const original = source !== undefined && Object.hasOwn(source, key) ? source[key] : undefined;
                const stripped = walk(child, original, [...path, key], secrets);
                if (stripped !== undefined)
                    setProperty(rebuilt, key, stripped);
            }
            return source === undefined && Object.keys(rebuilt).length === 0 ? value : rebuilt;
        }
        case 'dict': {
            assertPublicKeys(node);
            if (!isRecord(value))
                return value;
            const rebuilt = {};
            for (const [key, entry] of Object.entries(value)) {
                const stripped = walk(node.inner, entry, [...path, key], secrets);
                if (stripped !== undefined)
                    setProperty(rebuilt, key, stripped);
            }
            return rebuilt;
        }
        case 'array': {
            if (!Array.isArray(value))
                return value;
            return value.map((entry, index) => walk(node.inner, entry, [...path, String(index)], secrets) ?? null);
        }
        case 'union':
        case 'intersect':
            // All branches constrain secrecy, even when another branch accepts the same value.
            return (node.list ?? []).reduce((current, branch) => walk(branch, current, path, secrets), value);
        case 'tuple':
            if (!Array.isArray(value))
                return value;
            return value.map((entry, index) => walk(node.list?.[index], entry, [...path, String(index)], secrets) ?? null);
        default:
            if (containsSecret(node))
                throw new TypeError(`settings cannot safely redact schema type "${node.type ?? 'unknown'}"`);
            return value;
    }
}
/**
 * Remove every `role('secret')` field a schema declares from a value. The
 * walker follows object, dict, array, tuple, union, and intersection relations.
 * Unsupported or malformed secret-bearing containers reject instead of returning
 * their values, including schema defaults and overridden layers. Secret array
 * positions become null so indexes remain stable.
 * @param schema - live schemastery schema describing the value.
 * @param value - the value to strip; `undefined` yields an empty record with
 *   object-property secret slots still enumerated.
 * @returns the stripped detached value and the ordered secret positions.
 */
export function redactSecrets(schema, value) {
    const secrets = [];
    const stripped = walk(schema, value, [], secrets);
    const unique = new Map();
    for (const secret of secrets) {
        const key = JSON.stringify(secret.path);
        const previous = unique.get(key);
        unique.set(key, { path: secret.path, set: secret.set || previous?.set === true });
    }
    return { value: stripped, secrets: [...unique.values()] };
}
/**
 * Serialize form metadata with secret values removed from every default layer.
 * @param schema - live namespace schema, including shared schema nodes.
 * @returns its detached schemastery envelope, safe from schema-declared default secrets.
 */
export function redactSettingsSchema(schema) {
    const nodes = new Map();
    const visited = new Set();
    const visit = (node) => {
        if (visited.has(node))
            return;
        visited.add(node);
        assertPublicKeys(node);
        nodes.set(node.uid, node);
        for (const child of children(node))
            visit(child);
    };
    visit(schema);
    const envelope = schema.toJSON();
    if (!isRecord(envelope) || !isRecord(envelope['refs']))
        throw new TypeError('settings schema has no serialized references');
    for (const [id, serialized] of Object.entries(envelope['refs'])) {
        const node = nodes.get(Number(id));
        if (node === undefined || !isRecord(serialized))
            throw new TypeError('settings schema has an unrecognized reference');
        if (!containsSecret(node))
            continue;
        if (node.meta?.role === 'secret' && node.type === 'const') {
            throw new TypeError('settings cannot expose a secret literal schema');
        }
        const meta = serialized['meta'];
        if (isRecord(meta) && Object.hasOwn(meta, 'default')) {
            const stripped = walk(node, meta['default'], [], []);
            if (stripped === undefined)
                delete meta['default'];
            else
                setProperty(meta, 'default', stripped);
        }
    }
    return envelope;
}
//# sourceMappingURL=redact.js.map