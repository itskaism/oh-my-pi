import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import { PARENT_WATCHDOG_WORKER_ARG } from "../cli/worker-selectors";

/** How {@link startParentWatchdog} ends the process once its parent is gone. */
export interface ParentWatchdogOptions {
	/**
	 * Raise SIGHUP first, so the process's own hangup teardown runs as when its
	 * terminal goes away, and SIGKILL only if the process is still alive this
	 * long after. Absent: SIGKILL at once.
	 */
	hangupGraceMs?: number;
}

/** The message the watchdog thread receives. */
export interface ParentWatchdogRequest extends ParentWatchdogOptions {
	parentPid: number;
}

/**
 * End this process once `parentPid` exits or this process is reparented:
 * SIGKILL, or with `hangupGraceMs` SIGHUP and then SIGKILL after that grace.
 *
 * Called by `runIpcSubprocessWorker` (cli.ts) for every IPC subprocess worker,
 * and by the interactive mode for the process that owns the terminal.
 * Liveness is polled on a dedicated worker thread rather than the main event
 * loop: inference workers pin their main thread inside synchronous native calls
 * (onnxruntime `session.run`) for minutes at a time, and a main-loop watchdog
 * cannot fire until that call returns — leaving a multi-GiB orphan behind a
 * dead parent (issue #14340). The thread is `unref`'d; it never keeps the
 * process alive by itself.
 */
export function startParentWatchdog(parentPid: number, options: ParentWatchdogOptions = {}): void {
	const hostEntry = workerHostEntry();
	const worker = hostEntry
		? new Worker(hostEntry, { type: "module", argv: [PARENT_WATCHDOG_WORKER_ARG] })
		: new Worker(new URL("./parent-watchdog-worker.ts", import.meta.url).href, { type: "module" });
	const request: ParentWatchdogRequest = { parentPid, hangupGraceMs: options.hangupGraceMs };
	worker.postMessage(request);
	worker.unref();
}
