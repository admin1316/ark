import { proxyEnvironmentForChild } from "@deepseek-ai/dsh-http-proxy";
//#region lib/types/policy.js
/**
* The environment names each policy field owns, lowercase first — undici reads the lowercase name
* first, so both casings are always written or cleared together.
*/
const POLICY_ENV_NAMES = {
	httpProxy: ["http_proxy", "HTTP_PROXY"],
	httpsProxy: ["https_proxy", "HTTPS_PROXY"],
	noProxy: ["no_proxy", "NO_PROXY"]
};
[...Object.values(POLICY_ENV_NAMES).flat()];
/** Proxy URL schemes this package routes through. Everything else is reported, never silently dropped. */
const SUPPORTED_PROTOCOLS = new Set(["http:", "https:"]);
/**
* Whether a proxy URL is one this package accepts: parseable, with an `http:` or `https:` scheme.
* The same test {@link acceptProxyUrl} applies, without its diagnostics.
*
* @param value - the proxy URL as an environment variable holds it.
* @returns true when the URL would be accepted.
*/
function isSupportedProxyUrl(value) {
	const parsed = URL.parse(value);
	return parsed !== null && SUPPORTED_PROTOCOLS.has(parsed.protocol);
}
/** One IPv4 octet, so a loopback match cannot accept `127.999.1.1`. */
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
new RegExp(`^127\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);
//#endregion
//#region lib/types/invariant.js
/** Package-owned startup check of the active proxy policy's child environment. */
const PACKAGE_NAME = "@deepseek-ai/dsh-http-proxy";
/** Cordis companion plugin name. */
const name = "http-proxy-invariant";
/** Registry required to reserve package ownership. */
const inject = ["invariants"];
/**
* Check the actual active policy when this companion starts. Enabling Node's
* environment proxy requires every supplied HTTP(S) proxy variable to be usable
* by Node; inherited SOCKS values may remain only with that flag withheld.
* Installation and disposal stay owned by the launcher, without polling here.
*/
const install = (_ctx, fail) => {
	const environment = proxyEnvironmentForChild();
	if (environment.NODE_USE_ENV_PROXY !== "1") return;
	for (const key of [...POLICY_ENV_NAMES.httpProxy, ...POLICY_ENV_NAMES.httpsProxy]) {
		const value = environment[key];
		if (value !== void 0 && !isSupportedProxyUrl(value)) fail(`child environment enables Node proxy parsing with an unsupported ${key}; proxy values are withheld`);
	}
};
/**
* Register the package's check of its current child-environment result.
* @param ctx - context carrying the invariant registry.
* @returns the installed registration's disposer after validation succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
