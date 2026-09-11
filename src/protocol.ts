/**
 * Wire + on-disk shapes shared by the CLI supervisor and the Pi extension.
 *
 * Records are written by exactly one supervisor process each (atomic temp+rename),
 * and read by any number of dashboards. Readers must tolerate unknown fields and
 * missing optional fields: records may have been written by a different version.
 */

export const RECORD_VERSION = 1;
export const CONTROL_VERSION = 1;

export type WorkerState =
	| "starting"
	| "running"
	| "awaiting-input"
	| "completed"
	| "failed"
	| "timeout"
	| "stopped"
	| "stale";

export type WorkerPhase =
	| "starting"
	| "thinking"
	| "tool"
	| "compacting"
	| "retrying"
	| "input"
	| "idle"
	| "done";

export type ToolSet = "read" | "write" | "none";

export type InputPolicy = "fail" | "park";

export interface WorkerUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
	toolCalls: number;
	toolErrors: number;
}

export interface WorkerActivity extends WorkerUsage {
	tool?: string;
	toolDetail?: string;
	text?: string;
	lastEventAt?: string;
}

export interface PendingInput {
	id: string;
	method: string;
	title?: string;
	message?: string;
	options?: string[];
	prefill?: string;
	requestedAt: string;
}

export interface WorkerBrief {
	path: string;
	bytes: number;
	sha256: string;
	excerpt: string;
	outcome?: string;
	definitionOfDone: string[];
	checks: string[];
	logPath?: string;
}

export interface HostInfo {
	sessionId?: string;
	sessionFile?: string;
	cwd: string;
	label: string;
}

export interface SupervisorInfo {
	pid: number;
	socket: string;
	cli: string;
}

export interface WorkerSelection {
	profile: string;
	provider: string;
	model: string;
	thinking: string;
	tools: ToolSet;
	cwd: string;
	sessionFile: string;
	trust: string;
	pid?: number;
}

export interface LogCheck {
	log: "ok" | "missing" | "empty" | "unfilled" | "skipped";
	detail?: string;
}

/**
 * Deterministic evidence about the workspace a worker ran in. Best effort: a missing
 * git, or a non-repository cwd, records `vcs: "none"` rather than failing the run.
 */
export interface WorkspaceEvidence {
	vcs: "git" | "none";
	revisionBefore?: string;
	revisionAfter?: string;
	dirtyBefore?: number;
	dirtyAfter?: number;
	diffStat?: string;
	changedFiles?: string[];
}

export interface WorkerResult {
	status: string;
	path: string;
	text?: string;
	error?: string;
	seconds?: number;
	usage?: WorkerUsage;
	checks: LogCheck;
}

export interface WorkerControls {
	steers: number;
	followUps: number;
	lastSteerAt?: string;
	lastSteerBy?: string;
	/** Control calls (steer, follow_up, answer) Pi rejected; newest failure kept. */
	rejections?: number;
	lastRejectionAt?: string;
	lastRejectionError?: string;
}

export interface WorkerRecord {
	version: number;
	id: string;
	state: WorkerState;
	phase: WorkerPhase;
	createdAt: string;
	updatedAt: string;
	heartbeatAt: string;
	endedAt?: string;

	host: HostInfo;
	supervisor: SupervisorInfo;
	worker: WorkerSelection;
	brief: WorkerBrief;
	runDir: string;
	deadline: { seconds: number; expiresAt: string };

	activity: WorkerActivity;
	pendingInput?: PendingInput;
	controls: WorkerControls;
	workspace?: WorkspaceEvidence;
	/** tmux window hosting the worker, when window mode is enabled. */
	tmux?: { windowId: string; paneId: string; name?: string };
	result?: WorkerResult;
	error?: string;
}

/* ------------------------------------------------------------------ control */

/** Every control command may carry the id of the requester for the audit trail. */
export interface ControlBase {
	id?: string;
	by?: string;
}

export type ControlRequest =
	| (ControlBase & { cmd: "status" })
	| (ControlBase & { cmd: "steer"; message: string })
	| (ControlBase & { cmd: "follow_up"; message: string })
	| (ControlBase & { cmd: "abort" })
	| (ControlBase & { cmd: "stop" })
	| (ControlBase & { cmd: "answer"; value?: string; cancelled?: boolean })
	| (ControlBase & { cmd: "log"; lines?: number });

export interface ControlResponse {
	version: number;
	id?: string;
	ok: boolean;
	data?: unknown;
	error?: string;
}

/** A compact, stable summary used by list views and by the lead model's tools. */
export interface WorkerSummary {
	id: string;
	state: WorkerState;
	phase: WorkerPhase;
	profile: string;
	model: string;
	thinking: string;
	tools: ToolSet;
	hostLabel: string;
	hostSessionId?: string;
	outcome?: string;
	tool?: string;
	toolDetail?: string;
	text?: string;
	ageSeconds: number;
	idleSeconds: number;
	turns: number;
	toolCalls: number;
	cost: number;
	contextTokens: number;
	needsInput: boolean;
	runDir: string;
	sessionFile: string;
}

export function isWorkerState(value: unknown): value is WorkerState {
	return (
		value === "starting" ||
		value === "running" ||
		value === "awaiting-input" ||
		value === "completed" ||
		value === "failed" ||
		value === "timeout" ||
		value === "stopped" ||
		value === "stale"
	);
}

/** States in which no supervisor is expected to make further progress. */
export function isTerminal(state: WorkerState): boolean {
	return state !== "starting" && state !== "running" && state !== "awaiting-input";
}
