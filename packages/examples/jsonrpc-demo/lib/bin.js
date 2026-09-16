#!/usr/bin/env node
import { existsSync } from "node:fs";
import { boot, installFailLoud, loadLayeredEnv, resolveConfigPath } from "@deepseek-ai/dsh-app-boot";
//#region lib/types/runner.js
/**
* Shared process lifecycle for the generic and closed-runtime JSON-RPC bins.
*
* @module @deepseek-ai/dsh-sdk-jsonrpc-demo/runner
*/
/* v8 ignore start -- composition over tested app-boot/jsonrpc and executable acceptance paths */
const NAME = "dsh-jsonrpc-agent";
/**
* Boot the explicitly selected external configuration and own process exit.
* @param bareModuleBaseUrl - optional installed-runtime base for bare plugins;
* omit it when the configuration project owns its plugin packages.
* @returns after process handlers are installed; process lifetime then belongs
* to stdin and signal events.
*/
async function runJsonrpcAgent(bareModuleBaseUrl) {
	installFailLoud(NAME);
	loadLayeredEnv(NAME);
	const fromEnv = process.env["DSH_CORDIS_CONFIG"];
	const fromArgv = process.argv[2];
	const requested = fromEnv !== void 0 && fromEnv !== "" ? fromEnv : fromArgv !== void 0 && fromArgv !== "" ? fromArgv : void 0;
	const configPath = requested === void 0 ? void 0 : resolveConfigPath(requested, void 0);
	if (configPath === void 0 || !existsSync(configPath)) {
		process.stderr.write(`usage: ${NAME} <path/to/cordis.yml> (or set DSH_CORDIS_CONFIG=<path>, which wins); the config is required — there is no built-in fallback\n`);
		process.exit(1);
	}
	const ctx = await boot(NAME, configPath, void 0, void 0, bareModuleBaseUrl);
	let exiting = false;
	async function disposeAndExit(code) {
		if (exiting) return;
		exiting = true;
		try {
			await ctx.fiber.dispose();
		} finally {
			process.exit(code);
		}
	}
	process.stdin.on("end", () => {
		disposeAndExit(0);
	});
	process.on("SIGTERM", () => {
		disposeAndExit(0);
	});
	process.on("SIGINT", () => {
		disposeAndExit(130);
	});
}
/* v8 ignore stop */
//#endregion
//#region lib/types/bin.js
/**
* Generic JSON-RPC agent bin. External configurations own their bare plugin
* packages; the packaged runtime uses `packaged-bin.ts` instead.
*
* @module @deepseek-ai/dsh-sdk-jsonrpc-demo/bin
*/
await runJsonrpcAgent();
//#endregion
export {};
