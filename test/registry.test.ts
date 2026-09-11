/**
 * Registry retention: `clean` must bound the registry (finished records age out)
 * without ever touching run artifacts, and must never remove live work.
 *
 * Records are written directly with `writeRecord` so age and supervisor pid are
 * fully controlled; the CLI cases exercise flag wiring and the JSON contract.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cleanRecords, narrowRecord, recordPath, socketPath, writeRecord } from "../src/registry.ts";
import type { WorkerRecord, WorkerState } from "../src/protocol.ts";
import { CLI } from "./helpers.ts";

const cleanup: string[] = [];
after(() => {
	for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

function tempState(): { env: NodeJS.ProcessEnv; base: string } {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-orch-registry-"));
	cleanup.push(base);
	return { env: { ...process.env, PI_ORCH_STATE_DIR: path.join(base, "state") }, base };
}

function ago(ms: number): string {
	return new Date(Date.now() - ms).toISOString();
}

/** A pid that has certainly exited: spawnSync reaps it before returning. */
function deadPid(): number {
	return spawnSync(process.execPath, ["-e", ""]).pid ?? 999_999;
}

function put(env: NodeJS.ProcessEnv, id: string, state: WorkerState, updatedAt: string, supervisorPid: number): WorkerRecord {
	const record = narrowRecord({
		id,
		state,
		createdAt: updatedAt,
		updatedAt,
		heartbeatAt: updatedAt,
		supervisor: { pid: supervisorPid, socket: socketPath(id, env) },
	});
	assert.ok(record, `narrowRecord must accept the test record ${id}`);
	writeRecord(record, env);
	return record;
}

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(process.execPath, [CLI, ...args], { env, timeout: 30_000 }, (error, stdout, stderr) => {
			const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -1) : 0;
			resolve({ code, stdout, stderr });
		});
	});
}

test("a finished record past the age gate is removed", () => {
	const { env } = tempState();
	put(env, "w_done_old", "completed", ago(2 * 3_600_000), deadPid());

	const result = cleanRecords(3_600_000, env);

	assert.deepEqual(result.removed, ["w_done_old"]);
	assert.deepEqual(result.kept, []);
	assert.equal(fs.existsSync(recordPath("w_done_old", env)), false);
});

test("a finished record newer than the age gate is kept", () => {
	const { env } = tempState();
	put(env, "w_done_new", "completed", ago(60_000), deadPid());

	const result = cleanRecords(3_600_000, env);

	assert.deepEqual(result.removed, []);
	assert.deepEqual(result.kept, ["w_done_new"]);
	assert.ok(fs.existsSync(recordPath("w_done_new", env)));
});

test("a running worker with a live supervisor is never removed", () => {
	const { env } = tempState();
	// Old heartbeat and a zero age gate would both trip the old retention logic;
	// a live supervisor pid must still protect the record.
	put(env, "w_running", "running", ago(2 * 3_600_000), process.pid);

	const result = cleanRecords(0, env);

	assert.deepEqual(result.removed, []);
	assert.deepEqual(result.kept, ["w_running"]);
	assert.ok(fs.existsSync(recordPath("w_running", env)));
});

test("a finished record whose supervisor pid is still alive is kept", () => {
	const { env } = tempState();
	put(env, "w_done_alive", "completed", ago(2 * 3_600_000), process.pid);

	const result = cleanRecords(0, env, { allTerminal: true });

	assert.deepEqual(result.removed, []);
	assert.deepEqual(result.kept, ["w_done_alive"]);
	assert.ok(fs.existsSync(recordPath("w_done_alive", env)));
});

test("all-terminal prunes every finished record regardless of age", () => {
	const { env } = tempState();
	put(env, "w_done_a", "completed", ago(60_000), deadPid());
	put(env, "w_done_b", "failed", ago(60_000), deadPid());
	put(env, "w_done_c", "stopped", ago(60_000), deadPid());
	put(env, "w_running", "running", ago(60_000), process.pid);
	put(env, "w_waiting", "awaiting-input", ago(60_000), deadPid());

	const result = cleanRecords(3_600_000, env, { allTerminal: true });

	assert.deepEqual(result.removed.toSorted(), ["w_done_a", "w_done_b", "w_done_c"]);
	assert.deepEqual(result.kept.toSorted(), ["w_running", "w_waiting"]);
	for (const id of result.removed) assert.equal(fs.existsSync(recordPath(id, env)), false);
	assert.ok(fs.existsSync(recordPath("w_running", env)));
	assert.ok(fs.existsSync(recordPath("w_waiting", env)));
});

test("an abandoned non-terminal record is still cleaned once it is stale and past the gate", () => {
	const { env } = tempState();
	// A crashed supervisor: dead pid, old heartbeat, state still "running".
	put(env, "w_abandoned", "running", ago(2 * 3_600_000), deadPid());

	const result = cleanRecords(3_600_000, env);

	assert.deepEqual(result.removed, ["w_abandoned"]);
	assert.deepEqual(result.kept, []);
});

test("clean removes only the registry entry and control socket, never run artifacts", () => {
	const { env, base } = tempState();
	const runDir = path.join(base, "run");
	fs.mkdirSync(runDir, { recursive: true });
	const events = path.join(runDir, "events.jsonl");
	const log = path.join(base, "worker.log");
	const session = path.join(base, "session.jsonl");
	fs.writeFileSync(events, "{}\n");
	fs.writeFileSync(log, "log\n");
	fs.writeFileSync(session, "{}\n");

	const record = put(env, "w_files", "completed", ago(2 * 3_600_000), deadPid());
	record.runDir = runDir;
	record.brief.path = path.join(base, "brief.md");
	record.brief.logPath = log;
	record.worker.sessionFile = session;
	writeRecord(record, env);
	fs.writeFileSync(socketPath("w_files", env), "");

	const result = cleanRecords(3_600_000, env);

	assert.deepEqual(result.removed, ["w_files"]);
	assert.equal(fs.existsSync(recordPath("w_files", env)), false, "the registry entry must be gone");
	assert.equal(fs.existsSync(socketPath("w_files", env)), false, "the control socket must be gone");
	assert.ok(fs.existsSync(runDir), "the run directory must survive");
	assert.equal(fs.readFileSync(events, "utf8"), "{}\n");
	assert.ok(fs.existsSync(log), "the log file must survive");
	assert.ok(fs.existsSync(session), "the session file must survive");
});

test("clean --help documents --all-terminal and the deletion scope", async () => {
	const { env } = tempState();

	const result = await run(["clean", "--help"], env);

	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stdout, /--all-terminal/);
	assert.match(result.stdout, /run director/i);
	assert.match(result.stdout, /socket/i);
	assert.match(result.stdout, /session file/i);
});

test("clean --json reports the deletion scope and the new flag works end to end", async () => {
	const { env } = tempState();
	put(env, "w_cli_done", "completed", ago(60_000), deadPid());
	put(env, "w_cli_live", "running", ago(2 * 3_600_000), process.pid);

	const aged = await run(["clean", "--older-than", "3600"], env);
	assert.equal(aged.code, 0, aged.stderr);
	const agedOut = JSON.parse(aged.stdout) as { removed: string[]; kept: string[]; scope: string };
	assert.deepEqual(agedOut.removed, []);
	assert.deepEqual(agedOut.kept.toSorted(), ["w_cli_done", "w_cli_live"]);
	assert.match(agedOut.scope, /run directories, logs and session files/i);

	const all = await run(["clean", "--all-terminal"], env);
	assert.equal(all.code, 0, all.stderr);
	const allOut = JSON.parse(all.stdout) as { removed: string[]; kept: string[]; scope: string };
	assert.deepEqual(allOut.removed, ["w_cli_done"]);
	assert.deepEqual(allOut.kept, ["w_cli_live"]);
	assert.equal(fs.existsSync(recordPath("w_cli_done", env)), false);
	assert.ok(fs.existsSync(recordPath("w_cli_live", env)));
});
