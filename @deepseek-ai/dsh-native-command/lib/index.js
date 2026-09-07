import { execFile } from "node:child_process";
//#region lib/types/index.js
/**
* Shared no-shell `execFile` runner for host-native OS integrations (the
* native directory chooser, the open-with-default-application hand-off):
* utf8 stdio capture, abort propagation, Windows console hide. A library,
* not a plugin — no ctx, no state, no events.
* @module @deepseek-ai/dsh-native-command
*/
/**
* Run a host command with utf8 stdio, abort propagation, and Windows hide.
* @param command - executable path or PATH name.
* @param args - argv (never a shell string).
* @param signal - caller/connection lifetime; abort terminates the child.
* @returns captured stdout/stderr on exit 0.
*/
const runNativeCommand = (command, args, signal) => new Promise((resolve, reject) => {
	execFile(command, [...args], {
		encoding: "utf8",
		signal,
		windowsHide: true
	}, (error, stdout, stderr) => {
		if (error !== null) {
			reject(Object.assign(new Error(error.message, { cause: error }), {
				code: error.code,
				stdout,
				stderr
			}));
			return;
		}
		resolve({
			stdout,
			stderr
		});
	});
});
/** Render one path as a PowerShell single-quoted literal. */
function powershellLiteral(path) {
	return `'${path.replace(/'/g, "''")}'`;
}
/** Resolve the shell-free executable and argv for one native document handoff. */
function nativeTextDocumentCommand(platform, path) {
	if (platform === "darwin") return ["open", ["-t", path]];
	if (platform === "win32") return ["powershell.exe", [
		"-NoProfile",
		"-Command",
		`Invoke-Item -LiteralPath ${powershellLiteral(path)}`
	]];
	if (platform === "linux") return ["xdg-open", [path]];
	throw new Error(`native text document opener is unsupported on ${platform}`);
}
/**
* Hand one Host-resolved text document to the platform editor association.
*
* This intentionally accepts only an already-authorized filesystem target;
* callers own path resolution and policy. The command runner receives the
* original cancellation signal, and no platform branch ever invokes a shell.
* @param path - absolute Host-owned text-document path.
* @param signal - caller/connection lifetime; abort terminates the native command.
*/
async function openNativeTextDocument(path, signal) {
	signal.throwIfAborted();
	const [command, args] = nativeTextDocumentCommand(process.platform, path);
	await runNativeCommand(command, args, signal);
}
//#endregion
export { openNativeTextDocument, runNativeCommand };
