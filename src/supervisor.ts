/**
 * Worker supervisor.
 *
 * One process per worker. It owns the `pi --mode rpc` child, verifies the exact
 * model/effort selection before inference, enforces the wall-clock deadline
 * (including while a prompt is being written to a child that is not reading),
 * publishes a live record every dashboard on the machine can read, and serves the
 * control socket used to steer, stop, answer or resume the worker.
 *
 * The externally visible contract (argv, run-dir artifacts, exit codes) matches the
 * orchestration skill's previous helper; this port adds the registry, the control
 * channel and mechanical brief/log enforcement.
 */

import { spawn, type ChildProcess, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { checkLog, digestBrief, parseBrief, scaffoldLog, validateBrief, type ParsedBrief } from "./brief.ts";
import { acquireAdmission, activeWorkers, admissionRefusal } from "./admission.ts";
import { readConfig } from "./config.ts";
import { appendAudit, ensureStateDirs, newWorkerId, nowIso, pidAlive, RecordFile, recordPath } from "./registry.ts";
import { startControlServer, type ControlServer } from "./control.ts";
import {
	type ControlRequest,
	type InputPolicy,
	type LogCheck,
	type ToolSet,
	type WorkerRecord,
	type WorkspaceEvidence,
	RECORD_VERSION,
} from "./protocol.ts";
import { RpcClient, RpcError, TimeoutError, verifySelection, type RpcEvent, type RpcState, type Selection } from "./rpc.ts";
import { claimWindow, renameWindow, setWindowOption, workerWindowName, WORKER_STATE_OPTION, WORKER_WINDOW_OPTION } from "./tmux.ts";

export const TOOL_SETS: Record<ToolSet, string> = {
	read: "read,grep,find,ls",
	write: "read,grep,find,ls,bash,edit,write",
	none: "",
};

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export interface HostInfo {
	sessionId?: string;
	sessionFile?: string;
	cwd: string;
	label: string;
}

export interface RunOptions {
	command?: "run" | "check";
	id?: string;
	profile: string;
	selection: Selection;
	cwd: string;
	runDir: string;
	promptFile?: string;
	promptText?: string;
	session?: string;
	tools: ToolSet;
	trust: "saved" | "project" | "ignore";
	timeoutMs: number;
	pi: string;
	inputPolicy: InputPolicy;
	logPath?: string;
	host: HostInfo;
	env: NodeJS.ProcessEnv;
	maxParallel?: number;
	allowSharedCwd?: boolean;
	requireDod?: boolean;
	minBriefChars?: number;
	/** tmux window hosting this supervisor, when window mode is enabled. */
	window?: { windowId: string; paneId: string };
}

export interface RunReport {
	status: "ready" | "completed" | "failed" | "timeout" | "stopped";
	id: string;
	profile: string;
	selection: Selection;
	cwd?: string;
	session?: string;
	runDir: string;
	recordFile: string;
	resultFile: string;
	state?: RpcState;
	levels?: string[];
	commands?: unknown;
	text?: string;
	usage?: unknown[];
	tool_errors?: number;
	steers?: number;
	brief?: { path: string; sha256: string; bytes: number; outcome?: string; dod: number };
	log?: LogCheck;
	error?: string;
	seconds?: number;
	pi_exit_code?: number;
	host?: HostInfo;
}

export interface RunOutcome {
	report: RunReport;
	exitCode: number;
}

function resolveExisting(target: string, what: string): string {
	try {
		return fs.realpathSync(path.resolve(target));
	} catch {
		throw new Error(`${what} does not exist: ${target}`);
	}
}

interface LockOwner {
	pid?: number;
	id?: string;
}

/**
 * Take ownership of a worker session file. A lock whose owner no longer exists is
 * treated as abandoned and replaced, so a killed supervisor cannot strand a session.
 */
export function acquireSessionLock(sessionFile: string, id: string): () => void {
	const lockPath = `${sessionFile}.lock`;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const fd = fs.openSync(lockPath, "wx", 0o600);
			fs.writeSync(fd, `${JSON.stringify({ pid: process.pid, id, at: nowIso() })}\n`);
			fs.closeSync(fd);
			return () => fs.rmSync(lockPath, { force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let owner: LockOwner = {};
			try {
				owner = JSON.parse(fs.readFileSync(lockPath, "utf8")) as LockOwner;
			} catch {
				owner = {};
			}
			if (owner.pid && owner.pid !== process.pid && pidAlive(owner.pid)) {
				throw new Error(`Session is owned by another worker (${owner.id ?? "unknown"}, pid ${owner.pid}): ${sessionFile}`);
			}
			fs.rmSync(lockPath, { force: true });
		}
	}
	throw new Error(`Could not acquire session lock: ${lockPath}`);
}

/** Live workers (parallel cap, shared writer); defined in admission.ts, re-exported for callers. */
export { activeWorkers };

function previewArgs(toolName: string, args: unknown): string {
	if (typeof args !== "object" || args === null) return toolName;
	const source = args as Record<string, unknown>;
	const pick = (key: string): string | undefined => {
		const value = source[key];
		return typeof value === "string" ? value : undefined;
	};
	const value =
		pick("command") ??
		pick("file_path") ??
		pick("path") ??
		pick("pattern") ??
		pick("query") ??
		(typeof source.content === "string" ? `${source.content.split("\n").length} lines` : undefined);
	return value ? `${toolName}: ${value.replace(/\s+/g, " ").slice(0, 160)}` : toolName;
}

interface UsageFields {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { total?: number };
}

function applyUsage(target: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; contextTokens: number }, usage: UsageFields | undefined): void {
	if (!usage || typeof usage !== "object") return;
	target.input = usage.input ?? target.input;
	target.output = usage.output ?? target.output;
	target.cacheRead = usage.cacheRead ?? target.cacheRead;
	target.cacheWrite = usage.cacheWrite ?? target.cacheWrite;
	target.cost = usage.cost?.total ?? target.cost;
	target.contextTokens = usage.totalTokens ?? target.contextTokens;
}

function messageText(message: { content?: unknown }): string {
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((part): part is { type: string; text: string } => {
			if (typeof part !== "object" || part === null) return false;
			const candidate = part as { type?: unknown; text?: unknown };
			return candidate.type === "text" && typeof candidate.text === "string";
		})
		.map((part) => part.text)
		.join("\n");
}

function appendTail(previous: string | undefined, delta: string, cap = 400): string {
	const combined = `${previous ?? ""}${delta}`;
	return combined.length > cap ? combined.slice(combined.length - cap) : combined;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
	return new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => {
			child.off("exit", onExit);
			resolve(false);
		}, timeoutMs);
		const onExit = (): void => {
			clearTimeout(timer);
			resolve(true);
		};
		child.once("exit", onExit);
	});
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
	if (!pid) return;
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// Already gone.
		}
	}
}

async function closeStream(stream: fs.WriteStream | undefined): Promise<void> {
	if (!stream) return;
	await new Promise<void>((resolve) => stream.end(() => resolve()));
}

export interface Preflight {
	cwd: string;
	promptFile?: string;
	prompt: string;
	sessionFile: string;
	parsed: ParsedBrief;
	digest: ReturnType<typeof digestBrief>;
	logPath?: string;
	active: WorkerRecord[];
	requireDod: boolean;
}

/**
 * Resolve paths, parse and validate the brief, and run admission checks before any
 * process is spawned. Shared with `--detach` so a bad launch fails in the caller.
 *
 * The admission checks here are a fast fail against a read-only snapshot: the run that
 * actually starts reserves its slot and workspace atomically in `runWorker`, so a snapshot
 * that goes stale between here and there (two spawns in the same turn) is still caught.
 */
export function preflight(options: RunOptions): Preflight {
	const cwd = resolveExisting(options.cwd, "cwd");
	const promptFile = options.promptFile ? resolveExisting(options.promptFile, "prompt file") : undefined;
	const prompt = options.promptText ?? (promptFile ? fs.readFileSync(promptFile, "utf8") : "");
	if (!prompt.trim()) throw new Error("Empty prompt file");
	const runDir = path.resolve(options.runDir);
	// A reused run dir used to fail only inside the worker, which --detach/--window hid.
	if (fs.existsSync(path.join(runDir, "result.json")) || fs.existsSync(path.join(runDir, "events.jsonl"))) {
		throw new Error(`Refusing to start: run dir ${runDir} already holds a run. Use a fresh --run-dir.`);
	}
	const sessionFile = options.session ? resolveExisting(options.session, "session") : path.join(runDir, "session.jsonl");
	const parsed = parseBrief(prompt);
	const requireDod = options.requireDod ?? options.tools === "write";
	const validation = validateBrief(parsed, { requireDod, minLength: options.minBriefChars ?? 40 }, prompt);
	if (validation.errors.length > 0) throw new Error(`Brief rejected: ${validation.errors.join("; ")}`);
	const logPath = options.logPath ? path.resolve(options.logPath) : parsed.logPath ? path.resolve(parsed.logPath) : undefined;
	const active = activeWorkers(options.env);
	const refusal = admissionRefusal({
		cwd,
		tools: options.tools,
		// The flag wins; config.json is the machine-wide default.
		maxParallel: options.maxParallel ?? readConfig(options.env).maxParallel,
		allowSharedCwd: options.allowSharedCwd,
		env: options.env,
	});
	if (refusal) throw new Error(refusal);
	const result: Preflight = { cwd, prompt, sessionFile, parsed, digest: digestBrief(prompt), active, requireDod };
	if (promptFile) result.promptFile = promptFile;
	if (logPath) result.logPath = logPath;
	return result;
}

/**
 * Record the workspace revision before and after a worker touches it, so acceptance can
 * look at the relevant diff instead of trusting a summary. Never throws: a missing git or
 * a non-repository directory yields `vcs: "none"`.
 */
export function workspaceEvidence(cwd: string, phase: "before" | "after"): WorkspaceEvidence {
	const git = (args: string[]): string | undefined => {
		try {
			return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
		} catch {
			return undefined;
		}
	};
	if (git(["rev-parse", "--is-inside-work-tree"]) !== "true") return { vcs: "none" };
	const revision = git(["rev-parse", "--short", "HEAD"]);
	const status = git(["status", "--porcelain"]);
	const changed = status ? status.split("\n").filter(Boolean).map((line) => line.slice(3).trim()) : [];
	const evidence: WorkspaceEvidence = { vcs: "git", dirtyBefore: changed.length, dirtyAfter: changed.length };
	if (revision) {
		evidence.revisionBefore = revision;
		evidence.revisionAfter = revision;
	}
	if (phase === "after") {
		const stat = git(["diff", "--stat", "HEAD"]);
		if (stat) evidence.diffStat = stat.slice(-2000);
		if (changed.length > 0) evidence.changedFiles = changed.slice(0, 40);
	}
	return evidence;
}

function mergeWorkspace(record: WorkerRecord, phase: "before" | "after", evidence: WorkspaceEvidence): void {
	if (evidence.vcs !== "git") {
		record.workspace = evidence;
		return;
	}
	const current = record.workspace;
	const merged: WorkspaceEvidence = { vcs: "git" };
	if (phase === "before") {
		merged.revisionBefore = evidence.revisionBefore;
		merged.dirtyBefore = evidence.dirtyBefore;
	} else {
		merged.revisionBefore = current?.revisionBefore;
		merged.dirtyBefore = current?.dirtyBefore;
		merged.revisionAfter = evidence.revisionAfter;
		merged.dirtyAfter = evidence.dirtyAfter;
		merged.diffStat = evidence.diffStat;
		merged.changedFiles = evidence.changedFiles;
	}
	record.workspace = merged;
}

export async function runWorker(options: RunOptions): Promise<RunOutcome> {
	const started = Date.now();
	const deadline = started + options.timeoutMs;
	const id = options.id ?? newWorkerId();
	const dir = path.resolve(options.runDir);
	const resultFile = path.join(dir, "result.json");
	const registryFile = recordPath(id, options.env);
	const report: RunReport = {
		status: "failed",
		id,
		profile: options.profile,
		selection: options.selection,
		runDir: dir,
		recordFile: registryFile,
		resultFile,
		host: options.host,
	};

	let child: ChildProcess | undefined;
	let rpc: RpcClient | undefined;
	let control: ControlServer | undefined;
	let releaseLock: (() => void) | undefined;
	let releaseAdmission: (() => void) | undefined;
	let heartbeat: NodeJS.Timeout | undefined;
	let store: RecordFile | undefined;
	let events: fs.WriteStream | undefined;
	let errors: fs.WriteStream | undefined;
	// An answer control call sends `extension_ui_response` itself and resolves this once the
	// run loop may resume; whether the write succeeded is decided by that call, not by this promise.
	let pendingAnswer: { uiId: string; resolve: () => void } | undefined;
	let stopRequestedBy: string | undefined;
	let completedNormally = false;
	const signalHandlers: Array<[NodeJS.Signals, () => void]> = [];
	let parsed: ParsedBrief = { dod: [], hasDodTable: false };
	let logPath: string | undefined;
	let lastWindowName: string | undefined;

	/**
	 * Keep the worker's tmux window name and metadata in step with its state. Every
	 * failure here is cosmetic: the record stays authoritative.
	 */
	const syncWindow = (state: string): void => {
		const window = options.window;
		if (!window?.windowId) return;
		// The window id may be stale (operator closed it) or reused by tmux. Only mutate a window
		// that is unowned or already ours, so we can never rename or relabel someone else's window.
		if (!claimWindow(window.windowId, id)) return;
		// Name once; state goes into a window option so the name stays a stable target.
		if (lastWindowName === undefined) {
			lastWindowName = workerWindowName({ id, profile: options.profile });
			renameWindow(window.windowId, lastWindowName);
			setWindowOption(window.windowId, "automatic-rename", "off");
		}
		setWindowOption(window.windowId, WORKER_STATE_OPTION, state);
		if (store) {
			store.record.tmux = { windowId: window.windowId, paneId: window.paneId, name: lastWindowName };
			store.save();
		}
	};

	const stopChild = async (graceful: boolean): Promise<void> => {
		if (!child || child.pid === undefined) return;
		const pid = child.pid;
		if (graceful && rpc) {
			try {
				await rpc.send("clear_queue", {}, Date.now() + 200);
				await rpc.send("abort", {}, Date.now() + 200);
			} catch {
				// Termination below remains authoritative.
			}
		}
		try {
			child.stdin?.end();
		} catch {
			// Transport already gone.
		}
		if (!(await waitForExit(child, 3000))) {
			killGroup(pid, "SIGTERM");
			if (!(await waitForExit(child, 2000))) {
				killGroup(pid, "SIGKILL");
				await waitForExit(child, 500);
			}
		}
		// Children that outlived Pi while staying in its process group.
		killGroup(pid, "SIGKILL");
		rpc?.dispose();
	};

	/**
	 * Ask the worker to stop and remember who asked. Shared by the control socket and by
	 * signals: a supervisor that is killed must not leave a worker running unattended.
	 */
	const requestStop = (by: string, hard: boolean): void => {
		stopRequestedBy = by;
		if (pendingAnswer) {
			const pending = pendingAnswer;
			pendingAnswer = undefined;
			// Stop/abort cancels the dialog itself; the run loop must not wait for a delivery
			// that no control caller is tracking, so this is fire-and-forget like the stop commands.
			void rpc?.send("extension_ui_response", { id: pending.uiId, cancelled: true }, Date.now() + 500).catch(() => undefined);
			pending.resolve();
		}
		if (rpc) {
			void rpc.send("clear_queue", {}, Date.now() + 500).catch(() => undefined);
			void rpc.send("abort", {}, Date.now() + 500).catch(() => undefined);
		}
		if (store) {
			store.record.state = "running";
			store.record.phase = "idle";
			store.write();
		}
		appendAudit({ action: hard ? "stop" : "abort", id, by }, options.env);
		if (hard) setTimeout(() => void stopChild(false), 1500).unref();
	};

	const waitForAnswer = (uiId: string): Promise<void> => {
		const remaining = deadline - Date.now();
		if (remaining <= 0) return Promise.reject(new TimeoutError("Worker deadline reached while waiting for input"));
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pendingAnswer = undefined;
				reject(new TimeoutError("Worker deadline reached while waiting for input"));
			}, remaining);
			pendingAnswer = {
				uiId,
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
			};
		});
	};

	try {
		fs.mkdirSync(dir, { recursive: false });
		ensureStateDirs(options.env);
		const { cwd, promptFile, prompt, sessionFile, parsed: brief, digest, logPath: briefLogPath } = preflight(options);
		parsed = brief;
		report.cwd = cwd;
		report.session = sessionFile;
		logPath = briefLogPath;
		// The atomic admission point: reserve the slot and the workspace before the first
		// record is written, so no other supervisor can read a state that omits this run.
		releaseAdmission = acquireAdmission({
			id,
			cwd,
			tools: options.tools,
			maxParallel: options.maxParallel ?? readConfig(options.env).maxParallel,
			allowSharedCwd: options.allowSharedCwd,
			env: options.env,
		}).release;
		if (logPath) scaffoldLog(logPath, { id, profile: options.profile, outcome: parsed.outcome, runDir: dir });

		report.brief = { path: promptFile ?? "(inline)", sha256: digest.sha256, bytes: digest.bytes, outcome: parsed.outcome, dod: parsed.dod.length };

		const record: WorkerRecord = {
			version: RECORD_VERSION,
			id,
			state: "starting",
			phase: "starting",
			createdAt: nowIso(),
			updatedAt: nowIso(),
			heartbeatAt: nowIso(),
			host: options.host,
			supervisor: { pid: process.pid, socket: path.join(path.dirname(registryFile), `${id}.ctl.sock`), cli: process.argv[1] ?? "pi-orch" },
			worker: {
				profile: options.profile,
				provider: options.selection.provider,
				model: options.selection.model,
				thinking: options.selection.thinking,
				tools: options.tools,
				cwd,
				sessionFile,
				trust: options.trust,
			},
			brief: {
				path: promptFile ?? "(inline)",
				bytes: digest.bytes,
				sha256: digest.sha256,
				excerpt: digest.excerpt,
				outcome: parsed.outcome,
				definitionOfDone: parsed.dod.map((row) => `${row.criterion} — ${row.verification} [${row.owner}]`),
				checks: parsed.dod.map((row) => row.verification).filter(Boolean),
				logPath,
			},
			runDir: dir,
			deadline: { seconds: Math.round(options.timeoutMs / 1000), expiresAt: new Date(deadline).toISOString() },
			activity: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0, toolCalls: 0, toolErrors: 0 },
			controls: { steers: 0, followUps: 0, rejections: 0 },
		};
		store = new RecordFile(record);
		store.write();
		if (options.window?.windowId) syncWindow("starting");
		mergeWorkspace(record, "before", workspaceEvidence(cwd, "before"));
		store.write();

		const launch = {
			status: "starting",
			id,
			profile: options.profile,
			selection: options.selection,
			cwd,
			session: sessionFile,
			runDir: dir,
			tools: options.tools,
			trust: options.trust,
			timeoutMs: options.timeoutMs,
			brief: { path: promptFile ?? "(inline)", sha256: digest.sha256, bytes: digest.bytes, dod: parsed.dod.length, outcome: parsed.outcome },
			host: options.host,
			startedAt: new Date(started).toISOString(),
		};
		fs.writeFileSync(path.join(dir, "launch.json"), `${JSON.stringify(launch, null, 2)}\n`);

		releaseLock = acquireSessionLock(sessionFile, id);

		const argv = [
			options.pi,
			"--offline",
			"--mode",
			"rpc",
			"--provider",
			options.selection.provider,
			"--model",
			options.selection.model,
			"--thinking",
			options.selection.thinking,
			"--session",
			sessionFile,
		];
		if (options.tools === "none") argv.push("--no-tools");
		else argv.push("--tools", TOOL_SETS[options.tools]);
		if (options.trust === "project") argv.push("--approve");
		else if (options.trust === "ignore") argv.push("--no-approve");

		const childEnv: NodeJS.ProcessEnv = { ...options.env };
		// The worker must not inherit the dispatching session's identity.
		// PI_ORCH_WINDOW/TMUX_PANE are dropped too: they describe the *supervisor's* window, and a
		// nested `pi-orch run` from the worker's shell must not think it owns that window.
		for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_MODEL", "PI_PROVIDER", "PI_REASONING_LEVEL", "PI_ORCH_WINDOW"]) delete childEnv[key];

		events = fs.createWriteStream(path.join(dir, "events.jsonl"), { flags: "a" });
		errors = fs.createWriteStream(path.join(dir, "stderr.txt"), { flags: "a" });
		child = spawn(argv[0]!, argv.slice(1), { cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"], detached: true });
		// `spawn` reports a missing or non-executable binary asynchronously; surface it here
		// so a bad launch fails like any other startup error instead of crashing the supervisor.
		await new Promise<void>((resolve, reject) => {
			const onSpawn = (): void => {
				child?.off("error", onError);
				resolve();
			};
			const onError = (error: Error): void => {
				child?.off("spawn", onSpawn);
				reject(new Error(`Failed to start ${argv[0]}: ${error.message}`));
			};
			child!.once("spawn", onSpawn);
			child!.once("error", onError);
		});
		child.on("error", () => {
			// Later transport errors are reported through the RPC stream; keep the process alive.
		});
		const stdin = child.stdin;
		const stdout = child.stdout;
		if (!stdin || !stdout) throw new Error("Failed to open worker stdio");
		child.stderr?.pipe(errors);
		const childPid = child.pid;
		if (childPid) {
			record.worker.pid = childPid;
			store.write();
		}

		heartbeat = setInterval(() => {
			record.heartbeatAt = nowIso();
			record.updatedAt = record.heartbeatAt;
			store?.write();
		}, 5000);
		heartbeat.unref();

		const noteActivity = (event: RpcEvent): void => {
			const activity = record.activity;
			activity.lastEventAt = nowIso();
			switch (event.type) {
				case "agent_start":
					record.state = "running";
					record.phase = "thinking";
					break;
				case "turn_start":
					record.phase = "thinking";
					break;
				case "message_update": {
					const delta = event.assistantMessageEvent as { type?: string; delta?: string; toolName?: string } | undefined;
					if (delta?.type === "text_delta" && typeof delta.delta === "string") {
						activity.text = appendTail(activity.text, delta.delta);
					} else if (delta?.type === "toolcall_start" && typeof delta.toolName === "string") {
						record.phase = "tool";
						activity.tool = delta.toolName;
					}
					applyUsage(activity, event.usage as UsageFields | undefined);
					break;
				}
				case "tool_execution_start":
					record.phase = "tool";
					activity.tool = typeof event.toolName === "string" ? event.toolName : "tool";
					activity.toolDetail = previewArgs(activity.tool, event.args);
					break;
				case "tool_execution_end":
					activity.toolCalls += 1;
					if (event.isError === true) activity.toolErrors += 1;
					activity.tool = undefined;
					activity.toolDetail = undefined;
					record.phase = "thinking";
					break;
				case "compaction_start":
					record.phase = "compacting";
					break;
				case "compaction_end":
					record.phase = "thinking";
					break;
				case "auto_retry_start":
					record.phase = "retrying";
					break;
				case "auto_retry_end":
					record.phase = "thinking";
					break;
				default:
					break;
			}
			store?.save();
		};

		rpc = new RpcClient(stdout, stdin, { deadline, onEvent: noteActivity, sink: (line) => events?.write(line) });

		/**
		 * A rejected control call is a caller-visible failure, not a run failure: record it on the
		 * worker and in the audit trail, then let the caller see the error while the run continues.
		 */
		const recordControlRejection = (action: string, by: string | undefined, error: unknown): void => {
			const message = error instanceof Error ? error.message : String(error);
			record.controls.rejections = (record.controls.rejections ?? 0) + 1;
			record.controls.lastRejectionAt = nowIso();
			record.controls.lastRejectionError = message;
			store?.write();
			appendAudit({ action: `${action}_rejected`, id, by, detail: message.slice(0, 200) }, options.env);
		};

		control = await startControlServer(record.supervisor.socket, async (request: ControlRequest) => {
			const by = request.by ?? options.host.label;
			switch (request.cmd) {
				case "status":
					return { record };
				case "steer":
				case "follow_up": {
					if (typeof request.message !== "string" || request.message.trim() === "") throw new Error("message is required");
					if (request.message.length > 16_000) throw new Error("message too long (16000 character cap)");
					try {
						// Wait for Pi's response so a rejection is reported to the caller instead of
						// surfacing on the run's event stream, where it used to kill a healthy run.
						await rpc!.request(request.cmd, { message: request.message }, Date.now() + 5000);
					} catch (error) {
						recordControlRejection(request.cmd, by, error);
						throw error;
					}
					if (request.cmd === "steer") {
						record.controls.steers += 1;
						record.controls.lastSteerAt = nowIso();
						record.controls.lastSteerBy = by;
					} else {
						record.controls.followUps += 1;
					}
					store?.write();
					appendAudit({ action: request.cmd, id, by, detail: request.message.slice(0, 200) }, options.env);
					return { delivered: true };
				}
				case "abort":
				case "stop": {
					requestStop(by, request.cmd === "stop");
					return { stopping: true };
				}
				case "answer": {
					if (!pendingAnswer) throw new Error("worker is not waiting for input");
					const pending = pendingAnswer;
					pendingAnswer = undefined;
					const payload = request.cancelled === true ? { cancelled: true } : { value: request.value ?? "" };
					try {
						// Pi does not acknowledge extension_ui_response (docs/rpc.md, rpc-mode.js),
						// so the write itself is the delivery; a transport/backpressure failure fails the call.
						await rpc!.send("extension_ui_response", { id: pending.uiId, ...payload }, Date.now() + 5000);
					} catch (error) {
						recordControlRejection("answer", by, error);
						throw error;
					} finally {
						pending.resolve();
					}
					appendAudit({ action: "answer", id, by, detail: (request.value ?? "(cancelled)").slice(0, 200) }, options.env);
					return { delivered: true };
				}
				default:
					throw new Error(`unsupported control command: ${(request as { cmd: string }).cmd}`);
			}
		});

		const state = await rpc.request<RpcState & Record<string, unknown>>("get_state");
		verifySelection(state, options.selection, "before inference");
		report.state = state;
		record.state = "running";
		record.phase = "thinking";
		store.write();
		syncWindow("running");
		fs.writeFileSync(
			path.join(dir, "launch.json"),
			`${JSON.stringify({ ...launch, status: "running", observed: state, supervisorPid: process.pid, workerPid: childPid }, null, 2)}\n`,
		);

		// A supervisor that is signalled must stop its worker: the worker runs in its own
		// process group, so it would otherwise keep running unattended.
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
			const handler = (): void => requestStop(`signal:${signal}`, true);
			signalHandlers.push([signal, handler]);
			process.on(signal, handler);
		}

		if (options.command === "check") {
			report.levels = (await rpc.request<{ levels?: string[] }>("get_available_thinking_levels")).levels;
			report.commands = await rpc.request("get_commands");
			report.status = "ready";
			completedNormally = true;
		} else {
			await rpc.send("prompt", { message: prompt }, deadline);
			const messages: Array<{ role?: string; provider?: string; model?: string; stopReason?: string; content?: unknown; usage?: UsageFields; errorMessage?: string }> = [];
			for (;;) {
				const event = await rpc.next(deadline);
				if (event.type === "agent_settled") break;
				// The prompt is sent fire-and-forget so an extension that asks for input while
				// handling it cannot deadlock the supervisor behind a pending response.
				if (event.type === "response" && event.success === false) {
					// steer/follow_up/answer responses are correlated to their caller by RpcClient.
					// If one still lands here (a Pi build that acknowledges an answer, or a caller
					// that timed out first), the control call failed; the run must survive it.
					const command = String(event.command ?? "");
					const action = command === "extension_ui_response" ? "answer" : command;
					if (action === "steer" || action === "follow_up" || action === "answer") {
						recordControlRejection(action, undefined, new RpcError(`Pi rejected ${command}: ${String(event.error ?? "unknown error")}`));
					} else {
						throw new RpcError(`Pi rejected ${String(event.command ?? "command")}: ${String(event.error ?? "unknown error")}`);
					}
				}
				switch (event.type) {
					case "message_end": {
						const message = event.message as (typeof messages)[number] | undefined;
						if (!message || message.role !== "assistant") break;
						if (message.provider !== options.selection.provider || message.model !== options.selection.model) {
							throw new RpcError(`Unexpected model/provider in worker response: ${String(message.provider)}/${String(message.model)}`);
						}
						messages.push(message);
						record.activity.turns = messages.length;
						applyUsage(record.activity, message.usage);
						store.save();
						break;
					}
					case "extension_ui_request": {
						const method = typeof event.method === "string" ? event.method : "";
						if (!DIALOG_METHODS.has(method)) break;
						if (options.inputPolicy === "fail") throw new RpcError(`Worker needs interactive input (${method}); inspect events and resolve the dependency`);
						record.pendingInput = {
							id: String(event.id ?? ""),
							method,
							title: typeof event.title === "string" ? event.title : undefined,
							message: typeof event.message === "string" ? event.message : undefined,
							options: Array.isArray(event.options) ? event.options.filter((item): item is string => typeof item === "string") : undefined,
							prefill: typeof event.prefill === "string" ? event.prefill : undefined,
							requestedAt: nowIso(),
						};
						record.state = "awaiting-input";
						record.phase = "input";
						store.write();
						syncWindow("awaiting-input");
						// The control handler performs the write; the run loop only waits until the
						// caller (or a stop) has settled this dialog before resuming.
						await waitForAnswer(String(event.id ?? ""));
						record.pendingInput = undefined;
						record.state = "running";
						record.phase = "thinking";
						store.write();
						syncWindow("running");
						break;
					}
					default:
						break;
				}
			}

			const last = messages[messages.length - 1];
			report.text = last ? messageText(last) : "";
			report.usage = messages.filter((message) => message.usage).map((message) => message.usage);
			report.tool_errors = record.activity.toolErrors;
			report.steers = record.controls.steers;

			if (stopRequestedBy) {
				report.status = "stopped";
				report.error = `Stopped by ${stopRequestedBy}`;
			} else if (last?.stopReason !== "stop") {
				throw new RpcError(`Incomplete worker response: ${String(last?.stopReason)}; ${String(last?.errorMessage ?? "")}`);
			} else if (!report.text?.trim()) {
				throw new RpcError("Worker returned no text");
			} else {
				report.status = "completed";
				completedNormally = true;
			}

			const postState = await rpc.request<RpcState & Record<string, unknown>>("get_state");
			verifySelection(postState, options.selection, "after completion");
		}

		if (logPath) {
			report.log = checkLog(logPath);
			if (report.log.log !== "ok") report.error = `engineering log ${report.log.log}: ${report.log.detail ?? ""}`;
		}
		mergeWorkspace(record, "after", workspaceEvidence(cwd, "after"));
		store.write();
	} catch (error) {
		const timedOut = error instanceof TimeoutError;
		report.status = stopRequestedBy ? "stopped" : timedOut ? "timeout" : "failed";
		report.error = error instanceof Error ? error.message : String(error);
	} finally {
		for (const [signal, handler] of signalHandlers) process.off(signal, handler);
		if (heartbeat) clearInterval(heartbeat);
		// The reservation outlives the worker: another writer must not enter the workspace
		// while this supervisor still has a child in it, and it must be released even when
		// the teardown itself fails.
		try {
			if (control) await control.close();
			await stopChild(!completedNormally);
		} finally {
			releaseLock?.();
			releaseAdmission?.();
			await closeStream(errors);
			await closeStream(events);
		}
	}

	report.seconds = Number(((Date.now() - started) / 1000).toFixed(2));
	if (child) report.pi_exit_code = child.exitCode ?? undefined;
	const checks: LogCheck = report.log ?? { log: "skipped" };
	const record = store?.record;
	if (record) {
		record.endedAt = nowIso();
		record.updatedAt = record.endedAt;
		record.heartbeatAt = record.endedAt;
		record.state = report.status === "completed" || report.status === "ready" ? "completed" : report.status === "stopped" ? "stopped" : report.status;
		record.phase = "done";
		if (report.error && report.status !== "completed") record.error = report.error;
		record.activity.turns = Math.max(record.activity.turns, reportsTurns(report));
		record.result = {
			status: report.status,
			path: resultFile,
			text: report.text?.slice(0, 4000),
			error: report.error,
			seconds: report.seconds,
			checks,
		};
		store?.write();
	}
	try {
		fs.writeFileSync(resultFile, `${JSON.stringify({ ...report, definitionOfDone: parsed.dod }, null, 2)}\n`);
	} catch {
		// A missing artifact is visible to the lead; the report itself is still returned.
	}
	if (options.window?.windowId) {
		// The window is the operator's view: rename it to the terminal state and leave it
		// open so the last output stays readable. Closing it is the operator's decision.
		syncWindow(report.status);
	}
	return { report, exitCode: report.status === "completed" || report.status === "ready" ? 0 : 1 };
}

function reportsTurns(report: RunReport): number {
	return Array.isArray(report.usage) ? report.usage.length : 0;
}
