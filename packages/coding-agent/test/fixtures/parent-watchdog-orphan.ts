/**
 * Process tree for parent-watchdog.test.ts.
 *
 * - `child`: arms the watchdog against its parent, reports `armed`, then pins
 *   its main thread in a synchronous loop — the shape of an onnxruntime
 *   `session.run` that starves every main-loop timer (issue #14340).
 * - default (middle): spawns the child, prints its pid, waits for `armed`, then
 *   SIGKILLs itself so the child is orphaned mid-loop.
 * - `terminal-child <marker>`: the interactive mode's shape: arms the watchdog
 *   with the descriptors that are terminals and a hangup grace, appends
 *   `armed <pid>` and then one `hup` per SIGHUP to `marker`, and never exits by
 *   itself — a terminal's process whose hangup teardown never ends.
 * - `terminal-middle <marker> exit|stay`: runs on a terminal (the test's pty),
 *   starts a `terminal-child` on the same terminal in a session of its own
 *   (`setsid`: the kernel's own hangup signals go to the terminal's session,
 *   so the watchdog's SIGHUP is the only one the child gets), waits for
 *   `armed`, then SIGKILLs itself (`exit`) or stays until killed (`stay`).
 */
import * as fs from "node:fs";
import * as tty from "node:tty";
import { startParentWatchdog } from "../../src/subprocess/parent-watchdog";

const BLOCK_MS = 20_000;
const HANGUP_GRACE_MS = 1_500;

const [role, marker, mode] = process.argv.slice(2);

async function waitForArmed(): Promise<boolean> {
	const end = Date.now() + 10_000;
	while (Date.now() < end) {
		if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8").includes("armed")) return true;
		await Bun.sleep(20);
	}
	return false;
}

if (role === "child") {
	startParentWatchdog(process.ppid);
	process.stdout.write("armed\n");
	const end = Date.now() + BLOCK_MS;
	while (Date.now() < end) {}
	process.stdout.write("survived\n");
} else if (role === "terminal-child") {
	const fds = [0, 1, 2].filter(fd => tty.isatty(fd));
	startParentWatchdog(process.ppid, { terminal: { fds, hangupGraceMs: HANGUP_GRACE_MS } });
	process.on("SIGHUP", () => fs.appendFileSync(marker, "hup\n"));
	fs.appendFileSync(marker, `armed ${process.pid} terminal fds ${fds.join(",")}\n`);
	setTimeout(() => {}, BLOCK_MS);
} else if (role === "terminal-middle") {
	// The terminal closing must not end the middle itself in `stay` mode.
	process.on("SIGHUP", () => {});
	Bun.spawn([process.execPath, import.meta.path, "terminal-child", marker], {
		stdio: ["inherit", "inherit", "inherit"],
		detached: true,
	});
	if (!(await waitForArmed())) process.exit(2);
	if (mode === "exit") process.kill(process.pid, "SIGKILL");
	setTimeout(() => {}, BLOCK_MS);
} else if (role === undefined) {
	const child = Bun.spawn([process.execPath, import.meta.path, "child"], {
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
