/**
 * Admission control: the machine-wide cap and the one-writer-per-workspace rule are
 * reservations, not registry reads.
 *
 * The defect these tests lock down: `preflight()` read the registry, so two spawns in the
 * same instant both saw a free machine and both took the last slot. Every test here puts
 * the rules under real contention - several processes, or a reservation that outlives its
 * owner - rather than repeating a read.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acquireAdmission, admissionsDir } from "../src/admission.ts";
import { readRecord } from "../src/registry.ts";
import type { WorkerRecord } from "../src/protocol.ts";
import { CLI, FAKE, PROFILES, sleep, startWorker } from "./helpers.ts";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ADMISSION_MODULE = pathToFileURL(path.join(ROOT, "src", "admission.ts")).href;
const CAP_FLAGS = ["--max-parallel", "1", "--tools", "write", "--allow-shared-cwd"];

const WRITER_BRIEF = [
	"Outcome: hold the workspace and wait for instructions.",
	"",
	"| Observable criterion | Verification method | Owner | Result |",
	"|---|---|---|---|",
	"| the parser rejects empty keys | unit test in test/parser.test.ts | worker | pass |",
	"",
].join("\n");

const cleanup: string[] = [];
const children: ChildProcess[] = [];
after(() => {
	for (const child of children) {
		if (child.exitCode === null) child.kill("SIGKILL");
	}
	for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	cleanup.push(dir);
	return dir;
}

function env(stateDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return { ...process.env, PI_ORCH_STATE_DIR: stateDir, PI_ORCH_PROFILES: PROFILES, ...extra };
}

interface ReservationFile {
	file: string;
	pid?: number;
	id?: string;
	cwd?: string;
	tools?: string;
}

/** Every live or stranded reservation in the state directory, gate lock excluded. */
function reservations(stateDir: string): ReservationFile[] {
	const dir = admissionsDir(env(stateDir));
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	return names
		.filter((name) => name.endsWith(".lock") && name !== "gate.lock")
		.map((name) => {
			const file = path.join(dir, name);
			try {
				return { file, ...(JSON.parse(fs.readFileSync(file, "utf8")) as object) } as ReservationFile;
			} catch {
				return { file };
			}
		});
}

/** A pid that certainly does not exist: a child that has already been reaped. */
async function deadPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	children.push(child);
	const pid = child.pid ?? 0;
	await new Promise<void>((resolve) => child.once("exit", () => resolve()));
	return pid;
}

function writeReservation(stateDir: string, name: string, contents: Record<string, unknown>): string {
	const dir = admissionsDir(env(stateDir));
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = path.join(dir, name);
	fs.writeFileSync(file, `${JSON.stringify(contents)}\n`, { mode: 0o600 });
	return file;
}

test("a slot is reserved: a second admission is refused until the first releases", () => {
	const base = tempDir("pi-orch-admit-slot-");
	const stateDir = path.join(base, "state");
	const cwd = path.join(base, "ws");
	fs.mkdirSync(cwd, { recursive: true });
	const common = { cwd, maxParallel: 1, env: env(stateDir) };

	const first = acquireAdmission({ ...common, id: "w_first", tools: "write" });
	assert.equal(fs.existsSync(first.path), true);
	assert.equal(reservations(stateDir).length, 1);
	// The reservation names its owner, so a stranded one can be diagnosed.
	assert.equal(reservations(stateDir)[0]?.pid, process.pid);
	assert.equal(reservations(stateDir)[0]?.id, "w_first");
	// The admissions directory is private, like the rest of the state directory.
	assert.equal(fs.statSync(admissionsDir(env(stateDir))).mode & 0o777, 0o700);

	assert.throws(() => acquireAdmission({ ...common, id: "w_second", tools: "read" }), /already active/);
	// A refused admission must not strand a reservation of its own.
	assert.equal(reservations(stateDir).length, 1);

	first.release();
	first.release();
	assert.equal(fs.existsSync(first.path), false);
	assert.equal(reservations(stateDir).length, 0);

	const second = acquireAdmission({ ...common, id: "w_second", tools: "read" });
	assert.equal(reservations(stateDir).length, 1);
	second.release();
	assert.equal(reservations(stateDir).length, 0);
});

test("one writer per workspace is reserved before the run starts", () => {
	const base = tempDir("pi-orch-admit-writer-");
	const stateDir = path.join(base, "state");
	const cwd = path.join(base, "ws");
	const otherCwd = path.join(base, "other");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(otherCwd, { recursive: true });
	const e = env(stateDir);

	const writer = acquireAdmission({ id: "w_writer", cwd, tools: "write", env: e });
	assert.throws(() => acquireAdmission({ id: "w_rival", cwd, tools: "write", env: e }), /writer w_writer already owns/);

	// A reader is not a writer, another workspace is not this one, and the explicit
	// opt-out still wins.
	acquireAdmission({ id: "w_reader", cwd, tools: "read", env: e }).release();
	acquireAdmission({ id: "w_elsewhere", cwd: otherCwd, tools: "write", env: e }).release();
	acquireAdmission({ id: "w_shared", cwd, tools: "write", allowSharedCwd: true, env: e }).release();
	assert.equal(reservations(stateDir).length, 1, "only the first writer's reservation remains");

	writer.release();
	assert.equal(reservations(stateDir).length, 0);
});

test("a reservation counts while its owner lives and is ignored once the owner is gone", async () => {
	const base = tempDir("pi-orch-admit-owner-");
	const stateDir = path.join(base, "state");
	const cwd = path.join(base, "ws");
	fs.mkdirSync(cwd, { recursive: true });
	const e = env(stateDir);

	// A live owner's reservation is as real as a running worker.
	const live = writeReservation(stateDir, "w_live.aaaaaaaa.lock", { pid: process.pid, id: "w_live", cwd, tools: "write", at: new Date().toISOString() });
	assert.throws(() => acquireAdmission({ id: "w_after_live", cwd, tools: "write", maxParallel: 1, env: e }), /already active/);
	assert.throws(() => acquireAdmission({ id: "w_after_live", cwd, tools: "write", env: e }), /writer w_live already owns/);
	fs.rmSync(live, { force: true });

	// A supervisor killed without cleanup strands nothing: the next admission takes the
	// slot and sweeps the abandoned file.
	const gone = writeReservation(stateDir, "w_dead.bbbbbbbb.lock", { pid: await deadPid(), id: "w_dead", cwd, tools: "write", at: new Date().toISOString() });
	const next = acquireAdmission({ id: "w_next", cwd, tools: "write", maxParallel: 1, env: e });
	assert.equal(fs.existsSync(gone), false, "the abandoned reservation must be swept");
	assert.equal(reservations(stateDir).length, 1);
	next.release();

	// An unreadable file (owner died between create and write) is dead too.
	const partial = writeReservation(stateDir, "w_partial.cccccccc.lock", {});
	assert.equal(fs.readFileSync(partial, "utf8").trim(), "{}");
	const after = acquireAdmission({ id: "w_after_partial", cwd, tools: "write", maxParallel: 1, env: e });
	assert.equal(fs.existsSync(partial), false);
	after.release();
});

interface RaceResult {
	index: number;
	won: boolean;
	error: string;
}

/**
 * Start `count` processes that try to take the same constrained resource at the same
 * instant. Each one holds its reservation until every process has had its attempt, so
 * the outcome depends only on admission control, not on scheduling.
 */
async function raceAdmission(options: { stateDir: string; cwd: string; tools: string; maxParallel?: number; count?: number }): Promise<RaceResult[]> {
	const count = options.count ?? 6;
	const base = tempDir("pi-orch-admit-race-");
	const resultDir = path.join(base, "results");
	fs.mkdirSync(resultDir, { recursive: true });
	const script = path.join(base, "child.mjs");
	fs.writeFileSync(
		script,
		[
			'import * as fs from "node:fs";',
			`import { acquireAdmission } from ${JSON.stringify(ADMISSION_MODULE)};`,
			"const config = JSON.parse(process.argv[2]);",
			"const sleeper = new Int32Array(new SharedArrayBuffer(4));",
			"const waitUntil = (at) => { while (Date.now() < at) Atomics.wait(sleeper, 0, 0, 1); };",
			"waitUntil(config.startAt);",
			"let won = false;",
			'let error = "";',
			"try {",
			"\tconst admission = acquireAdmission({ id: config.id, cwd: config.cwd, tools: config.tools, maxParallel: config.maxParallel, env: { ...process.env, PI_ORCH_STATE_DIR: config.stateDir } });",
			"\twon = true;",
			"\t// Hold the reservation until every other contender has recorded its attempt.",
			"\tconst deadline = Date.now() + 10_000;",
			"\twhile (Date.now() < deadline && fs.readdirSync(config.resultDir).length < config.count - 1) Atomics.wait(sleeper, 0, 0, 5);",
			"\tadmission.release();",
			"} catch (caught) {",
			"\terror = caught instanceof Error ? caught.message : String(caught);",
			"}",
			'fs.writeFileSync(config.resultFile, `${JSON.stringify({ won, error })}\\n`);',
			"",
		].join("\n"),
	);
	const startAt = Date.now() + 600;
	const resultFiles = Array.from({ length: count }, (_, index) => path.join(resultDir, `${index}.json`));
	const spawned: ChildProcess[] = [];
	for (let index = 0; index < count; index++) {
		const config = {
			id: `w_race_${index}`,
			cwd: options.cwd,
			tools: options.tools,
			maxParallel: options.maxParallel,
			stateDir: options.stateDir,
			resultDir,
			resultFile: resultFiles[index],
			startAt,
			count,
		};
		const child = spawn(process.execPath, [script, JSON.stringify(config)], { stdio: "ignore" });
		children.push(child);
		spawned.push(child);
	}
	await Promise.all(
		spawned.map(
			(child) =>
				new Promise<void>((resolve) => {
					child.once("exit", () => resolve());
				}),
		),
	);
	return resultFiles.map((file, index) => {
		const raw = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as { won: boolean; error: string }) : { won: false, error: "(child produced no result)" };
		return { index, ...raw };
	});
}

test("simultaneous admissions for one constrained resource yield exactly one winner", async () => {
	const base = tempDir("pi-orch-admit-contention-");
	const stateDir = path.join(base, "state");
	const cwd = path.join(base, "ws");
	fs.mkdirSync(cwd, { recursive: true });

	const capped = await raceAdmission({ stateDir, cwd, tools: "read", maxParallel: 1 });
	const capWinners = capped.filter((result) => result.won);
	assert.equal(capWinners.length, 1, `expected one winner for max-parallel 1, got ${JSON.stringify(capped)}`);
	for (const loser of capped.filter((result) => !result.won)) assert.match(loser.error, /already active/);
	assert.equal(reservations(stateDir).length, 0, "every child must release its reservation before it exits");

	const writers = await raceAdmission({ stateDir, cwd, tools: "write" });
	const writerWinners = writers.filter((result) => result.won);
	assert.equal(writerWinners.length, 1, `expected one writer for one workspace, got ${JSON.stringify(writers)}`);
	for (const loser of writers.filter((result) => !result.won)) assert.match(loser.error, /already owns/);
	assert.equal(reservations(stateDir).length, 0);
});

interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

function cliRun(options: { base: string; stateDir: string; id: string; scenario: string; timeoutSeconds?: number; extraArgs?: string[] }): Promise<CliResult> {
	const args = [
		CLI,
		"run",
		"muse-free",
		"--cwd",
		options.base,
		"--run-dir",
		path.join(options.base, `run-${options.id}`),
		"--prompt-file",
		path.join(options.base, "brief.md"),
		"--pi",
		FAKE,
		"--id",
		options.id,
		"--timeout",
		String(options.timeoutSeconds ?? 30),
		...(options.extraArgs ?? []),
	];
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			args,
			{ env: env(options.stateDir, { FAKE_PI_SCENARIO: options.scenario }), timeout: 40_000 },
			(error, stdout, stderr) => {
				const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -1) : 0;
				resolve({ code, stdout, stderr });
			},
		);
	});
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(50);
	}
	return predicate();
}

function recordState(id: string, stateDir: string): WorkerRecord["state"] | undefined {
	return readRecord(id, env(stateDir))?.state;
}

test("two simultaneous CLI launches for one slot: exactly one is admitted", async () => {
	const root = tempDir("pi-orch-admit-cli-race-");
	const stateDir = path.join(root, "state");
	fs.writeFileSync(path.join(root, "brief.md"), WRITER_BRIEF);
	const first = startWorker({ scenario: "steer", id: "w_cli_a", base: path.join(root, "a"), stateDir, tools: "write", prompt: WRITER_BRIEF, extraArgs: CAP_FLAGS });
	const second = startWorker({ scenario: "steer", id: "w_cli_b", base: path.join(root, "b"), stateDir, tools: "write", prompt: WRITER_BRIEF, extraArgs: CAP_FLAGS });
	const launches = [first, second];
	try {
		const decided = await waitFor(() => {
			const exited = launches.filter((launch) => launch.exited()).length;
			// Two running records means the race was lost by admission control itself, not by a
			// launch; report that now instead of waiting for a refusal that never comes.
			const running = launches.filter((launch) => recordState(launch.id, stateDir) === "running").length;
			return exited >= 1 || running >= 2;
		});
		assert.ok(decided, "neither launch was refused or admitted");

		const losers = launches.filter((launch) => launch.exited());
		assert.equal(losers.length, 1, `exactly one launch must be refused; stdout: ${launches.map((l) => l.stdout()).join(" | ")}`);
		const loser = losers[0]!;
		assert.equal(await loser.waitExit(), 1);
		assert.match(loser.stderr(), /already active/);
		const result = JSON.parse(fs.readFileSync(path.join(loser.runDir, "result.json"), "utf8")) as { status?: string; error?: string };
		assert.equal(result.status, "failed");
		assert.match(result.error ?? "", /already active/);

		const winner = loser === first ? second : first;
		assert.ok(await waitFor(() => recordState(winner.id, stateDir) === "running"), "the admitted launch must be running");
		assert.equal(reservations(stateDir).length, 1, "only the admitted run holds a reservation");

		await winner.stop();
		assert.equal(await winner.waitExit(), 1);
		assert.equal(reservations(stateDir).length, 0, "a stopped run must release its reservation");
	} finally {
		for (const launch of launches) if (!launch.exited()) launch.child.kill("SIGKILL");
	}
});

test("a run releases its slot on success, failure and timeout", async () => {
	const base = tempDir("pi-orch-admit-release-");
	const stateDir = path.join(base, "state");
	fs.writeFileSync(path.join(base, "brief.md"), WRITER_BRIEF);
	const run = (id: string, scenario: string, timeoutSeconds?: number): Promise<CliResult> =>
		cliRun({ base, stateDir, id, scenario, timeoutSeconds, extraArgs: CAP_FLAGS });

	const ok = await run("w_rel_ok", "ok");
	assert.equal(ok.code, 0, ok.stderr);
	assert.equal(reservations(stateDir).length, 0, "a completed run must release its reservation");

	// A failed run must not hold the slot it reserved.
	const failed = await run("w_rel_fail", "error");
	assert.equal(failed.code, 1);
	const afterFailure = await run("w_rel_after_fail", "ok");
	assert.equal(afterFailure.code, 0, afterFailure.stderr);

	const timedOut = await run("w_rel_timeout", "timeout", 0.6);
	assert.equal(timedOut.code, 1);
	const result = JSON.parse(fs.readFileSync(path.join(base, "run-w_rel_timeout", "result.json"), "utf8")) as { status?: string };
	assert.equal(result.status, "timeout");
	const afterTimeout = await run("w_rel_after_timeout", "ok");
	assert.equal(afterTimeout.code, 0, afterTimeout.stderr);
	assert.equal(reservations(stateDir).length, 0);

	// Abort is the soft control path; the reservation is released on the way out too.
	const aborted = startWorker({ scenario: "steer", id: "w_rel_abort", base, stateDir, tools: "write", prompt: WRITER_BRIEF, extraArgs: CAP_FLAGS });
	await aborted.waitFor((record) => record.state === "running");
	assert.equal(reservations(stateDir).length, 1);
	await aborted.control({ cmd: "abort" });
	assert.notEqual(await aborted.waitExit(20_000), 0);
	const afterAbort = await run("w_rel_after_abort", "ok");
	assert.equal(afterAbort.code, 0, afterAbort.stderr);
	assert.equal(reservations(stateDir).length, 0);
});

test("a signalled supervisor releases its slot, and a killed one is reclaimed", async () => {
	const root = tempDir("pi-orch-admit-signal-");
	const stateDir = path.join(root, "state");
	fs.writeFileSync(path.join(root, "brief.md"), WRITER_BRIEF);

	// SIGTERM is handled once the worker is up: the supervisor stops it and releases in `finally`.
	const signalled = startWorker({ scenario: "steer", id: "w_signal1", base: path.join(root, "a"), stateDir, tools: "write", prompt: WRITER_BRIEF, extraArgs: CAP_FLAGS });
	await signalled.waitFor((record) => record.state === "running");
	assert.equal(reservations(stateDir).length, 1);
	signalled.child.kill("SIGTERM");
	assert.notEqual(await signalled.waitExit(20_000), 0);
	assert.equal(await waitFor(() => reservations(stateDir).length === 0), true, "SIGTERM must release the reservation");

	const next = await cliRun({ base: path.join(root, "a"), stateDir, id: "w_after_signal", scenario: "ok", extraArgs: CAP_FLAGS });
	assert.equal(next.code, 0, next.stderr);

	// SIGKILL cannot clean up: the stranded reservation is ignored and swept.
	const killed = startWorker({ scenario: "steer", id: "w_killed1", base: path.join(root, "b"), stateDir, tools: "write", prompt: WRITER_BRIEF, extraArgs: CAP_FLAGS });
	await killed.waitFor((record) => record.state === "running");
	assert.equal(reservations(stateDir).length, 1);
	killed.child.kill("SIGKILL");
	await killed.waitExit(20_000);
	assert.equal(reservations(stateDir).length, 1, "SIGKILL leaves the reservation file behind");
	const afterKill = await cliRun({ base: path.join(root, "b"), stateDir, id: "w_after_kill", scenario: "ok", extraArgs: CAP_FLAGS });
	assert.equal(afterKill.code, 0, afterKill.stderr);
	assert.equal(reservations(stateDir).length, 0, "the next admission must sweep the dead owner's reservation");
});
