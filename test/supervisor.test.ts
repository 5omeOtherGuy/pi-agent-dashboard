/**
 * Contract tests for the supervisor.
 *
 * These are the behavioural guarantees the orchestration skill relied on: exact
 * selection before inference, a real deadline, process-group reaping, LF-only
 * framing, and one run directory per attempt. The fake Pi speaks the real RPC shape.
 */

import { execFile, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { preflight } from "../src/supervisor.ts";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, "bin", "pi-orch.mjs");
const FAKE = path.join(ROOT, "test", "fake-pi.mjs");

interface InvokeOptions {
	scenario?: string;
	profile?: string;
	thinking?: string;
	prompt?: string;
	tools?: string;
	timeoutSeconds?: number;
	command?: "run" | "check";
	session?: "existing" | "missing";
	lockHolder?: "live" | "dead";
	log?: string;
	extraArgs?: string[];
	detached?: boolean;
}

interface Report {
	status?: string;
	text?: string;
	error?: string;
	selection?: { model?: string };
	profile?: string;
	prompt_sent?: boolean;
	pi_reaped?: boolean;
	log?: { log: string; detail?: string };
	brief?: { dod?: number };
}

interface InvokeResult {
	code: number;
	stdout: string;
	stderr: string;
	report: Report;
	base: string;
	record: Record<string, unknown> | undefined;
	run: string;
	cleaned?: boolean;
}

const cleanup: string[] = [];
after(() => {
	for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

async function invoke(options: InvokeOptions = {}): Promise<InvokeResult> {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-orch-test-"));
	cleanup.push(base);
	const stateDir = path.join(base, "state");
	const runDir = path.join(base, "run");
	const brief = path.join(base, "brief.md");
	const scenario = options.scenario ?? "ok";
	fs.writeFileSync(brief, options.prompt ?? "Complete the bounded task described here for the contract test.");

	const args = [
		CLI,
		options.command ?? "run",
		options.profile ?? "muse-free",
		"--cwd",
		base,
		"--run-dir",
		runDir,
		"--prompt-file",
		brief,
		"--pi",
		FAKE,
		"--timeout",
		String(options.timeoutSeconds ?? 8),
	];
	if (options.thinking) args.push("--thinking", options.thinking);
	if (options.tools) args.push("--tools", options.tools);
	if (options.log) args.push("--log", options.log);
	if (options.session === "existing") {
		const session = path.join(base, "existing.jsonl");
		fs.writeFileSync(session, "");
		args.push("--session", session);
	}
	if (options.session === "missing") args.push("--session", path.join(base, "absent.jsonl"));
	args.push(...(options.extraArgs ?? []));

	let lockHandle: number | undefined;
	if (options.lockHolder) {
		const session = path.join(base, "existing.jsonl");
		if (!fs.existsSync(session)) fs.writeFileSync(session, "");
		fs.writeFileSync(`${session}.lock`, `${JSON.stringify({ pid: options.lockHolder === "live" ? process.pid : 999_999, id: "w_other" })}\n`);
	}

	const env = { ...process.env, FAKE_PI_SCENARIO: scenario, PI_ORCH_STATE_DIR: stateDir, PI_ORCH_PROFILES: path.join(ROOT, "test", "profiles.json") };
	const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
		execFile(process.execPath, args, { env, timeout: 40_000 }, (error, stdout, stderr) => {
			const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 0;
			resolve({ code, stdout, stderr });
		});
	});

	const resultFile = path.join(runDir, "result.json");
	const report: Report = fs.existsSync(resultFile) ? (JSON.parse(fs.readFileSync(resultFile, "utf8")) as Report) : {};
	report.prompt_sent = fs.existsSync(path.join(base, "prompt-used"));
	const fakePidFile = path.join(base, "fake.pid");
	if (fs.existsSync(fakePidFile)) {
		const pid = Number(fs.readFileSync(fakePidFile, "utf8"));
		try {
			process.kill(pid, 0);
			report.pi_reaped = false;
		} catch {
			report.pi_reaped = true;
		}
	}
	const records = fs.existsSync(path.join(stateDir, "workers")) ? fs.readdirSync(path.join(stateDir, "workers")).filter((name) => name.endsWith(".json")) : [];
	const record = records.length > 0 ? (JSON.parse(fs.readFileSync(path.join(stateDir, "workers", records[0]!), "utf8")) as Record<string, unknown>) : undefined;
	return { ...result, report, base, record, run: runDir };
}

// Reusing a run dir used to fail only inside the worker (invisible for --detach/--window).
// A missing workspace used to reach spawn() and kill the caller with an uncaughtException.
test("a workspace that does not exist yet is created, not fatal", async () => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-orch-workspace-"));
	const prompt = path.join(base, "brief.md");
	fs.writeFileSync(prompt, "# Task\nCreate the workspace and report back with evidence of it.\n");
	const cwd = path.join(base, "fresh", "workspace");
	const env = { ...process.env, PI_ORCH_STATE_DIR: path.join(base, "state"), PI_ORCH_PROFILES: path.join(ROOT, "test", "profiles.json"), FAKE_PI_SCENARIO: "ok" };
	const started = execFileSync(
		process.execPath,
		[CLI, "run", "muse-free", "--cwd", cwd, "--run-dir", path.join(base, "run"), "--prompt-file", prompt, "--pi", FAKE, "--timeout", "60", "--detach", "--id", "w_fresh1"],
		{ env, encoding: "utf8", timeout: 30_000 },
	);
	assert.equal((JSON.parse(started.trim()) as { status?: string }).status, "started");
	assert.ok(fs.existsSync(cwd), "the workspace directory must exist after the run");
	const recordFile = path.join(env.PI_ORCH_STATE_DIR, "workers", "w_fresh1.json");
	for (let attempt = 0; attempt < 100; attempt++) {
		if (fs.existsSync(recordFile) && (JSON.parse(fs.readFileSync(recordFile, "utf8")) as { state: string }).state !== "running") break;
		await new Promise((resolve) => setTimeout(resolve, 120));
	}
});

test("preflight refuses a run dir that already holds a run", () => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-orch-reused-"));
	const prompt = path.join(base, "brief.md");
	fs.writeFileSync(prompt, "# Task\nDo the thing and report back with evidence of it.\n");
	const runDir = path.join(base, "run");
	fs.mkdirSync(runDir, { recursive: true });
	assert.doesNotThrow(() => preflight({ cwd: base, runDir, promptFile: prompt, env: { ...process.env, PI_ORCH_STATE_DIR: path.join(base, "state") } } as never));
	fs.writeFileSync(path.join(runDir, "events.jsonl"), "{}\n");
	assert.throws(
		() => preflight({ cwd: base, runDir, promptFile: prompt, env: { ...process.env, PI_ORCH_STATE_DIR: path.join(base, "state") } } as never),
		/already holds a run/,
	);
});

test("large unicode prompt survives LF-only framing", async () => {
	const prompt = `${"Context\u2028\n".repeat(20_000)}END_7D39ABCD`;
	const result = await invoke({ prompt });
	assert.equal(result.code, 0, result.stderr + result.stdout);
	assert.equal(result.report.status, "completed");
	assert.equal(result.report.text, `${prompt.length}:${prompt.slice(-12)}`);
	assert.equal(result.report.pi_reaped, true);
});

test("selection mismatch stops before the prompt is sent", async () => {
	for (const scenario of ["wrong", "effort"]) {
		const result = await invoke({ scenario });
		assert.notEqual(result.code, 0, scenario);
		assert.match(result.report.error ?? "", /selection/i);
		assert.equal(result.report.prompt_sent, false, scenario);
	}
});

test("error, empty, fallback, rejection, interactive, post-mismatch, exit and compaction fail", async () => {
	for (const scenario of ["error", "empty", "fallback", "rejected", "interactive", "post_mismatch", "exit", "compacting"]) {
		const result = await invoke({ scenario });
		assert.notEqual(result.code, 0, `${scenario}: ${result.stdout}`);
		assert.equal(result.report.status, "failed", scenario);
		assert.ok(result.report.error, `${scenario} needs an error message`);
	}
});

test("deadline is enforced and the worker is reaped", async () => {
	const result = await invoke({ scenario: "timeout", timeoutSeconds: 0.6 });
	assert.notEqual(result.code, 0);
	assert.equal(result.report.status, "timeout");
	assert.equal(result.report.pi_reaped, true);
});

test("prompt transport under backpressure cannot extend the deadline", async () => {
	const result = await invoke({ scenario: "backpressure", prompt: "large prompt ".repeat(100_000), timeoutSeconds: 0.6 });
	assert.notEqual(result.code, 0);
	assert.equal(result.report.status, "timeout");
	assert.equal(result.report.pi_reaped, true);
});

test("startup failures still produce a result file", async () => {
	const missingBinary = await invoke({ extraArgs: ["--pi", path.join(os.tmpdir(), "does-not-exist-pi")] });
	assert.notEqual(missingBinary.code, 0);
	assert.equal(missingBinary.report.status, "failed");
	assert.ok(missingBinary.report.error);

	const locked = await invoke({ session: "existing", lockHolder: "live" });
	assert.notEqual(locked.code, 0);
	assert.match(locked.report.error ?? "", /owned by another worker|locked/i);

	const absent = await invoke({ session: "missing" });
	assert.notEqual(absent.code, 0);
	assert.match(absent.report.error ?? "", /does not exist/i);
});

test("an abandoned session lock is reclaimed", async () => {
	const result = await invoke({ session: "existing", lockHolder: "dead" });
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.report.status, "completed");
});

test("provider retry after agent_end still completes", async () => {
	const result = await invoke({ scenario: "retry" });
	assert.equal(result.code, 0, result.stderr + result.stdout);
	assert.equal(result.report.status, "completed");
});

test("check verifies readiness without inference", async () => {
	const result = await invoke({ command: "check" });
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.report.status, "ready");
	assert.equal(result.report.prompt_sent, false);
});

test("profile policy is enforced before launch, and mapped models resolve", async () => {
	const denied = await invoke({ profile: "glm-high", thinking: "medium" });
	assert.notEqual(denied.code, 0);
	assert.match(denied.stderr, /not allowed/i);

	const mapped = await invoke({ profile: "gemini-restricted", thinking: "high" });
	assert.equal(mapped.code, 0, mapped.stderr);
	assert.equal(mapped.report.selection?.model, "gemini-3.8-flash-high");
});
