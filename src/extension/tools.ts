/**
 * Tools that let the lead model drive the deterministic spine directly:
 * spawn a supervised worker, watch it, steer it, and read its result.
 *
 * Spawning always goes through the `pi-orch` CLI as a detached supervisor, so a
 * worker survives the lead session and stays controllable from any other session.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { checkLog, parseBrief, type DodRow } from "../brief.ts";
import { sendControl } from "../control.ts";
import { readConfig } from "../config.ts";
import { loadProfiles, profileNames, profilesCandidates, resolveProfilesPath, selectProfile } from "../profiles.ts";
import { formatTranscript, readTail, readTranscript } from "../transcript.ts";
import {
	ensureStateDirs,
	listRecords,
	newWorkerId,
	readAudit,
	readCliPointer,
	readRecordFile,
	stateDir,
	summarise,
} from "../registry.ts";
import type { ToolSet, WorkerRecord } from "../protocol.ts";

export interface SpawnRequest {
	profile: string;
	cwd: string;
	briefText?: string;
	briefFile?: string;
	tools?: ToolSet;
	thinking?: string;
	timeoutSeconds?: number;
	log?: string;
	detach?: boolean;
	trust?: "saved" | "project" | "ignore";
	runDir?: string;
	session?: string;
	/** tmux window mode; defaults to the config value, else "auto" for a human operator. */
	windowMode?: "auto" | "always" | "never";
	id?: string;
	label?: string;
	maxParallel?: number;
	allowSharedCwd?: boolean;
}

export interface SupervisorHandle {
	id: string;
	runDir: string;
	recordFile: string;
	logFile: string;
	child: ChildProcess;
}

export function cliEntry(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.PI_ORCH_CLI;
	if (explicit && fs.existsSync(explicit)) return explicit;
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const candidate = path.resolve(here, "..", "..", "bin", "pi-orch.mjs");
		if (fs.existsSync(candidate)) return candidate;
	} catch {
		// import.meta.url may be unavailable in an unusual loader; fall through.
	}
	const pointer = readCliPointer(env);
	if (pointer) return pointer;
	throw new Error("pi-orch CLI not found. Install the pi-agent-dashboard package or set PI_ORCH_CLI.");
}

function logFileFor(id: string, env: NodeJS.ProcessEnv): string {
	const dir = path.join(stateDir(env), "logs");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	return path.join(dir, `${id}.log`);
}

/**
 * Start a detached supervisor and wait until its record is published. The supervisor
 * owns the worker: closing this Pi session or aborting the tool does not kill it.
 */
export async function spawnSupervisor(request: SpawnRequest, env: NodeJS.ProcessEnv = process.env): Promise<SupervisorHandle> {
	const id = request.id ?? newWorkerId();
	ensureStateDirs(env);
	const briefsDir = path.join(stateDir(env), "briefs");
	const runsDir = path.join(stateDir(env), "runs");
	fs.mkdirSync(briefsDir, { recursive: true, mode: 0o700 });

	let briefFile = request.briefFile;
	if (!briefFile) {
		if (!request.briefText?.trim()) throw new Error("A brief is required: pass brief (text) or brief_file");
		briefFile = path.join(briefsDir, `${id}.md`);
		fs.writeFileSync(briefFile, request.briefText, { mode: 0o600 });
	} else {
		briefFile = path.resolve(briefFile);
		if (!fs.existsSync(briefFile)) throw new Error(`brief_file does not exist: ${briefFile}`);
	}
	const runDir = path.resolve(request.runDir ?? path.join(runsDir, id));
	// The supervisor creates the run directory itself (non-recursive, so a reused directory is
	// refused), but its parent has to exist.
	fs.mkdirSync(path.dirname(runDir), { recursive: true, mode: 0o700 });
	const logFile = logFileFor(id, env);
	const cwd = path.resolve(request.cwd);
	const args = [
		cliEntry(env),
		"run",
		request.profile,
		"--cwd",
		cwd,
		"--run-dir",
		runDir,
		"--prompt-file",
		briefFile,
		"--id",
		id,
		"--tools",
		request.tools ?? "read",
		// Parking beats failing: a worker that asks a question shows up in /agents
		// instead of dying with "needs interactive input".
		"--input",
		"park",
		"--trust",
		request.trust ?? "saved",
		"--pi",
		env.PI_ORCH_PI ?? "pi",
	];
	if (request.session) args.push("--session", path.resolve(request.session));
	// Window mode is opt-in (config tmux.windows, or an explicit --window): the reviews
	// rejected automatic per-worker windows as churn that also changes the process model.
	if (!env.PI_ORCH_WINDOW) {
		const configured = request.windowMode ?? readConfig(env).tmux?.windows;
		if (configured) args.push("--window", configured);
	}
	if (request.thinking) args.push("--thinking", request.thinking);
	if (request.timeoutSeconds) args.push("--timeout", String(request.timeoutSeconds));
	if (request.log) args.push("--log", path.resolve(request.log));
	if (request.label) args.push("--label", request.label);
	if (request.maxParallel) args.push("--max-parallel", String(request.maxParallel));
	if (request.allowSharedCwd) args.push("--allow-shared-cwd");
	if (request.tools === "write" || request.tools === undefined) args.push("--require-dod");

	const fd = fs.openSync(logFile, "a", 0o600);
	let spawnError: Error | undefined;
	const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", fd, fd], env, cwd });
	// A detached child reports ENOENT (missing cwd), EACCES and EMFILE asynchronously as an
	// 'error' event; without this listener that becomes an uncaughtException and the whole Pi
	// session dies. try/catch around spawn() cannot catch it.
	child.on("error", (error) => {
		spawnError = error;
	});
	fs.closeSync(fd);
	child.unref();

	const recordFile = path.join(stateDir(env), "workers", `${id}.json`);
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		if (fs.existsSync(recordFile)) return { id, runDir, recordFile, logFile, child };
		if (spawnError) throw new Error(`supervisor failed to start: ${spawnError.message}`);
		if (child.exitCode !== null && child.exitCode !== 0) break;
		await sleep(120);
	}
	throw new Error(`supervisor failed to start: ${spawnError?.message ?? logTail(logFile)}`);
}

function logTail(logFile: string): string {
	try {
		const text = readTail(logFile, 2000).trim();
		return text || "no supervisor log";
	} catch {
		return "no supervisor log";
	}
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function recordSummaryLine(record: WorkerRecord, stale = false): string {
	const summary = summarise(record, stale);
	const activity = summary.toolDetail ?? summary.tool ?? summary.text?.slice(-80) ?? "";
	return `${summary.id} · ${summary.state}/${summary.phase} · ${summary.profile}/${summary.thinking} · ${summary.hostLabel} · ${summary.ageSeconds}s${activity ? ` · ${activity}` : ""}`;
}

/** Render one worker's record for the model: facts, brief, activity, result. */
export function renderRecord(view: WorkerRecord, options: { transcript?: string[]; stale?: boolean } = {}): string {
	const lines: string[] = [];
	lines.push(`${view.id}  ${view.state}/${view.phase}${options.stale ? " (supervisor gone)" : ""}`);
	lines.push(
		`agent: ${view.worker.profile} · ${view.worker.provider}/${view.worker.model} · thinking ${view.worker.thinking} · tools ${view.worker.tools}`,
	);
	lines.push(`host: ${view.host.label}${view.host.sessionId ? ` (${view.host.sessionId})` : ""}`);
	lines.push(`cwd: ${view.worker.cwd}`);
	lines.push(`run: ${view.runDir}`);
	lines.push(`session: ${view.worker.sessionFile}`);
	lines.push(`deadline: ${view.deadline.seconds}s (expires ${view.deadline.expiresAt})`);
	if (view.brief.outcome) lines.push(`outcome: ${view.brief.outcome}`);
	if (view.brief.definitionOfDone.length > 0) {
		lines.push("definition of done:");
		for (const row of view.brief.definitionOfDone) lines.push(`  - ${row}`);
	}
	if (view.brief.logPath) lines.push(`engineering log: ${view.brief.logPath} (${view.result?.checks.log ?? "unchecked"})`);
	lines.push(
		`usage: turns ${view.activity.turns} · tools ${view.activity.toolCalls} (${view.activity.toolErrors} errors) · $${view.activity.cost.toFixed(4)}`,
	);
	lines.push(`controls: ${view.controls.steers} steers${view.controls.lastSteerBy ? ` (last by ${view.controls.lastSteerBy})` : ""}`);
	const now = view.activity.toolDetail ?? (view.activity.tool ? `running ${view.activity.tool}` : undefined);
	if (now) lines.push(`now: ${now}`);
	if (view.activity.text) lines.push(`says: …${view.activity.text.replace(/\s+/g, " ").slice(-240)}`);
	if (view.pendingInput) {
		lines.push(`WAITING FOR INPUT: ${view.pendingInput.method} "${view.pendingInput.title ?? view.pendingInput.message ?? ""}"${view.pendingInput.options ? ` options=${JSON.stringify(view.pendingInput.options)}` : ""}`);
	}
	if (view.error) lines.push(`error: ${view.error}`);
	if (view.result) {
		lines.push(`result: ${view.result.status} in ${view.result.seconds ?? "?"}s · artifacts ${view.result.path}`);
		if (view.result.text) lines.push(`final response:\n${view.result.text}`);
	}
	if (options.transcript?.length) {
		lines.push("transcript (tail):");
		for (const line of options.transcript) lines.push(`  ${line}`);
	}
	return lines.join("\n");
}

export interface StatusOptions {
	id?: string;
	view?: "list" | "detail" | "transcript" | "audit";
	includeFinished?: boolean;
	limit?: number;
}

/* --------------------------------------------------------------- reporting */

export interface ProfileReportRow {
	name: string;
	provider: string;
	model: string;
	thinking: string;
	allowed: string[];
	card?: string;
	nodes: string[];
}

/** The roster as data: exact ids, allowed levels and the card that explains the routing. */
export function profileReport(env: NodeJS.ProcessEnv = process.env): { file?: string; rows: ProfileReportRow[]; error?: string } {
	const file = resolveProfilesPath(undefined, env);
	if (!file) return { rows: [], error: `no profiles.json found; tried ${profilesCandidates(env).join(", ")}` };
	try {
		const profiles = loadProfiles(file);
		const rows = profileNames(profiles).map((name) => {
			const entry = profiles.profiles[name]!;
			const row: ProfileReportRow = {
				name,
				provider: entry.provider,
				model: entry.model ?? "(per level)",
				thinking: entry.thinking,
				allowed: entry.allowed_thinking,
				nodes: [],
			};
			if (entry.card) row.card = entry.card;
			if (entry.model_by_thinking) row.nodes.push(`model_by_thinking: ${Object.entries(entry.model_by_thinking).map(([level, model]) => `${level}=${model}`).join(", ")}`);
			if (entry.reasoning_policy) row.nodes.push(`reasoning_policy: ${entry.reasoning_policy}`);
			return row;
		});
		return { file, rows };
	} catch (error) {
		return { file, rows: [], error: error instanceof Error ? error.message : String(error) };
	}
}

/** Read the brief again so a Result column the worker filled in is visible at acceptance time. */
function dodRowsFor(record: WorkerRecord): DodRow[] {
	try {
		if (record.brief.path && record.brief.path !== "(inline)") {
			const rows = parseBrief(fs.readFileSync(record.brief.path, "utf8")).dod;
			if (rows.length > 0) return rows;
		}
	} catch {
		// Brief moved or unreadable: fall back to what the supervisor recorded at launch.
	}
	return record.brief.definitionOfDone.map((text) => ({ criterion: text, verification: "(see brief)", owner: "?", result: "" }));
}

/**
 * The acceptance packet: what was asked, what the worker recorded against each criterion,
 * the engineering-log verdict, the workspace revision and diff, and the final response.
 * It reports evidence; it never decides pass or fail.
 */
export function acceptanceReport(record: WorkerRecord): string {
	const lines: string[] = [];
	lines.push(`acceptance evidence · ${record.id} · ${record.state}/${record.phase}`);
	lines.push(`agent: ${record.worker.profile} · ${record.worker.provider}/${record.worker.model} · thinking ${record.worker.thinking} · tools ${record.worker.tools}`);
	lines.push(`host: ${record.host.label}${record.host.sessionId ? ` (${record.host.sessionId})` : ""} · cwd ${record.worker.cwd}`);
	lines.push(`brief: ${record.brief.path} · sha256 ${record.brief.sha256.slice(0, 12)} · ${record.brief.bytes} bytes`);
	if (record.brief.outcome) lines.push(`outcome: ${record.brief.outcome}`);

	const rows = dodRowsFor(record);
	lines.push("");
	lines.push("definition of done — the lead verifies; an empty or unrun row is not a pass:");
	if (rows.length === 0) lines.push("  (no criteria were declared in the brief)");
	for (const row of rows) {
		lines.push(`  - ${row.criterion}`);
		lines.push(`      check: ${row.verification || "(none given)"} | owner: ${row.owner || "(none given)"}`);
		lines.push(`      worker recorded: ${row.result || "(empty)"}`);
	}

	lines.push("");
	const log = record.result?.checks.log ?? "unchecked";
	lines.push(`engineering log: ${log}${record.brief.logPath ? ` · ${record.brief.logPath}` : " (none assigned)"}`);
	if (record.workspace?.vcs === "git") {
		const w = record.workspace;
		lines.push(`workspace: git ${w.revisionBefore ?? "?"} → ${w.revisionAfter ?? "?"} · dirty files ${w.dirtyBefore ?? "?"} → ${w.dirtyAfter ?? "?"}`);
		if (w.changedFiles?.length) lines.push(`changed: ${w.changedFiles.join(", ")}`);
		if (w.diffStat) lines.push(`diffstat:\n${w.diffStat.split("\n").map((line) => `      ${line}`).join("\n")}`);
	} else {
		lines.push("workspace: not a git work tree; inspect the artifacts directly");
	}
	lines.push(
		`usage: turns ${record.activity.turns} · tool calls ${record.activity.toolCalls} · tool errors ${record.activity.toolErrors} · $${record.activity.cost.toFixed(4)}`,
	);
	lines.push(`controls: ${record.controls.steers} steers${record.controls.lastSteerBy ? ` (last by ${record.controls.lastSteerBy})` : ""}`);
	lines.push(`artifacts: ${record.runDir} (result.json, events.jsonl, session.jsonl) · session ${record.worker.sessionFile}`);
	if (record.error) lines.push(`error: ${record.error}`);
	if (record.result) lines.push(`worker status: ${record.result.status}${record.result.seconds ? ` in ${record.result.seconds}s` : ""}`);
	if (record.result?.text) {
		lines.push("final response:");
		lines.push(record.result.text.length > 4000 ? `${record.result.text.slice(0, 4000)}\n… (truncated; full text in result.json)` : record.result.text);
	}
	return lines.join("\n");
}

export function statusReport(options: StatusOptions, env: NodeJS.ProcessEnv = process.env): string {
	const listed = listRecords(env);
	const now = Date.now();
	if (options.id) {
		const found = listed.find(({ record }) => record.id === options.id || record.id.startsWith(options.id!));
		if (!found) return `no worker matches ${options.id}`;
		const transcript =
			options.view === "transcript" ? formatTranscript(readTranscript(found.record.runDir, { limit: options.limit ?? 40, maxBytes: 256 * 1024 })) : undefined;
		return renderRecord(found.record, { transcript, stale: found.stale });
	}
	const rows = listed
		.map(({ record, stale }) => ({ record, stale, summary: summarise(record, stale, now) }))
		.filter(({ summary }) => options.includeFinished || !["completed", "failed", "stopped", "timeout"].includes(summary.state) || options.view === "list");
	if (rows.length === 0) return "no workers tracked";
	if (options.view === "audit") {
		return readAudit(options.limit ?? 40, env)
			.map((entry) => `${entry.at}  ${entry.action.padEnd(9)} ${entry.id}  by ${entry.by ?? "?"}${entry.detail ? `  ${entry.detail}` : ""}`)
			.join("\n");
	}
	return rows.map(({ record, stale }) => recordSummaryLine(record, stale)).join("\n");
}

/* ------------------------------------------------------------ control actions */

export interface ControlAction {
	id: string;
	action: "steer" | "follow_up" | "abort" | "stop" | "answer";
	message?: string;
	value?: string;
}

export async function controlWorker(
	action: ControlAction,
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; message: string }> {
	const listed = listRecords(env);
	const found = listed.find(({ record }) => record.id === action.id || record.id.startsWith(action.id));
	if (!found) return { ok: false, message: `no worker matches ${action.id}` };
	const by = env.PI_SESSION_ID ? `session:${env.PI_SESSION_ID.slice(0, 8)}` : "session";
	try {
		const response = await sendControl(
			found.record.supervisor.socket,
			action.action === "steer"
				? { cmd: "steer", message: action.message ?? "", by }
				: action.action === "follow_up"
					? { cmd: "follow_up", message: action.message ?? "", by }
					: action.action === "answer"
						? { cmd: "answer", value: action.value ?? "", by }
						: { cmd: action.action, by },
		);
		if (!response.ok) return { ok: false, message: response.error ?? "control failed" };
		return { ok: true, message: `${action.action} delivered to ${found.record.id}` };
	} catch (error) {
		return { ok: false, message: `${action.action} failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/* ------------------------------------------------------------------ spawning */

export interface AwaitOptions {
	id: string;
	onProgress?: (line: string) => void;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
	intervalMs?: number;
	/** Extra time after the worker's own deadline before giving up on the supervisor. */
	graceMs?: number;
}

/** Wait for a worker to reach a terminal state, reporting progress as it goes. */
export async function awaitWorker(options: AwaitOptions): Promise<{ record?: WorkerRecord; aborted: boolean }> {
	const env = options.env ?? process.env;
	const interval = options.intervalMs ?? 900;
	const recordFile = path.join(stateDir(env), "workers", `${options.id}.json`);
	let aborted = false;
	const stop = (): void => {
		aborted = true;
	};
	options.signal?.addEventListener("abort", stop, { once: true });
	try {
		let lastLine = "";
		let hardDeadline = Date.now() + 6 * 60 * 60 * 1000;
		for (;;) {
			const listed = listRecords(env);
			const found = listed.find(({ record }) => record.id === options.id);
			const record = found?.record ?? readRecordFile(recordFile);
			if (!record) {
				if (aborted) return { aborted: true };
				if (!fs.existsSync(recordFile) && Date.now() > hardDeadline) {
					throw new Error(`worker ${options.id} never published a record`);
				}
				await sleep(interval);
				continue;
			}
			if (found) {
				const expiry = Date.parse(record.deadline.expiresAt);
				if (Number.isFinite(expiry)) hardDeadline = expiry + (options.graceMs ?? 60_000);
			}
			const line = recordSummaryLine(record, found?.stale ?? false);
			if (line !== lastLine) {
				lastLine = line;
				options.onProgress?.(line);
			}
			if (aborted) return { record, aborted: true };
			if (["completed", "failed", "timeout", "stopped"].includes(record.state)) return { record, aborted: false };
			if (found?.stale) return { record, aborted: false };
			if (Date.now() > hardDeadline) throw new Error(`worker ${options.id} exceeded its deadline`);
			await sleep(interval);
		}
	} finally {
		options.signal?.removeEventListener("abort", stop);
	}
}

/** Resolve a profile up front so a tool call fails before spawning a supervisor. */
export function resolveSelection(profile: string, thinking: string | undefined, env: NodeJS.ProcessEnv): { profilesFile: string; selection: ReturnType<typeof selectProfile> } {
	const file = resolveProfilesPath(undefined, env);
	if (!file) throw new Error(`No profiles.json found. Tried: ${profilesCandidates(env).join(", ")}. Set PI_ORCH_PROFILES or create ${path.join(stateDir(env), "config.json")}.`);
	const profiles = loadProfiles(file);
	return { profilesFile: file, selection: selectProfile(profiles, profile, thinking) };
}

export function listProfileNames(env: NodeJS.ProcessEnv): string {
	const file = resolveProfilesPath(undefined, env);
	if (!file) return "";
	try {
		return profileNames(loadProfiles(file)).join(", ");
	} catch {
		return "";
	}
}
