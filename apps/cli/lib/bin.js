#!/usr/bin/env node
import { n as INSTALL_ANCHOR, t as CLI_AGENT_PRESET_ROOT } from "./installation-C2WHY-2K.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadLayeredEnv } from "@deepseek-ai/dsh-app-boot";
import { Command, CommanderError } from "commander";
//#region lib/types/args.js
/**
* Commander adapter for the `dsh` command line.
*
* The launcher parses only what it owns — which profile to boot, which extra
* patch overlays to apply, and the config dumps — and hands **everything after
* its own flags** to the booted tree verbatim, where injected app plugins parse
* their own flag families and print their own `--help` (see
* `@deepseek-ai/dsh-cmdline`). Launcher flags therefore come first: the first
* token this parser does not recognize starts the inner arguments, so
* `dsh --profile tui --resume abc` boots the tui profile with `--resume abc`.
* `plugin` manages a profile's plugin dependencies by forwarding to pnpm.
* @module @deepseek-ai/dsh/args
*/
/**
* Repeatable single-value collector: `--patch a.yml --patch b.yml`. Never
* variadic — a variadic `--patch` would swallow the inner arguments.
*/
const collect = (value, previous = []) => [...previous, value];
/** The launcher's own help text; each app prints its own. */
const HELP_EXAMPLES = `
Examples:
  dsh --profile headless "run the tests"     answer one task, print the result, and exit
  dsh --profile tui --patch ./extra.yml      boot a custom profile with one extra overlay
  dsh --profile tui --resume <session>       arguments after the launcher flags reach the app
  dsh plugin --profile tui add <package>     install a plugin into the tui profile
`;
/**
* Resolve a boot or dump invocation from the launcher flags and the leftover
* inner arguments.
* @param program - the command whose options were parsed.
* @param profile - the profile these flags boot.
* @param options - the launcher flags commander collected.
* @param args - the leftover arguments, in argv order.
* @returns the resolved invocation.
*/
function resolveBoot(program, profile, options, args) {
	const patches = options.patch ?? [];
	if (patches.includes("")) program.error("error: --patch needs a path");
	if (options.dumpConfig !== true && options.dumpDefaultConfig !== true) return {
		mode: "profile",
		profile,
		patches,
		args
	};
	if (options.dumpConfig === true && options.dumpDefaultConfig === true) program.error("error: --dump-config and --dump-default-config are mutually exclusive");
	if (args.length > 0) program.error(`error: config dumps take no app arguments, got ${args.map((argument) => JSON.stringify(argument)).join(" ")}`);
	const defaultOnly = options.dumpDefaultConfig === true;
	if (defaultOnly && patches.length > 0) program.error("error: --dump-default-config prints the bundle layers and takes no --patch");
	return {
		mode: "dump-config",
		profile,
		defaultOnly,
		patches
	};
}
/**
* Resolve argv into one invocation, or print and exit for help, version, or an
* error.
* @param argv - arguments after the Node binary and script.
* @param version - version string printed by `--version`.
* @returns the resolved invocation.
*/
function parseDshArgs(argv, version) {
	let resolved;
	const program = new Command();
	program.name("dsh").version(version, "-V, --version", "output the version number").description("dsh: boot a DeepSeek Harness profile — an ordered stack of plugin-bundle patch layers under your own overrides.").addHelpText("after", HELP_EXAMPLES).exitOverride().helpOption(false).allowUnknownOption().passThroughOptions().enablePositionalOptions().argument("[args...]", "arguments for the booted profile's app (see: dsh --profile <name> --help)").option("--profile <name>", "the profile under $DSH_HOME/profiles to boot").option("--patch <path>", "extra patch-list overlay applied after the profile layer (repeatable)", collect).option("--dump-config", "print the composed profile tree and exit").option("--dump-default-config", "print the profile tree without its user layer or --patch overlays and exit").action((args, options) => {
		if (options.profile === void 0) {
			if (args.some((argument) => argument === "-h" || argument === "--help")) program.help();
			program.error("error: --profile <name> is required");
		}
		const profile = options.profile;
		if (profile === "") program.error("error: --profile needs a name");
		resolved = resolveBoot(program, profile, options, args);
	});
	/** Reject parent options supplied before a subcommand. */
	const rejectParentOptions = (command) => {
		const parent = program.opts();
		if (parent.profile !== void 0 || parent.patch !== void 0 || parent.dumpConfig !== void 0 || parent.dumpDefaultConfig !== void 0) program.error(`error: ${command} takes none of parent --profile, --patch, --dump-config, or --dump-default-config`);
	};
	program.command("plugin").description("manage a profile's plugins by forwarding the remaining arguments to pnpm in the profile directory").requiredOption("--profile <name>", "the profile whose plugins to manage (initialized on first use)").allowUnknownOption().argument("[args...]", "pnpm arguments, forwarded verbatim (add <pkg>, remove <pkg>, why <pkg>, ...)").action((args, options) => {
		rejectParentOptions("plugin");
		if (options.profile === "") program.error("error: --profile needs a name");
		if (args.length === 0) program.error("error: plugin needs pnpm arguments to forward (e.g. add <package>)");
		resolved = {
			mode: "plugin",
			profile: options.profile,
			args
		};
	});
	try {
		program.parse(argv, { from: "user" });
	} catch (error) {
		return process.exit(error instanceof CommanderError ? error.exitCode : 1);
	}
	/* v8 ignore next -- an action resolves or Commander throws */
	if (resolved === void 0) throw new Error("dsh: no invocation resolved");
	return resolved;
}
//#endregion
//#region lib/types/bin.js
/**
* dsh — command-line entry. Dynamic imports per mode keep unrelated modes out
* of each dispatch path; the adapter prints and exits for
* `--help`/`--version`/a parse error, so only a valid mode reaches the switch.
* @module @deepseek-ai/dsh/bin
*/
/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */
/** This app's version, read from its checked-in package.json. */
function readVersion() {
	const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
	return typeof manifest.version === "string" ? manifest.version : "0.0.0";
}
const invocation = parseDshArgs(process.argv.slice(2), readVersion());
switch (invocation.mode) {
	case "profile": {
		if (invocation.profile === "jiuzhang") throw new Error("cannot resolve profile bundle \"@deepseek-ai/dsh-native-api-app\"");
		const { runProfile } = await import("@deepseek-ai/dsh-profile-runner");
		await runProfile({
			installAnchor: INSTALL_ANCHOR,
			environment: loadLayeredEnv("dsh"),
			profile: invocation.profile,
			patchFiles: invocation.patches,
			args: invocation.args,
			additionalSystemPresetRoots: [CLI_AGENT_PRESET_ROOT]
		});
		break;
	}
	case "plugin": {
		const { runPlugin } = await import("./plugin-gf7dapNU.js");
		process.exit(runPlugin(invocation.profile, invocation.args));
		break;
	}
	case "dump-config": {
		if (invocation.profile === "jiuzhang") throw new Error("cannot resolve profile bundle \"@deepseek-ai/dsh-native-api-app\"");
		const { runDumpConfig } = await import("./dump-config-CwsLpUI0.js");
		runDumpConfig(invocation.profile, invocation.defaultOnly, invocation.patches);
		break;
	}
	default: throw new Error(`dsh: unhandled invocation mode ${JSON.stringify(invocation)}`);
}
//#endregion
export {};
