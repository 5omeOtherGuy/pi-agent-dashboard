/**
 * Cross-process behaviour: a worker started by one session is visible to, and
 * controllable from, another. Also covers brief/log enforcement, admission control
 * and detached supervisors.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readRecord } from "../src/registry.ts";
import { auditLines, CLI, FAKE, PROFILES, sleep, socketFor, startWorker } from "./helpers.ts";

const cleanup: string[] = [];
after(() => {
	for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

const WRITER_BRIEF = [
	"Outcome: hold the workspace and wait for instructions.",
	"",
	"| Observable criterion | Verification method | Owner | Result |",
	"|---|---|---|---|",
	"| the parser rejects empty keys | unit test in test/parser.test.ts | worker | pass |",
	"",
].join("\n");

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	cleanup.push(dir);
	return dir;
}

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(process.execPath, [CLI, ...args], { env, timeout: 30_000 }, (error, stdout, stderr) => {
			const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -1) : 0;
			resolve({ code, stdout, stderr });
		});
	});
}

test("a running worker is visible to, and steerable from, another session", async () => {
	const session = startWorker({ scenario: "steer", id: "w_visible1", label: "lead" });
	try {
		const running = await session.waitFor((record) => record.state === "running");
		assert.equal(running.worker.profile, "muse-free");
		assert.equal(running.worker.thinking, "high");
		assert.equal(running.worker.model, "muse-spark-1.3-contributor-free");
		assert.equal(running.host.label, "lead");
		assert.equal(running.host.sessionId, "session-under-test");
		assert.ok((running.worker.pid ?? 0) > 0);

		// Another session sees the same worker through the registry alone.
		const otherEnv = { ...session.env, PI_SESSION_ID: "another-session" };
		const listed = await run(["list", "--json"], otherEnv);
		const summaries = JSON.parse(listed.stdout) as Array<{ id: string; state: string; hostLabel: string }>;
		assert.equal(summaries.length, 1);
		assert.equal(summaries[0]?.id, "w_visible1");

		const steered = await session.controlAs({ cmd: "steer", message: "prefer the small diff" }, "another-session");
		assert.equal(steered.ok, true, steered.error);
		await session.waitFor((record) => record.controls.steers === 1 && record.controls.lastSteerBy === "another-session");
		const steerLog = path.join(session.base, "steer.log");
		for (let attempt = 0; attempt < 60 && !fs.existsSync(steerLog); attempt++) await sleep(50);
		assert.equal(fs.readFileSync(steerLog, "utf8").trim(), "prefer the small diff");

		const followUp = await session.controlAs({ cmd: "follow_up", message: "then summarize" }, "another-session");
		assert.equal(followUp.ok, true, followUp.error);
		await session.waitFor((record) => record.controls.followUps === 1);

		const audit = auditLines(session.stateDir);
		assert.ok(
			audit.some((entry) => entry.action === "steer" && entry.by === "another-session"),
			"steering must be attributed in the audit trail",
		);

		const stopped = await session.controlAs({ cmd: "stop" }, "another-session");
		assert.equal(stopped.ok, true, stopped.error);
		assert.equal(await session.waitExit(), 1);
		const final = await session.waitFor((record) => record.state === "stopped");
		assert.equal(final.result?.status, "stopped");
		assert.match(final.result?.text ?? "", /steer/);
	} finally {
		if (!session.exited()) await session.stop().catch(() => undefined);
	}
});

test("a rejected steer fails the control call but not the run", async () => {
	const session = startWorker({ scenario: "steer_rejected", id: "w_reject_steer", label: "lead" });
	try {
		await session.waitFor((record) => record.state === "running");
		const rejected = await session.controlAs({ cmd: "steer", message: "not allowed yet" }, "another-session");
		assert.equal(rejected.ok, false, "a rejected steer must not be reported as delivered");
		assert.match(rejected.error ?? "", /steer not allowed here/);
		assert.equal(session.record()?.state, "running", "the run must keep running after a rejected steer");

		// The control channel must still work for a steer Pi accepts.
		const accepted = await session.controlAs({ cmd: "steer", message: "go ahead now" }, "another-session");
		assert.equal(accepted.ok, true, accepted.error);

		assert.equal(await session.waitExit(), 0, session.stderr());
		const final = await session.waitFor((record) => record.state === "completed");
		assert.equal(final.result?.status, "completed");
		const result = JSON.parse(fs.readFileSync(path.join(session.runDir, "result.json"), "utf8")) as { status?: string };
		assert.equal(result.status, "completed", "result.json must still be written after a rejected steer");
		assert.match(final.result?.text ?? "", /recovering from rejected steer/);
		assert.equal(final.controls.steers, 1, "only the accepted steer counts as delivered");
		assert.equal(final.controls.rejections, 1);
		assert.match(final.controls.lastRejectionError ?? "", /steer not allowed here/);

		const audit = auditLines(session.stateDir);
		assert.ok(
			audit.some((entry) => entry.action === "steer_rejected" && String(entry.detail ?? "").includes("steer not allowed here")),
			"a rejected steer must be recorded in the audit trail",
		);
	} finally {
		if (!session.exited()) await session.stop().catch(() => undefined);
	}
});

test("a rejected follow-up fails the control call but not the run", async () => {
	const session = startWorker({ scenario: "follow_up_rejected", id: "w_reject_followup", label: "lead" });
	try {
		await session.waitFor((record) => record.state === "running");
		const rejected = await session.controlAs({ cmd: "follow_up", message: "later" }, "another-session");
		assert.equal(rejected.ok, false, "a rejected follow-up must not be reported as delivered");
		assert.match(rejected.error ?? "", /follow_up not allowed here/);

		assert.equal(await session.waitExit(), 0, session.stderr());
		const final = await session.waitFor((record) => record.state === "completed");
		assert.equal(final.result?.status, "completed");
		assert.match(final.result?.text ?? "", /rejected follow-up/);
		assert.equal(final.controls.followUps, 0, "a rejected follow-up must not count as delivered");
		assert.equal(final.controls.rejections, 1);
		assert.ok(auditLines(session.stateDir).some((entry) => entry.action === "follow_up_rejected"));
	} finally {
		if (!session.exited()) await session.stop().catch(() => undefined);
	}
});

test("an answer with no pending question fails the control call but not the run", async () => {
	const session = startWorker({ scenario: "steer", id: "w_answer_nopending", label: "lead" });
	try {
		await session.waitFor((record) => record.state === "running");
		const rejected = await session.control({ cmd: "answer", value: "yes" });
		assert.equal(rejected.ok, false, "answering with no pending question must not be reported as delivered");
		assert.match(rejected.error ?? "", /not waiting for input/);
		assert.equal(session.record()?.state, "running", "the run must keep running after a rejected answer");

		const steered = await session.controlAs({ cmd: "steer", message: "still responsive" }, "another-session");
		assert.equal(steered.ok, true, steered.error);
		await session.stop();
		assert.equal(await session.waitExit(), 1);
		const final = await session.waitFor((record) => record.state === "stopped");
		assert.equal(final.result?.status, "stopped");
	} finally {
		if (!session.exited()) await session.stop().catch(() => undefined);
	}
});

test("an unexpected rejection of an answer does not kill the run", async () => {
	// Pi does not acknowledge extension_ui_response, but a Pi build that does must not be able to
	// turn its rejection into a run failure: it is recorded as a control call that failed.
	const session = startWorker({ scenario: "answer_rejected", id: "w_answer_nack", extraArgs: ["--input", "park"] });
	try {
		await session.waitFor((record) => record.state === "awaiting-input");
		await session.control({ cmd: "answer", value: "yes" });

		assert.equal(await session.waitExit(), 0, session.stderr());
		const final = await session.waitFor((record) => record.state === "completed");
		assert.equal(final.result?.status, "completed");
		assert.match(final.result?.text ?? "", /rejected answer/);
		assert.equal(final.controls.rejections, 1);
		assert.match(final.controls.lastRejectionError ?? "", /answer not allowed here/);
		assert.ok(auditLines(session.stateDir).some((entry) => entry.action === "answer_rejected"));
	} finally {
		if (!session.exited()) await session.stop().catch(() => undefined);
	}
});

test("a parked worker publishes its question and resumes with the answer", async () => {
	const session = startWorker({ scenario: "input_park", id: "w_park1", extraArgs: ["--input", "park"] });
	try {
		const parked = await session.waitFor((record) => record.state === "awaiting-input");
		assert.equal(parked.pendingInput?.method, "select");
		assert.equal(parked.pendingInput?.title, "Pick one");
		assert.deepEqual(parked.pendingInput?.options, ["alpha", "beta"]);

		const answered = await session.control({ cmd: "answer", value: "beta" });
		assert.equal(answered.ok, true, answered.error);
		assert.equal(await session.waitExit(), 0, session.stderr());
		const final = await session.waitFor((record) => record.state === "completed");
		assert.equal(final.result?.status, "completed");
		assert.match(final.result?.text ?? "", /chose:beta/);
	} finally {
		if (!session.exited()) await session.stop().catch(() => undefined);
	}
});

test("a worker that asks for input fails by default", async () => {
	const session = startWorker({ scenario: "interactive", id: "w_input_fail" });
	assert.equal(await session.waitExit(), 1);
	const final = readRecord("w_input_fail", session.env);
	assert.equal(final?.state, "failed");
	assert.match(final?.error ?? "", /interactive input/i);
});

test("writers need a definition-of-done table; readers do not", async () => {
	const base = tempDir("pi-orch-brief-");
	const env = { ...process.env, FAKE_PI_SCENARIO: "ok", PI_ORCH_STATE_DIR: path.join(base, "state"), PI_ORCH_PROFILES: PROFILES };
	const brief = path.join(base, "brief.md");
	fs.writeFileSync(brief, "Outcome: make the parser reject empty keys.\n\nImplement it in src/parser.ts and report back.\n");
	const common = ["run", "muse-free", "--cwd", base, "--prompt-file", brief, "--pi", FAKE];

	const rejected = await run([...common, "--run-dir", path.join(base, "run1"), "--tools", "write"], env);
	assert.equal(rejected.code, 1);
	assert.match(rejected.stderr, /Brief rejected/);
	assert.match(rejected.stderr, /definition-of-done/);

	fs.writeFileSync(brief, `${fs.readFileSync(brief, "utf8")}\n${WRITER_BRIEF.split("\n").slice(2).join("\n")}\n`);
	const accepted = await run([...common, "--run-dir", path.join(base, "run2"), "--tools", "write"], env);
	assert.equal(accepted.code, 0, accepted.stderr);
	const report = JSON.parse(fs.readFileSync(path.join(base, "run2", "result.json"), "utf8")) as { brief?: { dod?: number } };
	assert.equal(report.brief?.dod, 1);

	const reader = await run([...common, "--run-dir", path.join(base, "run3"), "--tools", "read"], env);
	assert.equal(reader.code, 0, reader.stderr);
});

test("the engineering log is scaffolded and checked at handoff", async () => {
	const base = tempDir("pi-orch-log-");
	const env = { ...process.env, FAKE_PI_SCENARIO: "ok", PI_ORCH_STATE_DIR: path.join(base, "state"), PI_ORCH_PROFILES: PROFILES };
	const brief = path.join(base, "brief.md");
	const log = path.join(base, "log.md");
	fs.writeFileSync(brief, "Outcome: inspect the parser and report findings.\n\nReturn findings and the log path.\n");
	const common = ["run", "muse-free", "--cwd", base, "--prompt-file", brief, "--pi", FAKE, "--log", log];

	const first = await run([...common, "--run-dir", path.join(base, "run1")], env);
	assert.equal(first.code, 0, first.stderr);
	assert.ok(fs.existsSync(log), "the log must be scaffolded before the worker starts");
	const firstReport = JSON.parse(fs.readFileSync(path.join(base, "run1", "result.json"), "utf8")) as { log?: { log: string } };
	assert.equal(firstReport.log?.log, "empty");

	fs.writeFileSync(
		log,
		[
			"# Engineering log",
			"",
			"- **Actions Taken:** read src/parser.ts and ran the focused parser test to confirm the current behaviour and failure mode.",
			"- **Issues & Friction:** the fixture used a stale key name, so the first run passed for the wrong reason; corrected against source.",
			"- **Decisions & Rationale:** kept the existing error type because callers switch on it; changing it would break the CLI path.",
			"- **Solutions Applied:** added the explicit empty-key check and verified it with the unit test, which fails before and passes after.",
			"- **Insights:** the parser silently accepted an empty key because the guard ran after normalisation rather than before it.",
			"",
		].join("\n"),
	);
	const second = await run([...common, "--run-dir", path.join(base, "run2")], env);
	assert.equal(second.code, 0, second.stderr);
	const secondReport = JSON.parse(fs.readFileSync(path.join(base, "run2", "result.json"), "utf8")) as { log?: { log: string } };
	assert.equal(secondReport.log?.log, "ok");
});

test("admission control refuses a crowded or shared workspace", async () => {
	const base = tempDir("pi-orch-admit-");
	const running = startWorker({ scenario: "steer", id: "w_hold1", tools: "write", prompt: WRITER_BRIEF, base, stateDir: path.join(base, "state") });
	try {
		await running.waitFor((record) => record.state === "running");
		const common = ["run", "muse-free", "--cwd", base, "--prompt-file", path.join(base, "brief.md"), "--pi", FAKE];
		// The admission checks only need the registry to be shared; the launched worker
		// must still be the fast scenario rather than the one holding the slot.
		const env = { ...running.env, FAKE_PI_SCENARIO: "ok" };

		const capped = await run([...common, "--run-dir", path.join(base, "run-cap"), "--max-parallel", "1", "--allow-shared-cwd"], env);
		assert.equal(capped.code, 1);
		assert.match(capped.stderr, /already active/);

		const shared = await run([...common, "--run-dir", path.join(base, "run-shared"), "--tools", "write"], env);
		assert.equal(shared.code, 1);
		assert.match(shared.stderr, /already owns/);

		const allowed = await run([...common, "--run-dir", path.join(base, "run-allowed"), "--tools", "write", "--allow-shared-cwd"], env);
		assert.equal(allowed.code, 0, allowed.stderr);
	} finally {
		if (!running.exited()) await running.stop().catch(() => undefined);
	}
});

test("writer isolation is per workspace, not per repository", async () => {
	const root = tempDir("pi-orch-worktree-");
	const stateDir = path.join(root, "state");
	const wt = path.join(root, "wt-a");
	fs.mkdirSync(wt);
	const first = startWorker({ scenario: "steer", id: "w_wt_a", tools: "write", prompt: WRITER_BRIEF, base: wt, stateDir });
	try {
		await first.waitFor((record) => record.state === "running");
		const second = startWorker({ scenario: "ok", id: "w_wt_b", tools: "write", prompt: WRITER_BRIEF, base: path.join(root, "wt-b"), stateDir });
		assert.equal(await second.waitExit(), 0);
		assert.equal(readRecord("w_wt_b", second.env)?.state, "completed");
	} finally {
		if (!first.exited()) await first.stop().catch(() => undefined);
	}
});

test("a detached supervisor keeps running and stays controllable", async () => {
	const base = tempDir("pi-orch-detach-");
	const env = { ...process.env, FAKE_PI_SCENARIO: "steer", PI_ORCH_STATE_DIR: path.join(base, "state"), PI_ORCH_PROFILES: PROFILES };
	const brief = path.join(base, "brief.md");
	fs.writeFileSync(brief, WRITER_BRIEF);
	const started = await run(
		[
			"run", "muse-free", "--cwd", base, "--run-dir", path.join(base, "run"), "--prompt-file", brief,
			"--pi", FAKE, "--detach", "--id", "w_detached1", "--label", "detached-lead", "--tools", "write",
		],
		env,
	);
	assert.equal(started.code, 0, started.stderr);
	const parsed = JSON.parse(started.stdout) as { status: string; id: string };
	assert.equal(parsed.status, "started");
	assert.equal(parsed.id, "w_detached1");

	let record = readRecord("w_detached1", env);
	for (let attempt = 0; attempt < 80 && record?.state !== "running"; attempt++) {
		await sleep(100);
		record = readRecord("w_detached1", env);
	}
	assert.equal(record?.state, "running");

	const { sendControl } = await import("../src/control.ts");
	const steered = await sendControl(socketFor("w_detached1", env), { cmd: "steer", message: "report only", by: "tester" });
	assert.equal(steered.ok, true, steered.error);
	const stopped = await sendControl(socketFor("w_detached1", env), { cmd: "stop", by: "tester" });
	assert.equal(stopped.ok, true, stopped.error);
	for (let attempt = 0; attempt < 80; attempt++) {
		if (readRecord("w_detached1", env)?.state === "stopped") break;
		await sleep(100);
	}
	const final = readRecord("w_detached1", env);
	assert.equal(final?.state, "stopped");
	assert.ok(final?.endedAt);
});

test("a detached launch reports brief problems to the caller", async () => {
	const base = tempDir("pi-orch-detach-bad-");
	const env = { ...process.env, FAKE_PI_SCENARIO: "ok", PI_ORCH_STATE_DIR: path.join(base, "state"), PI_ORCH_PROFILES: PROFILES };
	const brief = path.join(base, "brief.md");
	fs.writeFileSync(brief, "Outcome: far too short for a writer brief.\n");
	const started = await run(
		["run", "muse-free", "--cwd", base, "--run-dir", path.join(base, "run"), "--prompt-file", brief, "--pi", FAKE, "--tools", "write", "--detach"],
		env,
	);
	assert.equal(started.code, 1);
	assert.match(started.stderr, /Brief rejected/);
	assert.equal(fs.existsSync(path.join(base, "run")), false, "a rejected brief must not leave a run directory");
});

test("a signalled supervisor stops its worker instead of orphaning it", async () => {
	const session = startWorker({ scenario: "steer", id: "w_signal1" });
	try {
		await session.waitFor((record) => record.state === "running");
		const workerPid = session.record()?.worker.pid ?? 0;
		assert.ok(workerPid > 0);
		session.child.kill("SIGTERM");
		const code = await session.waitExit();
		assert.equal(code, 1, session.stderr());
		const final = await session.waitFor((record) => ["stopped", "failed"].includes(record.state));
		assert.equal(final.state, "stopped");
		assert.match(final.error ?? "", /signal:SIGTERM/);
		let alive = true;
		for (let attempt = 0; attempt < 40 && alive; attempt++) {
			try {
				process.kill(workerPid, 0);
				await sleep(100);
			} catch {
				alive = false;
			}
		}
		assert.equal(alive, false, "the worker process must be reaped when the supervisor is signalled");
	} finally {
		if (!session.exited()) session.child.kill("SIGKILL");
	}
});

test("stale records are recognised and cleaned", async () => {
	const base = tempDir("pi-orch-stale-");
	const env = { ...process.env, PI_ORCH_STATE_DIR: path.join(base, "state") };
	const workers = path.join(base, "state", "workers");
	fs.mkdirSync(workers, { recursive: true, mode: 0o700 });
	const old = new Date(Date.now() - 3_600_000).toISOString();
	fs.writeFileSync(
		path.join(workers, "w_stale1.json"),
		JSON.stringify({
			version: 1,
			id: "w_stale1",
			state: "running",
			phase: "tool",
			createdAt: old,
			updatedAt: old,
			heartbeatAt: old,
			host: { cwd: base, label: "gone" },
			supervisor: { pid: 999_999, socket: path.join(workers, "w_stale1.ctl.sock"), cli: CLI },
			worker: { profile: "muse-free", provider: "opencode", model: "m", thinking: "high", tools: "read", cwd: base, sessionFile: "/tmp/s.jsonl", trust: "saved" },
			brief: { path: "/tmp/b.md", bytes: 1, sha256: "x", excerpt: "x", definitionOfDone: [], checks: [] },
			runDir: base,
			deadline: { seconds: 60, expiresAt: old },
			activity: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0, toolCalls: 0, toolErrors: 0 },
			controls: { steers: 0, followUps: 0 },
		}),
	);
	const listed = await run(["list", "--json"], env);
	const summaries = JSON.parse(listed.stdout) as Array<{ id: string; state: string }>;
	assert.equal(summaries[0]?.state, "stale");

	const cleaned = await run(["clean", "--older-than", "60"], env);
	assert.match(cleaned.stdout, /w_stale1/);
	assert.equal(fs.existsSync(path.join(workers, "w_stale1.json")), false);
});
