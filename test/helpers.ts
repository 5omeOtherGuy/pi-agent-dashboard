/**
 * Test helpers: run the real CLI as a background supervisor and talk to it over
 * the real control socket.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { sendControl } from "../src/control.ts";
import { readRecord, recordPath } from "../src/registry.ts";
import type { ControlRequest, ControlResponse, WorkerRecord } from "../src/protocol.ts";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const CLI = path.join(ROOT, "bin", "pi-orch.mjs");
export const FAKE = path.join(ROOT, "test", "fake-pi.mjs");
export const PROFILES = path.join(ROOT, "test", "profiles.json");

export interface WorkerSessionOptions {
	scenario?: string;
	prompt?: string;
	profile?: string;
	tools?: string;
	thinking?: string;
	timeoutSeconds?: number;
	id?: string;
	extraArgs?: string[];
	base?: string;
	stateDir?: string;
	env?: NodeJS.ProcessEnv;
	label?: string;
}

export interface WorkerSession {
	id: string;
	base: string;
	runDir: string;
	stateDir: string;
	child: ChildProcess;
	env: NodeJS.ProcessEnv;
	record(): WorkerRecord | undefined;
	waitFor(predicate: (record: WorkerRecord) => boolean, timeoutMs?: number): Promise<WorkerRecord>;
	control(request: ControlRequest, timeoutMs?: number): Promise<ControlResponse>;
	controlAs(request: ControlRequest, by: string, timeoutMs?: number): Promise<ControlResponse>;
	stop(): Promise<ControlResponse>;
	stdout(): string;
	stderr(): string;
	exited(): boolean;
	waitExit(timeoutMs?: number): Promise<number>;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

let counter = 0;

export function startWorker(options: WorkerSessionOptions = {}): WorkerSession {
	const base = options.base ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-orch-bg-"));
	const stateDir = options.stateDir ?? path.join(base, "state");
	const runDir = path.join(base, "run");
	const brief = path.join(base, "brief.md");
	fs.mkdirSync(base, { recursive: true });
	const id = options.id ?? `w_test${++counter}${Date.now().toString(36).slice(-4)}`;
	fs.writeFileSync(brief, options.prompt ?? "Complete the bounded task described here for the supervisor test.");
	const args = [
		CLI,
		"run",
		options.profile ?? "muse-free",
		"--cwd",
		base,
		"--run-dir",
		runDir,
		"--prompt-file",
		brief,
		"--pi",
		FAKE,
		"--id",
		id,
		"--timeout",
		String(options.timeoutSeconds ?? 60),
	];
	if (options.tools) args.push("--tools", options.tools);
	if (options.thinking) args.push("--thinking", options.thinking);
	if (options.label) args.push("--label", options.label);
	args.push(...(options.extraArgs ?? []));
	const env: NodeJS.ProcessEnv = {
		...process.env,
		FAKE_PI_SCENARIO: options.scenario ?? "ok",
		PI_ORCH_STATE_DIR: stateDir,
		PI_ORCH_PROFILES: PROFILES,
		PI_SESSION_ID: "session-under-test",
		...options.env,
	};
	const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	let err = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		out += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		err += chunk.toString();
	});
	const session: WorkerSession = {
		id,
		base,
		runDir,
		stateDir,
		child,
		env,
		record: () => readRecord(id, env),
		waitFor: async (predicate, timeoutMs = 8000) => {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const record = readRecord(id, env);
				if (record && predicate(record)) return record;
				if (Date.now() > deadline) {
					throw new Error(`timed out waiting for worker ${id} state; last=${JSON.stringify(record?.state)} phase=${JSON.stringify(record?.phase)} err=${err}`);
				}
				await sleep(50);
			}
		},
		control: (request, timeoutMs = 10_000) => sendControl(socketFor(id, env), request, { timeoutMs }),
		controlAs: (request, by, timeoutMs = 10_000) => sendControl(socketFor(id, env), { ...request, by }, { timeoutMs }),
		stop: async () => {
			const record = readRecord(id, env);
			if (!record) throw new Error("no record to stop");
			return sendControl(record.supervisor.socket, { cmd: "stop" }, { timeoutMs: 10_000 });
		},
		stdout: () => out,
		stderr: () => err,
		exited: () => child.exitCode !== null,
		waitExit: (timeoutMs = 15_000) =>
			new Promise<number>((resolve, reject) => {
				if (child.exitCode !== null) {
					resolve(child.exitCode);
					return;
				}
				const timer = setTimeout(() => reject(new Error(`worker did not exit: ${err}`)), timeoutMs);
				child.once("exit", (code) => {
					clearTimeout(timer);
					resolve(code ?? 0);
				});
			}),
	};
	return session;
}

export function socketFor(id: string, env: NodeJS.ProcessEnv): string {
	return recordPath(id, env).replace(/\.json$/, ".ctl.sock");
}

export function auditLines(stateDir: string): Array<Record<string, unknown>> {
	const file = path.join(stateDir, "audit.jsonl");
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}
