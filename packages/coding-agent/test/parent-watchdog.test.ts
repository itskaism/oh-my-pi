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

	// An interactive omp whose parent and terminal went away was left running
	// as a PPID-1 orphan, its endless shell read still growing: the hangup
	// either never reached it or its teardown never exited. The watchdog of a
	// terminal's process acts only once the parent AND the terminal are gone:
	// SIGHUP for the process's own teardown, then SIGKILL after the grace
	// (1.5 s in the fixture). Each case runs the fixture on a pty of its own.
	describe.skipIf(process.platform === "win32")("with a terminal", () => {
		// Real time: the watchdog under test runs in other processes, on their
		// own clocks, so neither the poll below nor the "stays alive" windows
		// can use fake timers.
		const STAYS_MS = 4_000;

		async function onTerminal(mode: "exit" | "stay") {
			const marker = path.join(os.tmpdir(), `parent-watchdog-tty-${process.pid}-${Date.now()}-${mode}`);
			const middle = Bun.spawn([process.execPath, FIXTURE, "terminal-middle", marker, mode], {
				terminal: { cols: 80, rows: 24, data() {} },
			});
			const read = () => (fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "");
			const end = Date.now() + 10_000;
			while (!read().includes("armed") && Date.now() < end) await Bun.sleep(20);
			const childPid = Number(/armed (\d+)/.exec(read())?.[1]);
			const child = Number.isInteger(childPid) ? Process.fromPid(childPid) : null;
			const cleanup = () => {
				child?.killTree();
				middle.kill("SIGKILL");
				middle.terminal?.close();
				fs.rmSync(marker, { force: true });
			};
			return { middle, child, read, cleanup };
		}

		it("hangs up, then kills, an orphan once its terminal is gone", async () => {
			const { middle, child, read, cleanup } = await onTerminal("exit");
			try {
				expect(child).not.toBeNull();
				await middle.exited;
				expect(middle.signalCode).toBe("SIGKILL");
				middle.terminal?.close();
				expect(await child!.waitForExit({ timeoutMs: 8_000 })).toBe(true);
				expect(read()).toContain("hup\n");
			} finally {
				cleanup();
			}
		}, 20_000);

		it("keeps an orphan whose terminal is still open", async () => {
			const { middle, child, read, cleanup } = await onTerminal("exit");
			try {
				expect(child).not.toBeNull();
				await middle.exited;
				expect(middle.signalCode).toBe("SIGKILL");
				expect(await child!.waitForExit({ timeoutMs: STAYS_MS })).toBe(false);
				expect(read()).not.toContain("hup");
				// The terminal going away then ends it.
				middle.terminal?.close();
				expect(await child!.waitForExit({ timeoutMs: 8_000 })).toBe(true);
			} finally {
				cleanup();
			}
		}, 20_000);

		it("keeps a process whose parent is alive after its terminal is gone", async () => {
			const { middle, child, read, cleanup } = await onTerminal("stay");
			try {
				expect(child).not.toBeNull();
				middle.terminal?.close();
				expect(await child!.waitForExit({ timeoutMs: STAYS_MS })).toBe(false);
				expect(read()).not.toContain("hup");
				// The parent exiting then ends it.
				middle.kill("SIGKILL");
				expect(await child!.waitForExit({ timeoutMs: 8_000 })).toBe(true);
			} finally {
				cleanup();
			}
		}, 20_000);
	});
});
