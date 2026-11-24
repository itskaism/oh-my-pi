/**
 * Two-role fixture for `startParentWatchdog`.
 *
 * - `child`: arms the watchdog against its parent, reports `armed`, then pins
 *   its main thread in a synchronous loop — the shape of an onnxruntime
 *   `session.run` that starves every main-loop timer (issue #14340).
 * - `hangup-child <marker>`: arms the watchdog with a hangup grace, records
 *   each SIGHUP in `marker`, and never exits by itself — the shape of a
 *   terminal's process whose hangup teardown never ends.
 * - default (middle; `hangup <marker>` starts a `hangup-child`): spawns the
 *   child, prints its pid, waits for `armed`, then SIGKILLs itself so the child
 *   is orphaned.
 */
import * as fs from "node:fs";
import { startParentWatchdog } from "../../src/subprocess/parent-watchdog";

const BLOCK_MS = 20_000;
const HANGUP_GRACE_MS = 1_500;

const [role, marker] = process.argv.slice(2);

if (role === "child") {
	startParentWatchdog(process.ppid);
	process.stdout.write("armed\n");
	const end = Date.now() + BLOCK_MS;
	while (Date.now() < end) {}
	process.stdout.write("survived\n");
} else if (role === "hangup-child") {
	startParentWatchdog(process.ppid, { hangupGraceMs: HANGUP_GRACE_MS });
	process.on("SIGHUP", () => fs.appendFileSync(marker, "hup\n"));
	process.stdout.write("armed\n");
	setTimeout(() => {}, BLOCK_MS);
} else {
	const childArgs = role === "hangup" ? ["hangup-child", marker] : ["child"];
	const child = Bun.spawn([process.execPath, import.meta.path, ...childArgs], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "inherit",
	});
	process.stdout.write(`${child.pid}\n`);
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let output = "";
	while (!output.includes("armed")) {
		const { value, done } = await reader.read();
		if (done) break;
		output += decoder.decode(value);
	}
	// Exit with a distinct code (not SIGKILL, and not Windows' TerminateProcess
	// code 1) when the child died before arming, so the test can tell a broken
	// fixture from a reaped orphan.
	if (!output.includes("armed")) process.exit(2);
	process.kill(process.pid, "SIGKILL");
}
