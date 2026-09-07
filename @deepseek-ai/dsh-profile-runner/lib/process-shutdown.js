//#region lib/types/process-shutdown.js
/** Bounded, escalating process shutdown for the long-lived CLI surfaces. */
/** Maximum grace allowed for the application tree to dispose before process exit. */
const PROCESS_SHUTDOWN_TIMEOUT_MS = 5e3;
/** Typed diagnostic for a disposer that did not quiesce inside its grace period. */
var ProcessShutdownTimeoutError = class extends Error {
	constructor(timeoutMs) {
		super(`application disposal timed out after ${String(timeoutMs)}ms`);
		this.name = "ProcessShutdownTimeoutError";
	}
};
/**
* Create one process-exit controller around an application disposer.
* @param dispose - Whole-application teardown that resolves at quiescence.
* @param forceExit - Function that exits the process immediately, replaceable by tests.
* @param complete - Function that records the natural completion code, replaceable by tests.
* @param timeoutMs - Grace before forced exit, replaceable by tests.
* @param reportFailure - Diagnostic sink called at most once for disposer failure
*   or timeout; defaults to stderr. Its exceptions are swallowed before forced exit.
* @returns A controller whose normal calls coalesce and whose repeated signal call escalates.
*/
function createProcessShutdown(dispose, forceExit = (code) => {
	process.exit(code);
}, complete = (code) => {
	process.exitCode = code;
}, timeoutMs = PROCESS_SHUTDOWN_TIMEOUT_MS, reportFailure = (error) => {
	const detail = error instanceof Error ? error.stack ?? error.message : String(error);
	console.error(`dsh: shutdown failed: ${detail}`);
}) {
	let pending;
	let timeout;
	let completed = false;
	let forceExited = false;
	let forceAfterDispose = false;
	let interruptCount = 0;
	let requestedCode = 0;
	let failureReported = false;
	const clearExitTimeout = () => {
		/* v8 ignore else -- shutdown() arms the timer before any asynchronous exit path can run. */
		if (timeout !== void 0) clearTimeout(timeout);
	};
	const forceExitOnce = (code) => {
		if (forceExited) return;
		forceExited = true;
		clearExitTimeout();
		forceExit(code);
	};
	const completeOnce = (code) => {
		if (completed || forceExited) return;
		completed = true;
		clearExitTimeout();
		complete(code);
	};
	const mergeCode = (code) => {
		if (requestedCode === 0 && code !== 0) requestedCode = code;
	};
	const failOnce = (error) => {
		if (!failureReported) {
			failureReported = true;
			try {
				reportFailure(error);
			} catch {}
		}
		forceExitOnce(requestedCode === 0 ? 1 : requestedCode);
	};
	const start = () => {
		if (pending !== void 0) return pending;
		timeout = setTimeout(() => {
			failOnce(new ProcessShutdownTimeoutError(timeoutMs));
		}, timeoutMs);
		pending = Promise.resolve().then(dispose).then(() => {
			if (forceAfterDispose) forceExitOnce(requestedCode);
			else completeOnce(requestedCode);
		}, (error) => {
			failOnce(error);
		});
		return pending;
	};
	return {
		shutdown(code) {
			mergeCode(code);
			return start();
		},
		interrupt(code) {
			if (code !== 0) requestedCode = code;
			else mergeCode(code);
			forceAfterDispose = true;
			interruptCount += 1;
			if (completed || interruptCount > 1) {
				forceExitOnce(requestedCode);
				return;
			}
			start();
		}
	};
}
//#endregion
export { PROCESS_SHUTDOWN_TIMEOUT_MS, ProcessShutdownTimeoutError, createProcessShutdown };
