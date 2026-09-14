/** Package-owned companion for the caller-owned Session migration machinery. */
const PACKAGE_NAME = '@deepseek-ai/dsh-session-format';
/** Cordis companion plugin name. */
export const name = 'session-format-invariant';
/** Registry required to reserve package ownership. */
export const inject = ['invariants'];
/**
 * No runtime invariant: migration stages and output collectors belong to each
 * caller's stream. This library owns no mounted Session or durable publication;
 * chain construction and stream operations validate their own input relationships.
 */
const install = () => { };
/**
 * Register this package's companion without activating a migration.
 * @param ctx - context carrying the invariant registry.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
/* jscpd:ignore-end */
//# sourceMappingURL=invariant.js.map