import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import { PARENT_WATCHDOG_WORKER_ARG } from "../cli/worker-selectors";

/** When and how {@link startParentWatchdog} ends the process. */
export interface ParentWatchdogOptions {
	/**
	 * For a process that owns a terminal. It ends only once its parent is gone
	 * AND its terminal is gone: none of `fds` (descriptors that were terminals
	 * when the watchdog started) is a terminal any longer, which happens when
	 * the kernel hangs the terminal up. A process whose terminal is still open
	 * (started through a wrapper that exited, `setsid`, a multiplexer that
	 * reparents its clients) keeps running. It then gets SIGHUP, so its own
	 * hangup teardown runs, and SIGKILL if it is still alive `hangupGraceMs`
	 * later. Absent: SIGKILL as soon as the parent is gone.
	 */
	terminal?: { fds: readonly number[]; hangupGraceMs: number };
}

/** The message the watchdog thread receives. */
export interface ParentWatchdogRequest extends ParentWatchdogOptions {
	parentPid: number;
}

/**
 * End this process once `parentPid` exits or this process is reparented:
 * SIGKILL, or with `terminal`, once its terminal is gone as well, SIGHUP and
 * then SIGKILL after the grace.
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
	const request: ParentWatchdogRequest = { parentPid, terminal: options.terminal };
	worker.postMessage(request);
	worker.unref();
}
