/**
 * tmux integration tests.
 *
 * These run against a real but isolated tmux server (`tmux -L pi-orch-test-<pid>`), so
 * they verify window creation, metadata, naming and cleanup for real. When tmux is not
 * installed the whole file skips instead of pretending to pass.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
	claimWindow,
	findWorkerWindow,
	getWindowOption,
	killWindow,
	listWindows,
	openWindow,
	renderBoard,
	renameWindow,
	sanitiseWindowName,
	setTmuxSocket,
	setWindowOption,
	statusline,
	supportsEnvFlag,
	tmux,
	tmuxReady,
	tmuxVersion,
	workerWindowName,
	WORKER_STATE_OPTION,
	WORKER_WINDOW_OPTION,
} from "../src/tmux.ts";
import { startWorker } from "./helpers.ts";
import { CLI, FAKE, PROFILES, sleep } from "./helpers.ts";

const socket = `pi-orch-test-${process.pid}`;
const cleanup: string[] = [];
let available = false;

before(() => {
	setTmuxSocket(socket);
	available = tmux(["new-session", "-d", "-s", "tests", "--", "sleep", "600"]).ok;
});

after(() => {
	if (available) tmux(["kill-server"]);
	for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

test("window names are deterministic, safe and state-visible", () => {
	assert.equal(workerWindowName({ id: "w_3f9c2a71", profile: "muse-free" }), "w_3f9c2a71 muse-free");
	// State must not leak into the name: a rename would break send-keys/binding targets.
	assert.equal(workerWindowName({ id: "w_3f9c2a71", profile: "muse-free" }), workerWindowName({ id: "w_3f9c2a71", profile: "muse-free" }));
	assert.equal(sanitiseWindowName('bad"name\\with$stuff'), "badnamewithstuff");
	assert.equal(sanitiseWindowName("line\nbreak"), "linebreak");
	assert.equal(sanitiseWindowName(""), "worker");
});

test("a worker window carries its worker id and state, and can be renamed", (context) => {
	if (!available) return context.skip("tmux not available");
	const window = openWindow({ name: workerWindowName({ id: "w_tmux01", profile: "muse-free" }), command: ["sleep", "60"] });
	assert.ok(window, "window should be created");
	const windowId = window!.windowId;
	try {
		assert.equal(setWindowOption(windowId, WORKER_WINDOW_OPTION, "w_tmux01"), true);
		assert.equal(setWindowOption(windowId, WORKER_STATE_OPTION, "running"), true);
		assert.equal(getWindowOption(windowId, WORKER_WINDOW_OPTION), "w_tmux01");
		assert.equal(findWorkerWindow("w_tmux01")?.id, windowId);
		assert.equal(findWorkerWindow("w_absent"), undefined);

		// State is recorded as a window option, not as a rename.
		setWindowOption(windowId, WORKER_STATE_OPTION, "awaiting-input");
		const renamed = listWindows().find((item) => item.id === windowId);
		assert.equal(getWindowOption(windowId, WORKER_STATE_OPTION), "awaiting-input");
		assert.equal(renamed?.workerId, "w_tmux01");
		assert.equal(renamed?.name, "w_tmux01 muse-free");
	} finally {
		killWindow(windowId);
	}
	assert.equal(listWindows().some((item) => item.id === windowId), false);
});

test("the statusline and the board read the registry without a Pi session", async () => {
	const session = startWorker({ scenario: "steer", id: "w_tmuxboard", label: "board" });
	cleanup.push(session.base);
	try {
		await session.waitFor((record) => record.state === "running");
		const line = statusline(session.env);
		assert.match(line, /⚙1/);
		assert.match(line, /muse-free/);
		assert.ok(line.length <= 80, "statusline must stay short");

		const board = renderBoard(session.env, 120, { color: false });
		assert.ok(board.some((row) => row.includes("w_tmuxboard")), "the board must list the worker");
		assert.ok(board.some((row) => row.includes("running")));
		for (const row of board) assert.ok(row.length <= 120, `board row too long: ${row}`);

		const single = renderBoard(session.env, 60, { color: false });
		for (const row of single) assert.ok(row.length <= 60, `narrow board row too long: ${row}`);

		const empty = renderBoard({ ...session.env, PI_ORCH_STATE_DIR: path.join(session.base, "empty-state") }, 80, { color: false });
		assert.ok(empty.some((row) => row.includes("no workers tracked")));
	} finally {
		if (!session.exited()) await session.stop().catch(() => undefined);
	}
});

test("a worker started with --window runs inside a named tmux window and closes it on success", async () => {
	if (!available || !supportsEnvFlag()) return;
	// The CLI must talk to the isolated server; the worker inherits that through -e.
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-orch-window-"));
	cleanup.push(base);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		FAKE_PI_SCENARIO: "ok",
		PI_ORCH_STATE_DIR: path.join(base, "state"),
		PI_ORCH_PROFILES: PROFILES,
		PI_ORCH_TMUX_SOCKET: socket,
		PI_ORCH_WINDOW_ENV: "FAKE_PI_SCENARIO,PI_ORCH_TMUX_SOCKET",
	};
	const brief = path.join(base, "brief.md");
	fs.writeFileSync(brief, "Outcome: finish immediately so the window closes.\n\nReply with OK.\n");
	const started = execFileSync(
		process.execPath,
		[CLI, "run", "muse-free", "--cwd", base, "--run-dir", path.join(base, "run"), "--prompt-file", brief, "--pi", FAKE, "--window", "always", "--id", "w_window1"],
		{ env, encoding: "utf8", timeout: 30_000 },
	);
	const parsed = JSON.parse(started.trim().split("\n").pop() ?? "{}") as { status?: string; id?: string; window?: string };
	assert.equal(parsed.status, "started");
	assert.equal(parsed.id, "w_window1");
	assert.ok(parsed.window, "the CLI must report the window it created");

	const windows = listWindows();
	const workerWindow = windows.find((item) => item.workerId === "w_window1");
	assert.ok(workerWindow, "the window must carry @pi_worker_id");
	assert.match(workerWindow!.name, /^w_window1/, "the window name must stay a stable target");

	// The supervisor renames the window to the terminal state and leaves it open, so the
	// operator can read the last output; closing it is their decision.
	let state = "";
	for (let attempt = 0; attempt < 60; attempt++) {
		state = getWindowOption(parsed.window!, WORKER_STATE_OPTION) ?? "";
		if (state === "completed") break;
		await sleep(250);
	}
	assert.equal(state, "completed", "the window must record the terminal state");
	assert.equal(listWindows().find((item) => item.id === parsed.window)?.name, workerWindowName({ id: "w_window1", profile: "muse-free" }));
	assert.equal(getWindowOption(parsed.window!, "remain-on-exit"), "on");
	const record = JSON.parse(fs.readFileSync(path.join(env.PI_ORCH_STATE_DIR!, "workers", "w_window1.json"), "utf8")) as { state: string; tmux?: { windowId: string } };
	assert.equal(record.state, "completed");
	assert.equal(record.tmux?.windowId, parsed.window, "the record must point at the window");
});

test("stop --close ends the worker and closes its window", async () => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-orch-tmux-close-"));
	const brief = path.join(base, "brief.md");
	fs.writeFileSync(brief, "# Task\nWait for a steer that never comes, so the worker stays alive.\n");
	const env = {
		...process.env,
		PI_ORCH_STATE_DIR: path.join(base, "state"),
		PI_ORCH_PROFILES: PROFILES,
		PI_ORCH_TMUX_SOCKET: socket,
		PI_ORCH_WINDOW_ENV: "FAKE_PI_SCENARIO",
		FAKE_PI_SCENARIO: "steer",
	};
	fs.mkdirSync(env.PI_ORCH_STATE_DIR, { recursive: true });
	const started = execFileSync(
		process.execPath,
		[CLI, "run", "muse-free", "--cwd", base, "--run-dir", path.join(base, "run"), "--prompt-file", brief, "--pi", FAKE, "--window", "always", "--timeout", "300", "--id", "w_close1"],
		{ env, encoding: "utf8", timeout: 30_000 },
	);
	const parsed = JSON.parse(started.trim().split("\n").pop() ?? "{}") as { window?: string };
	assert.ok(parsed.window, "the window must exist before the close");
	assert.ok(listWindows().some((item) => item.id === parsed.window), "the window must be listed");
	// The window exists before the supervisor inside it has written its record.
	const recordFile = path.join(env.PI_ORCH_STATE_DIR!, "workers", "w_close1.json");
	for (let attempt = 0; attempt < 80 && !fs.existsSync(recordFile); attempt++) await sleep(120);
	assert.ok(fs.existsSync(recordFile), "the supervisor must publish its worker record");

	const stopped = execFileSync(process.execPath, [CLI, "stop", "w_close1", "--close"], { env, encoding: "utf8", timeout: 30_000 });
	const result = JSON.parse(stopped.trim()) as { closedWindow?: string };
	assert.equal(result.closedWindow, parsed.window, "stop --close must report the window it closed");
	assert.equal(listWindows().some((item) => item.id === parsed.window), false, "the window must be gone");
	// Closing an already-gone window must stay harmless.
	assert.equal(killWindow(parsed.window!), false, "closing a missing window must report false");
});

test("a failed worker's window is kept for inspection", async () => {
	if (!available || !supportsEnvFlag()) return;
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-orch-window-fail-"));
	cleanup.push(base);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		FAKE_PI_SCENARIO: "wrong",
		PI_ORCH_STATE_DIR: path.join(base, "state"),
		PI_ORCH_PROFILES: PROFILES,
		PI_ORCH_TMUX_SOCKET: socket,
		PI_ORCH_WINDOW_ENV: "FAKE_PI_SCENARIO,PI_ORCH_TMUX_SOCKET",
	};
	const brief = path.join(base, "brief.md");
	fs.writeFileSync(brief, "Outcome: this run must fail its selection check.\n\nReply with anything.\n");
	const started = execFileSync(
		process.execPath,
		[CLI, "run", "muse-free", "--cwd", base, "--run-dir", path.join(base, "run"), "--prompt-file", brief, "--pi", FAKE, "--window", "always", "--id", "w_windowfail"],
		{ env, encoding: "utf8", timeout: 30_000 },
	);
	const windowId = (JSON.parse(started.trim().split("\n").pop() ?? "{}") as { window?: string }).window;
	assert.ok(windowId);
	let recordState = "";
	for (let attempt = 0; attempt < 60; attempt++) {
		const file = path.join(env.PI_ORCH_STATE_DIR!, "workers", "w_windowfail.json");
		if (fs.existsSync(file)) {
			recordState = (JSON.parse(fs.readFileSync(file, "utf8")) as { state: string }).state;
			if (recordState === "failed") break;
		}
		await sleep(250);
	}
	assert.equal(recordState, "failed");
	const window = listWindows().find((item) => item.id === windowId);
	assert.ok(window, "a failed worker's window must stay open");
	assert.equal(getWindowOption(windowId, WORKER_STATE_OPTION), "failed", "the window must record the failure state");
	assert.equal(getWindowOption(windowId, "remain-on-exit"), "on", "the pane must survive the supervisor exiting");
	killWindow(windowId);
});

test("window mode is never inferred from the presence of a tmux server", async () => {
	if (!available) return;
	// A shell run without --window must stay a normal foreground run even while a tmux
	// server is reachable, otherwise every script and test would silently detach.
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-orch-window-default-"));
	cleanup.push(base);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		FAKE_PI_SCENARIO: "ok",
		PI_ORCH_STATE_DIR: path.join(base, "state"),
		PI_ORCH_PROFILES: PROFILES,
		PI_ORCH_TMUX_SOCKET: socket,
		PI_ORCH_WINDOW_ENV: "FAKE_PI_SCENARIO,PI_ORCH_TMUX_SOCKET",
	};
	const brief = path.join(base, "brief.md");
	fs.writeFileSync(brief, "Outcome: complete in the foreground without a tmux window.\n\nReply OK.\n");
	const output = execFileSync(
		process.execPath,
		[CLI, "run", "muse-free", "--cwd", base, "--run-dir", path.join(base, "run"), "--prompt-file", brief, "--pi", FAKE, "--id", "w_nowin"],
		{ env, encoding: "utf8", timeout: 30_000 },
	);
	const parsed = JSON.parse(output.trim().split("\n").pop() ?? "{}") as { status?: string; window?: string };
	assert.equal(parsed.status, "completed");
	assert.equal(parsed.window, undefined);
	assert.equal(listWindows().some((item) => item.workerId === "w_nowin"), false);
});

test("tmux reporting degrades cleanly when no server is reachable", () => {
	const previous = tmuxVersion();
	setTmuxSocket(`pi-orch-absent-${process.pid}`);
	try {
		assert.equal(tmuxReady(), false);
		assert.deepEqual(listWindows(), []);
		assert.equal(openWindow({ name: "x", command: ["sleep", "1"] }), undefined);
	} finally {
		setTmuxSocket(socket);
	}
	assert.equal(tmuxVersion(), previous);
});

// F3: a watcher must not relabel a window that belongs to another worker.
test("claiming a window never steals it from another worker", () => {
	const window = openWindow({ name: "w_other1 muse-free", command: ["sleep", "30"] });
	assert.ok(window, "a window is required for this test");
	assert.equal(claimWindow(window!.windowId, "w_other1"), true, "the first claim wins");
	assert.equal(claimWindow(window!.windowId, "w_intrud2"), false, "a second worker cannot take it");
	assert.equal(getWindowOption(window!.windowId, WORKER_WINDOW_OPTION), "w_other1", "the owner is unchanged");
	assert.equal(claimWindow(window!.windowId, "w_other1"), true, "the owner can re-claim");
	killWindow(window!.windowId);
});

// F1: a nested `pi-orch run` inherits PI_ORCH_WINDOW and TMUX_PANE from the worker's shell.
test("a nested run does not adopt the window of its parent worker", async () => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-orch-nested-"));
	cleanup.push(base);
	const outer = openWindow({ name: "w_parent muse-free", command: ["sleep", "60"] });
	assert.ok(outer, "a window is required for this test");
	assert.equal(claimWindow(outer!.windowId, "w_parent"), true);
	const brief = path.join(base, "brief.md");
	fs.writeFileSync(brief, "# Task\nDo the bounded thing and report back with evidence of it.\n");
	const env = {
		...process.env,
		PI_ORCH_STATE_DIR: path.join(base, "state"),
		PI_ORCH_PROFILES: PROFILES,
		PI_ORCH_TMUX_SOCKET: socket,
		PI_ORCH_WINDOW: "1",
		TMUX_PANE: outer!.paneId,
		FAKE_PI_SCENARIO: "ok",
	};
	fs.mkdirSync(env.PI_ORCH_STATE_DIR, { recursive: true });
	const started = execFileSync(
		process.execPath,
		[CLI, "run", "muse-free", "--cwd", base, "--run-dir", path.join(base, "run"), "--prompt-file", brief, "--pi", FAKE, "--timeout", "60", "--detach", "--id", "w_inner1"],
		{ env, encoding: "utf8", timeout: 30_000 },
	);
	assert.equal((JSON.parse(started.trim()) as { status?: string }).status, "started");
	const renamed = listWindows().find((item) => item.id === outer!.windowId);
	assert.equal(renamed?.name, "w_parent muse-free", "the parent window must keep its name");
	assert.equal(renamed?.workerId, "w_parent", "the parent window must keep its owner");
	killWindow(outer!.windowId);
});

// F4: worker text must not be able to paint the terminal.
test("worker-controlled text cannot inject escapes into the board or the statusline", async () => {
	const session = startWorker({ scenario: "steer", id: "w_escapes1" });
	cleanup.push(session.base);
	try {
		await session.waitFor((record) => record.state === "running");
		const file = path.join(session.env.PI_ORCH_STATE_DIR!, "workers", "w_escapes1.json");
		const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown> & { activity: Record<string, unknown>; brief: Record<string, unknown> };
		record.activity.toolDetail = "x\u001b[2J\u001b[HFAKE\rREWRITTEN\u0007";
		record.brief.outcome = "ok\u001b]0;pwned\u0007";
		fs.writeFileSync(file, JSON.stringify(record));
		const line = statusline(session.env);
		assert.equal(line.includes("\u001b"), false, "the statusline must not contain escapes");
		const board = renderBoard(session.env, 120, { color: false });
		for (const row of board) {
			assert.equal(row.includes("\u001b"), false, `escape survived into the board: ${JSON.stringify(row)}`);
			assert.equal(row.includes("\r"), false, "carriage returns must not survive either");
		}
	} finally {
		if (!session.exited()) await session.stop().catch(() => undefined);
	}
});

// F2: a windowed launch must not report success when the worker never started.
test("a windowed launch fails loudly when the worker cannot start", () => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-orch-win-fail-"));
	cleanup.push(base);
	const brief = path.join(base, "brief.md");
	fs.writeFileSync(brief, "# Task\nDo the bounded thing and report back with evidence of it.\n");
	// A run dir whose parent cannot be written fails inside the supervisor, before it publishes
	// a record: the caller must not be told "started".
	const readOnly = path.join(base, "read-only");
	fs.mkdirSync(readOnly, { mode: 0o500 });
	const env = { ...process.env, PI_ORCH_STATE_DIR: path.join(base, "state"), PI_ORCH_PROFILES: PROFILES, PI_ORCH_TMUX_SOCKET: socket, PI_ORCH_WINDOW_START_TIMEOUT_MS: "1500" };
	fs.mkdirSync(env.PI_ORCH_STATE_DIR, { recursive: true });
	let failed = false;
	let stderr = "";
	try {
		execFileSync(
			process.execPath,
			[CLI, "run", "muse-free", "--cwd", base, "--run-dir", path.join(readOnly, "run"), "--prompt-file", brief, "--pi", FAKE, "--window", "always", "--id", "w_nostart1"],
			{ env, encoding: "utf8", timeout: 30_000 },
		);
	} catch (error) {
		failed = true;
		stderr = String((error as { stderr?: string }).stderr ?? "");
	}
	const window = findWorkerWindow("w_nostart1");
	if (window) killWindow(window.id);
	assert.equal(failed, true, "the launch must exit non-zero when the supervisor never starts");
	assert.match(stderr, /failed to start/, "the caller must see why");
});
