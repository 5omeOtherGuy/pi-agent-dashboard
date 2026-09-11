/**
 * Cross-process registry: `<state>/workers/<id>.json` records plus `audit.jsonl`.
 *
 * Layout (one writer per record file, any number of readers):
 *   <state>/workers/<id>.json       worker record (atomic temp+rename)
 *   <state>/workers/<id>.ctl.sock   control socket owned by the supervisor
 *   <state>/audit.jsonl             append-only control audit trail
 *   <state>/cli                     path pointer to this package's CLI
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { terminalSafe } from "./text.ts";
import * as os from "node:os";
import * as path from "node:path";
import {
	type WorkerRecord,
	type WorkerSummary,
	type WorkerState,
	RECORD_VERSION,
	isWorkerState,
	isTerminal,
} from "./protocol.ts";

/** Heartbeat age after which a record is considered abandoned. */
export const DEFAULT_STALE_MS = 45_000;

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_ORCH_STATE_DIR ?? path.join(agentDir(env), "subagent-dashboard");
}

export function workersDir(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(stateDir(env), "workers");
}

export function recordPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
	return path.join(workersDir(env), `${id}.json`);
}

export function socketPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
	return path.join(workersDir(env), `${id}.ctl.sock`);
}

export function auditPath(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(stateDir(env), "audit.jsonl");
}

export function cliPointerPath(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(stateDir(env), "cli");
}

/**
 * The CLI records its own absolute path here so shell helpers (the orchestration
 * skill's `pi_worker.py` shim) can find it without a PATH dependency.
 */
export function writeCliPointer(cliPath: string, env: NodeJS.ProcessEnv = process.env): void {
	try {
		ensureStateDirs(env);
		atomicWriteFile(cliPointerPath(env), `${cliPath}\n`);
	} catch {
		// Best effort: a missing pointer only affects helper discovery.
	}
}

export function readCliPointer(env: NodeJS.ProcessEnv = process.env): string | undefined {
	try {
		const value = fs.readFileSync(cliPointerPath(env), "utf8").trim();
		return value && fs.existsSync(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/** `w_` + 8 hex chars. Ids are chosen by the caller so detached launches can be polled. */
export function newWorkerId(): string {
	return `w_${randomBytes(4).toString("hex")}`;
}

export function ensureStateDirs(env: NodeJS.ProcessEnv = process.env): void {
	fs.mkdirSync(workersDir(env), { recursive: true, mode: 0o700 });
	try {
		fs.chmodSync(stateDir(env), 0o700);
	} catch {
		// Best effort: an existing directory may be owned by another user or on a filesystem without modes.
	}
}

/** Write `contents` to `file` via a unique temp file plus rename, so readers never see a partial file. */
export function atomicWriteFile(file: string, contents: string, mode = 0o600): void {
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	fs.writeFileSync(tmp, contents, { mode });
	try {
		fs.renameSync(tmp, file);
	} catch (error) {
		fs.rmSync(tmp, { force: true });
		throw error;
	}
}

export function writeRecord(record: WorkerRecord, env: NodeJS.ProcessEnv = process.env): void {
	ensureStateDirs(env);
	atomicWriteFile(recordPath(record.id, env), `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Throttled record writer. Long runs must not rewrite the record on every stream
 * delta; state changes and heartbeats force a flush.
 */
export class RecordFile {
	readonly record: WorkerRecord;
	private lastWrite = 0;
	private readonly env: NodeJS.ProcessEnv;
	private readonly minIntervalMs: number;

	constructor(record: WorkerRecord, minIntervalMs = 400, env: NodeJS.ProcessEnv = process.env) {
		this.record = record;
		this.minIntervalMs = minIntervalMs;
		this.env = env;
	}

	touch(tool?: string, detail?: string): void {
		this.record.updatedAt = nowIso();
		this.record.heartbeatAt = this.record.updatedAt;
		if (tool !== undefined) this.record.activity.tool = tool;
		if (detail !== undefined) this.record.activity.toolDetail = detail;
		this.save();
	}

	write(): void {
		this.lastWrite = Date.now();
		writeRecord(this.record, this.env);
	}

	save(force = false): void {
		const now = Date.now();
		if (!force && now - this.lastWrite < this.minIntervalMs) return;
		this.write();
	}
}

export function nowIso(): string {
	return new Date().toISOString();
}

/* -------------------------------------------------------------- record reads */

function isObj(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function obj(value: unknown): Record<string, unknown> {
	return isObj(value) ? value : {};
}

function str(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function strArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Narrow an unknown JSON value into a WorkerRecord, filling missing optional
 * fields with safe defaults. Returns undefined when the value cannot be a record
 * at all, so a corrupted file never takes down the dashboard.
 */
export function narrowRecord(value: unknown): WorkerRecord | undefined {
	if (!isObj(value)) return undefined;
	const id = str(value.id);
	if (!id) return undefined;
	const state: WorkerState = isWorkerState(value.state) ? value.state : "stale";
	const worker = obj(value.worker);
	const host = obj(value.host);
	const supervisor = obj(value.supervisor);
	const brief = obj(value.brief);
	const activity = obj(value.activity);
	const controls = obj(value.controls);
	const deadline = obj(value.deadline);
	const resultValue = isObj(value.result) ? value.result : undefined;
	const createdAt = str(value.createdAt) || nowIso();

	const record: WorkerRecord = {
		version: num(value.version, RECORD_VERSION),
		id,
		state,
		phase: (str(value.phase, "done") as WorkerRecord["phase"]) || "done",
		createdAt,
		updatedAt: str(value.updatedAt) || createdAt,
		heartbeatAt: str(value.heartbeatAt) || createdAt,
		host: {
			sessionId: str(host.sessionId) || undefined,
			sessionFile: str(host.sessionFile) || undefined,
			cwd: str(host.cwd),
			label: str(host.label, "session"),
		},
		supervisor: {
			pid: num(supervisor.pid),
			socket: str(supervisor.socket),
			cli: str(supervisor.cli),
		},
		worker: {
			profile: str(worker.profile),
			provider: str(worker.provider),
			model: str(worker.model),
			thinking: str(worker.thinking),
			tools: (str(worker.tools, "read") as WorkerRecord["worker"]["tools"]) || "read",
			cwd: str(worker.cwd),
			sessionFile: str(worker.sessionFile),
			trust: str(worker.trust, "saved"),
			pid: typeof worker.pid === "number" ? worker.pid : undefined,
		},
		brief: {
			path: str(brief.path),
			bytes: num(brief.bytes),
			sha256: str(brief.sha256),
			excerpt: str(brief.excerpt),
			outcome: str(brief.outcome) || undefined,
			definitionOfDone: strArray(brief.definitionOfDone),
			checks: strArray(brief.checks),
			logPath: str(brief.logPath) || undefined,
		},
		runDir: str(value.runDir),
		deadline: { seconds: num(deadline.seconds), expiresAt: str(deadline.expiresAt) },
		activity: {
			input: num(activity.input),
			output: num(activity.output),
			cacheRead: num(activity.cacheRead),
			cacheWrite: num(activity.cacheWrite),
			cost: num(activity.cost),
			contextTokens: num(activity.contextTokens),
			turns: num(activity.turns),
			toolCalls: num(activity.toolCalls),
			toolErrors: num(activity.toolErrors),
			tool: str(activity.tool) || undefined,
			toolDetail: str(activity.toolDetail) || undefined,
			text: str(activity.text) || undefined,
			lastEventAt: str(activity.lastEventAt) || undefined,
		},
		controls: {
			steers: num(controls.steers),
			followUps: num(controls.followUps),
			lastSteerAt: str(controls.lastSteerAt) || undefined,
			lastSteerBy: str(controls.lastSteerBy) || undefined,
			rejections: num(controls.rejections),
			lastRejectionAt: str(controls.lastRejectionAt) || undefined,
			lastRejectionError: str(controls.lastRejectionError) || undefined,
		},
	};
	if (str(value.endedAt)) record.endedAt = str(value.endedAt);
	if (isObj(value.tmux)) {
		const windowId = str(value.tmux.windowId);
		const paneId = str(value.tmux.paneId);
		if (windowId && paneId) {
			record.tmux = { windowId, paneId };
			if (str(value.tmux.name)) record.tmux.name = str(value.tmux.name);
		}
	}
	if (isObj(value.workspace)) {
		const workspace = value.workspace;
		const evidence: Record<string, unknown> = { vcs: workspace.vcs === "git" ? "git" : "none" };
		for (const key of ["revisionBefore", "revisionAfter", "diffStat"]) {
			if (typeof workspace[key] === "string") evidence[key] = workspace[key];
		}
		for (const key of ["dirtyBefore", "dirtyAfter"]) {
			if (typeof workspace[key] === "number") evidence[key] = workspace[key];
		}
		if (Array.isArray(workspace.changedFiles)) evidence.changedFiles = strArray(workspace.changedFiles);
		record.workspace = evidence as unknown as WorkerRecord["workspace"];
	}
	if (str(value.error)) record.error = str(value.error);
	if (isObj(value.pendingInput)) {
		const pending = value.pendingInput;
		record.pendingInput = {
			id: str(pending.id),
			method: str(pending.method),
			title: str(pending.title) || undefined,
			message: str(pending.message) || undefined,
			options: Array.isArray(pending.options) ? strArray(pending.options) : undefined,
			prefill: str(pending.prefill) || undefined,
			requestedAt: str(pending.requestedAt) || createdAt,
		};
	}
	if (resultValue) {
		record.result = {
			status: str(resultValue.status, "failed"),
			path: str(resultValue.path),
			text: str(resultValue.text) || undefined,
			error: str(resultValue.error) || undefined,
			seconds: typeof resultValue.seconds === "number" ? resultValue.seconds : undefined,
			checks: { log: (str(obj(resultValue.checks).log, "skipped") as "ok" | "missing" | "empty" | "unfilled" | "skipped") || "skipped" },
		};
	}
	return record;
}

export function readRecordFile(file: string): WorkerRecord | undefined {
	try {
		return narrowRecord(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch {
		return undefined;
	}
}

export function readRecord(id: string, env: NodeJS.ProcessEnv = process.env): WorkerRecord | undefined {
	return readRecordFile(recordPath(id, env));
}

export interface ListedRecord {
	record: WorkerRecord;
	stale: boolean;
	pidAlive: boolean;
}

/** True when a pid exists and is signalable by this process. */
export function pidAlive(pid: number | undefined): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function isStale(record: WorkerRecord, now = Date.now(), staleMs = DEFAULT_STALE_MS): boolean {
	if (record.state === "stale") return true;
	if (isTerminal(record.state)) return false;
	if (!pidAlive(record.supervisor.pid)) return true;
	const heartbeat = Date.parse(record.heartbeatAt);
	return !Number.isFinite(heartbeat) || now - heartbeat > staleMs;
}

export function listRecords(env: NodeJS.ProcessEnv = process.env, options: { staleMs?: number } = {}): ListedRecord[] {
	const dir = workersDir(env);
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const listed: ListedRecord[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const record = readRecordFile(path.join(dir, name));
		if (!record) continue;
		const alive = pidAlive(record.supervisor.pid);
		listed.push({ record, pidAlive: alive, stale: isStale(record, Date.now(), options.staleMs ?? DEFAULT_STALE_MS) });
	}
	listed.sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt));
	return listed;
}

export function summarise(record: WorkerRecord, stale: boolean, now = Date.now()): WorkerSummary {
	const age = (now - Date.parse(record.createdAt)) / 1000;
	const last = Date.parse(record.activity.lastEventAt ?? record.updatedAt);
	return {
		id: terminalSafe(record.id, 64),
		state: stale && !isTerminal(record.state) ? "stale" : record.state,
		phase: record.phase,
		profile: record.worker.profile,
		model: record.worker.model,
		thinking: record.worker.thinking,
		tools: record.worker.tools,
		hostLabel: terminalSafe(record.host.label, 60),
		hostSessionId: record.host.sessionId,
		outcome: terminalSafe(record.brief.outcome, 200),
		tool: terminalSafe(record.activity.tool, 60),
		toolDetail: terminalSafe(record.activity.toolDetail, 160),
		text: record.activity.text,
		ageSeconds: Number.isFinite(age) ? Math.round(age) : 0,
		idleSeconds: Number.isFinite(last) ? Math.round((now - last) / 1000) : 0,
		turns: record.activity.turns,
		toolCalls: record.activity.toolCalls,
		cost: record.activity.cost,
		contextTokens: record.activity.contextTokens,
		needsInput: record.state === "awaiting-input",
		runDir: record.runDir,
		sessionFile: record.worker.sessionFile,
	};
}

/** Cheap change detector for pollers: any field a dashboard renders lives in here. */
export function workerRecordFingerprint(record: WorkerRecord): string {
	return [
		record.id,
		record.state,
		record.phase,
		record.updatedAt,
		record.heartbeatAt,
		record.activity.tool ?? "",
		record.activity.toolDetail ?? "",
		record.activity.turns,
		record.activity.toolCalls,
		record.controls.steers,
		record.pendingInput?.id ?? "",
		record.result?.status ?? "",
		record.error ?? "",
		record.tmux?.windowId ?? "",
	].join(";");
}

export function removeRecord(id: string, env: NodeJS.ProcessEnv = process.env): void {
	fs.rmSync(recordPath(id, env), { force: true });
	fs.rmSync(socketPath(id, env), { force: true });
}

export interface CleanResult {
	removed: string[];
	kept: string[];
	/** What removal actually deletes, spelled out so callers can display it. */
	scope: string;
}

/** The only files `removeRecord` (and therefore `cleanRecords`) ever touches. */
export const CLEAN_SCOPE =
	"registry entry and control socket only; run directories, logs and session files are kept";

export interface CleanOptions {
	/** Remove every finished (terminal-state) record, regardless of age. */
	allTerminal?: boolean;
}

/**
 * Remove abandoned or finished records.
 *
 * Retention rules:
 * - a record whose supervisor pid is alive is always kept, whatever its state;
 * - a record in a live state (`starting`/`running`/`awaiting-input`) is kept unless
 *   it is abandoned (dead supervisor pid or an over-age heartbeat) and past the gate;
 * - a finished (terminal-state) record is removed once its last update is older than
 *   `olderThanMs`, or immediately when `allTerminal` is set.
 *
 * Deletion is limited to the record file and its control socket: run directories,
 * logs and session files are never touched. Terminal is not the same thing as stale,
 * so finished records age out even though `isStale()` treats them as current.
 */
export function cleanRecords(
	olderThanMs: number,
	env: NodeJS.ProcessEnv = process.env,
	options: CleanOptions = {},
): CleanResult {
	const removed: string[] = [];
	const kept: string[] = [];
	const now = Date.now();
	for (const { record, stale, pidAlive: alive } of listRecords(env)) {
		const updated = Date.parse(record.updatedAt);
		const old = Number.isFinite(updated) && now - updated > olderThanMs;
		let remove = false;
		if (!alive) {
			remove = isTerminal(record.state) ? options.allTerminal === true || old : stale && old;
		}
		if (remove) {
			removeRecord(record.id, env);
			removed.push(record.id);
		} else {
			kept.push(record.id);
		}
	}
	return { removed, kept, scope: CLEAN_SCOPE };
}

/* --------------------------------------------------------------- audit trail */

export interface AuditEntry {
	at: string;
	action: string;
	id: string;
	by?: string;
	from?: string;
	cwd?: string;
	detail?: string;
}

/** Append one control action. Records are small and written with O_APPEND, so concurrent appends interleave whole lines. */
export function appendAudit(entry: Omit<AuditEntry, "at">, env: NodeJS.ProcessEnv = process.env): void {
	try {
		ensureStateDirs(env);
		fs.appendFileSync(auditPath(env), `${JSON.stringify({ at: nowIso(), ...entry })}\n`, { mode: 0o600 });
	} catch {
		// Audit is best-effort: never fail a control command because the trail could not be written.
	}
}

export function readAudit(limit = 200, env: NodeJS.ProcessEnv = process.env): AuditEntry[] {
	try {
		const lines = fs.readFileSync(auditPath(env), "utf8").split("\n").filter(Boolean);
		return lines.slice(-limit).map((line) => JSON.parse(line) as AuditEntry);
	} catch {
		return [];
	}
}
