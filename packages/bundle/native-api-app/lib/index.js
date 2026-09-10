//#region lib/types/index.js
/**
* API-only native desktop readiness owner. It publishes one loopback URL only
* after the complete Loader tree settles and never mounts browser behavior.
* @module @deepseek-ai/dsh-native-api-app
*/
/** Stable Cordis plugin name. */
const name = "native-api-app";
/** The bound WebServer is the sole runtime dependency. */
const inject = ["webServer"];
const LOOPBACK_HOST = "127.0.0.1";
/**
* Publish the API readiness line after every sibling row has activated.
* A failed or disposed Loader tree remains silent, so a supervisor never
* accepts a listener whose application failed to finish booting.
* @param ctx - plugin context carrying the bound API-only WebServer.
*/
function apply(ctx) {
	const announce = () => {
		const server = ctx.get("webServer");
		if (server === void 0) return;
		console.log(`dsh native-api: http://${LOOPBACK_HOST}:${String(server.port)}`);
	};
	const settled = ctx.get("loader")?.await();
	if (settled === void 0) announce();
	else settled.then(announce, () => {});
}
//#endregion
export { apply, inject, name };
