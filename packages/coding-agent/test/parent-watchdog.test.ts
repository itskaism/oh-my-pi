import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";

const FIXTURE = path.join(import.meta.dir, "fixtures", "parent-watchdog-orphan.ts");

describe("startParentWatchdog", () => {
	// Issue #14340: an IPC worker whose main thread was pinned inside a
	// synchronous native call (onnxruntime inference) outlived its dead parent
	// as a multi-GiB PPID-1 orphan, because the parent-liveness watchdog ran on
	// that same starved event loop.
	it("kills an orphaned process whose main thread is blocked", async () => {
		const middle = Bun.spawn([process.execPath, FIXTURE], { stdout: "pipe", stderr: "inherit" });
		const childPid = Number.parseInt((await new Response(middle.stdout).text()).trim(), 10);
		await middle.exited;
		// The middle hard-killed itself after the child armed: a signal on POSIX,
		// TerminateProcess exit code 1 on Windows (the never-armed path exits 2).
		if (process.platform === "win32") expect(middle.exitCode).toBe(1);
		else expect(middle.signalCode).toBe("SIGKILL");

		const child = Process.fromPid(childPid);
		if (!child) return; // Already gone: the watchdog won the race.
		const exited = await child.waitForExit({ timeoutMs: 5_000 });
		if (!exited) child.killTree();
		expect(exited).toBe(true);
	}, 15_000);

	// An interactive omp whose terminal went away was left running as a PPID-1
	// orphan, its endless shell read still growing: the hangup either never
	// reached it or its teardown never exited. With a hangup grace the watchdog
	// raises SIGHUP for the process's own teardown, then kills it.
	it.skipIf(process.platform === "win32")(
		"raises SIGHUP, then kills an orphan whose hangup teardown never exits",
		async () => {
			const marker = path.join(os.tmpdir(), `parent-watchdog-hup-${process.pid}-${Date.now()}`);
			try {
				const middle = Bun.spawn([process.execPath, FIXTURE, "hangup", marker], {
					stdout: "pipe",
					stderr: "inherit",
				});
				const childPid = Number.parseInt((await new Response(middle.stdout).text()).trim(), 10);
				await middle.exited;
				expect(middle.signalCode).toBe("SIGKILL");

				const child = Process.fromPid(childPid);
				const exited = child ? await child.waitForExit({ timeoutMs: 8_000 }) : true;
				if (!exited) child?.killTree();
				expect(exited).toBe(true);
				expect(fs.readFileSync(marker, "utf8")).toBe("hup\n");
			} finally {
				fs.rmSync(marker, { force: true });
			}
		},
		15_000,
	);
});
