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
function walk(node, value, path, secrets) {
    if (node === undefined)
        return value;
    if (node.meta?.role === 'secret') {
        secrets.push({ path, set: value !== undefined });
        return undefined;
    }
    switch (node.type) {
        case 'object': {
            const properties = node.dict ?? {};
            const source = isRecord(value) ? value : undefined;
            const rebuilt = {};
            if (source !== undefined) {
                for (const [key, entry] of Object.entries(source)) {
                    if (key in properties)
                        continue;
                    rebuilt[key] = entry;
                }
            }
            for (const [key, child] of Object.entries(properties)) {
                const stripped = walk(child, source?.[key], [...path, key], secrets);
                if (stripped !== undefined)
                    rebuilt[key] = stripped;
            }
            return source === undefined && Object.keys(rebuilt).length === 0 ? value : rebuilt;
        }
        case 'dict': {
            if (!isRecord(value))
                return value;
            const rebuilt = {};
            for (const [key, entry] of Object.entries(value)) {
                const stripped = walk(node.inner, entry, [...path, key], secrets);
                if (stripped !== undefined)
                    rebuilt[key] = stripped;
            }
            return rebuilt;
        }
        case 'array': {
            if (!Array.isArray(value))
                return value;
            return value.map((entry, index) => walk(node.inner, entry, [...path, String(index)], secrets));
        }
        default:
            // Fail closed: a secret reachable only through a union, intersect, or
            // transform node is not strippable by the structural walker. Instead of
            // returning it verbatim with nothing recorded, refuse the whole value:
            // a schema whose secrets are not reachable through object/dict/array
            // containers must not cross a wire boundary.
            if (subtreeHasSecret(node)) {
                throw new Error(`settings: a secret is declared at a position not reachable through object/dict/array containers (${path.join('.') || '<root>'})`);
            }
            return value;
    }
}
/**
 * Whether any secret-role field is reachable anywhere in a schema subtree.
 * The structural walker follows object/dict/array; a secret buried in a
 * union branch, an intersect member, or under a transform is exactly the
 * case it must refuse rather than pass through.
 * @param node - the subtree to probe.
 * @returns whether the subtree declares a secret anywhere.
 */
function subtreeHasSecret(node) {
    /* v8 ignore next -- callers only probe nodes that exist (walk's default arm and guarded recursion) */
    if (node === undefined)
        return false;
    if (node.meta?.role === 'secret')
        return true;
    if (node.dict !== undefined && Object.values(node.dict).some(subtreeHasSecret))
        return true;
    if (node.inner !== undefined && subtreeHasSecret(node.inner))
        return true;
    if (node.list !== undefined && node.list.some(subtreeHasSecret))
        return true;
    return false;
}
/**
 * Remove every `role('secret')` field a schema declares from a value. The
 * walker follows `object`, `dict`, and `array` containers; a secret buried
 * under a `union`, `intersect`, or `transform` node is refused with an error
 * instead of passing through, because the walker cannot prove it would strip
 * every secret the value may hold. The input is never mutated.
 * @param schema - live schemastery schema describing the value.
 * @param value - the value to strip; `undefined` yields an empty record with
 *   object-property secret slots still enumerated.
 * @returns the stripped detached value and the ordered secret positions.
 */
export function redactSecrets(schema, value) {
    const secrets = [];
    const stripped = walk(schema, value, [], secrets);
    return { value: stripped, secrets };
}
//# sourceMappingURL=redact.js.map