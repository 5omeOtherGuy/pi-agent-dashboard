/**
 * tmux integration.
 *
 * tmux is a convenience layer for the operator, never a correctness dependency:
 * subprocess calls have a timeout and never go through a shell, a missing tmux or
 * server degrades to "not available", and every command still explains what it did.
 */

import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { readConfig } from "./config.ts";
import { terminalSafe } from "./text.ts";
import * as fs from "node:fs";
import { listRecords, summarise, type ListedRecord } from "./registry.ts";
import type { WorkerRecord } from "./protocol.ts";
import { formatTranscript, readTranscript } from "./transcript.ts";

export const WORKER_WINDOW_OPTION = "@pi_worker_id";
export const WORKER_STATE_OPTION = "@pi_orch_state";

export interface TmuxResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	code: number;
}

export interface TmuxWindow {
	id: string;
	name: string;
	paneId: string;
	panePid: number;
	workerId?: string;
	active: boolean;
}

const TIMEOUT_MS = 4000;

/** tmux socket name; tests and multi-operator machines can isolate servers with `-L`. */
let socketName: string | undefined;

export function setTmuxSocket(socket: string | undefined): void {
	socketName = socket;
}

/** Run one tmux command. Never throws: a failure is reported in the result. */
export function tmux(args: string[], timeoutMs = TIMEOUT_MS): TmuxResult {
	const argv = socketName ? ["-L", socketName, ...args] : args;
	try {
		const stdout = execFileSync("tmux", argv, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
		return { ok: true, stdout, stderr: "", code: 0 };
	} catch (error) {
		const failure = error as { stdout?: string; stderr?: string; status?: number; code?: string };
		return {
			ok: false,
			stdout: typeof failure.stdout === "string" ? failure.stdout : "",
			stderr: typeof failure.stderr === "string" ? failure.stderr : (failure.code ?? String(error)),
			code: typeof failure.status === "number" ? failure.status : -1,
		};
	}
}

/** True when tmux is installed and a server is reachable. */
let readyCache: boolean | undefined;

/** Readiness never changes during one command, and a hung tmux would otherwise cost 4s per probe. */
export function tmuxReady(): boolean {
	if (readyCache !== undefined) return readyCache;
	readyCache = tmux(["-V"]).ok && tmux(["display-message", "-p", "#{session_name}"]).ok;
	return readyCache;
}

export function tmuxVersion(): string | undefined {
	const result = tmux(["-V"]);
	return result.ok ? result.stdout.trim() : undefined;
}

/** Window name as tmux sees it, used to confirm a window before claiming it. */
export function windowName(windowId: string): string | undefined {
	const result = tmux(["display-message", "-p", "-t", windowId, "#{window_name}"]);
	return result.ok ? result.stdout.trim() || undefined : undefined;
}

/**
 * Claim a window for a worker. A window that already belongs to a different worker is left
 * alone: two supervisors or a watcher must never fight over one window's name and metadata.
 */
export function claimWindow(windowId: string, workerId: string): boolean {
	const owner = getWindowOption(windowId, WORKER_WINDOW_OPTION);
	if (owner && owner !== workerId) return false;
	return setWindowOption(windowId, WORKER_WINDOW_OPTION, workerId);
}

/** Last lines of a pane, for reporting why a windowed worker died. */
export function capturePane(paneId: string, lines = 12): string | undefined {
	const result = tmux(["capture-pane", "-p", "-t", paneId]);
	if (!result.ok) return undefined;
	return result.stdout.replace(/\s+$/g, "").split("\n").slice(-lines).join("\n");
}

/** Window id owning a pane; the pane learns its own window this way. */
export function windowIdForPane(paneId: string): string | undefined {
	const result = tmux(["display-message", "-p", "-t", paneId, "#{window_id}"]);
	return result.ok ? result.stdout.trim() || undefined : undefined;
}

export interface WorkerWindow {
	windowId: string;
	paneId: string;
}

export interface OpenWindowOptions {
	name: string;
	command: string[];
	cwd?: string;
	/** Keep the pane after the command exits, so a failure stays readable. */
	remainOnExit?: boolean;
	/** Environment for the new window. A tmux server starts children with its own environment, so anything the worker needs must be passed explicitly. */
	env?: Record<string, string>;
}

/** tmux 3.2 added `new-window -e`; older servers inherit the server environment only. */
export function supportsEnvFlag(): boolean {
	const version = tmuxVersion();
	if (!version) return false;
	const match = /tmux (\d+)\.(\d+)/.exec(version);
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major > 3 || (major === 3 && minor >= 2);
}

/** Open a detached window running `command`. */
export function openWindow(options: OpenWindowOptions): WorkerWindow | undefined {
	const args = ["new-window", "-d", "-P", "-F", "#{window_id} #{pane_id}", "-n", sanitiseWindowName(options.name)];
	if (options.cwd) args.push("-c", options.cwd);
	for (const [key, value] of Object.entries(options.env ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
		if (value === undefined || value === null) continue;
		args.push("-e", `${key}=${value}`);
	}
	args.push("--", ...options.command);
	const result = tmux(args);
	if (!result.ok) return undefined;
	const [windowId, paneId] = result.stdout.trim().split(/\s+/);
	if (!windowId || !paneId) return undefined;
	// Set in a second call: a `;`-chained command would expand #{window_id} in the
	// previous window's context, not the one just created.
	if (options.remainOnExit) setWindowOption(windowId, "remain-on-exit", "on");
	return { windowId, paneId };
}

/** Split the current window and run a command in the new pane (a watch pane). */
export function splitPane(options: { command: string[]; cwd?: string; horizontal?: boolean; size?: string; env?: NodeJS.ProcessEnv }): string | undefined {
	// A new pane inherits the tmux *server* environment, not the caller's, so a watcher needs
	// the same explicit -e passthrough a worker window gets.
	const envNames = options.env ? Object.keys(options.env).filter((key) => options.env![key] !== undefined) : [];
	const withEnv = envNames.length > 0 && supportsEnvFlag();
	if (withEnv && !tmuxReady()) return undefined;
	const args = ["split-window", "-P", "-F", "#{pane_id}"];
	if (options.horizontal) args.push("-h");
	if (options.size) args.push("-l", options.size);
	if (options.cwd) args.push("-c", options.cwd);
	if (withEnv) for (const key of envNames) args.push("-e", `${key}=${options.env![key]}`);
	args.push("--", ...options.command);
	const result = tmux(args);
	return result.ok ? result.stdout.trim() || undefined : undefined;
}

export function focusWindow(windowId: string): boolean {
	return tmux(["select-window", "-t", windowId]).ok;
}

export function killWindow(windowId: string): boolean {
	return tmux(["kill-window", "-t", windowId]).ok;
}

export function renameWindow(windowId: string, name: string): boolean {
	return tmux(["rename-window", "-t", windowId, sanitiseWindowName(name)]).ok;
}

export function setWindowOption(windowId: string, key: string, value: string): boolean {
	return tmux(["set-window-option", "-t", windowId, key, value]).ok;
}

export function getWindowOption(windowId: string, key: string): string | undefined {
	const result = tmux(["show-options", "-w", "-v", "-t", windowId, key]);
	const value = result.stdout.trim();
	return result.ok && value ? value : undefined;
}

export function listWindows(): TmuxWindow[] {
	const format = ["#{window_id}", "#{window_name}", "#{pane_id}", "#{pane_pid}", "#{?window_active,1,0}", `#{${WORKER_WINDOW_OPTION}}`].join("\t");
	const result = tmux(["list-windows", "-a", "-F", format]);
	if (!result.ok) return [];
	const windows: TmuxWindow[] = [];
	for (const line of result.stdout.split("\n")) {
		if (!line.trim()) continue;
		const [id, name, paneId, panePid, active, workerId] = line.split("\t");
		if (!id || !paneId) continue;
		const window: TmuxWindow = { id, name: name ?? "", paneId, panePid: Number(panePid ?? 0), active: active === "1" };
		if (workerId) window.workerId = workerId;
		windows.push(window);
	}
	return windows;
}

export function findWorkerWindow(workerId: string): TmuxWindow | undefined {
	return listWindows().find((window) => window.workerId === workerId);
}

/** One line for `status-left`/`status-right`: one directory scan, no JSON, no transcript reads. */
export function statusline(env: NodeJS.ProcessEnv = process.env): string {
	const listed = listRecords(env);
	const active = listed.filter(({ record, stale }) => !stale && ["starting", "running", "awaiting-input"].includes(record.state));
	if (active.length === 0) {
		const finished = listed.filter(({ record }) => ["completed", "failed", "stopped", "timeout"].includes(record.state)).length;
		return finished > 0 ? `⚙ idle ${finished}` : "⚙ none";
	}
	const waiting = active.filter(({ record }) => record.state === "awaiting-input").length;
	const lead = active[0]?.record;
	const activity = terminalSafe(lead?.activity.toolDetail ?? lead?.activity.tool, 60);
	const text = `⚙${active.length}${waiting > 0 ? ` ◍${waiting}` : ""} ${terminalSafe(lead?.worker.profile, 10)} ${activity}`;
	return text.replace(/\s+/g, " ").trim().slice(0, 80);
}

/** A compact board for any pane or popup, with no Pi session involved. */
export function renderBoard(env: NodeJS.ProcessEnv = process.env, width = 110, options: { color?: boolean } = {}): string[] {
	const color = options.color !== false;
	const listed = listRecords(env, { staleMs: readConfig(env).staleMs });
	const rows = listed.map(({ record, stale }) => summarise(record, stale));
	const active = rows.filter((row) => ["starting", "running", "awaiting-input"].includes(row.state));
	const paint = (code: string, text: string): string => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
	const tone = (state: string, text: string): string => {
		const code = state === "running" || state === "starting" ? "32" : state === "awaiting-input" ? "33" : state === "completed" ? "36" : state === "stale" ? "35" : "31";
		return paint(code, text);
	};
	const lines: string[] = [];
	lines.push(`${paint("1", "Agents")}  ${active.length} active · ${rows.length} tracked`);
	lines.push(paint("2", "─".repeat(Math.max(20, Math.min(width - 1, 140)))));
	if (rows.length === 0) {
		lines.push(paint("2", "no workers tracked"));
		return lines;
	}
	for (const row of rows) {
		const activity = terminalSafe(row.toolDetail ?? row.tool ?? row.text ?? row.outcome, 60);
		const line = ` ${tone(row.state, stateGlyph(row.state))} ${row.id}  ${terminalSafe(row.profile, 18).padEnd(18)} ${terminalSafe(row.thinking, 6).padEnd(6)} ${row.state.padEnd(15)} ${String(row.ageSeconds).padStart(6)}s  ${terminalSafe(row.hostLabel, 18).padEnd(18)} ${activity}`;
		lines.push(line.length > width ? line.slice(0, width - 1) : line);
	}
	const waiting = rows.filter((row) => row.needsInput);
	if (waiting.length > 0) {
		lines.push("");
		for (const row of waiting) lines.push(` ${tone("awaiting-input", "◍")} ${row.id} awaiting input: ${row.outcome ?? ""}`);
	}
	return lines;
}

export function stateGlyph(state: string): string {
	if (state === "running" || state === "starting") return "●";
	if (state === "awaiting-input") return "◍";
	if (state === "completed") return "✓";
	if (state === "stopped") return "■";
	if (state === "stale") return "?";
	return "✗";
}

/**
 * Window name for a worker. Deliberately state-independent: renaming a window breaks
 * `tmux send-keys -t <name>`, binding targets and the operator's habits, so state lives
 * in the @pi_orch_state window option instead.
 */
export function workerWindowName(input: { id: string; profile?: string }): string {
	const profile = input.profile ? ` ${input.profile.slice(0, 12)}` : "";
	return sanitiseWindowName(`${input.id}${profile}`);
}

export interface WatchOptions {
	follow?: boolean;
	env?: NodeJS.ProcessEnv;
	intervalMs?: number;
	quiet?: boolean;
	onLines?: (lines: string[]) => void;
}

/**
 * Follow a worker's recorded events as a readable transcript. Read-only: it never
 * opens the worker's session file, so it is safe while the worker is running.
 */
export async function watchWorker(id: string, options: WatchOptions = {}): Promise<number> {
	const env = options.env ?? process.env;
	const interval = options.intervalMs ?? 1000;
	let printed = 0;
	let announcedEnd = false;
	let labelled = false;
	for (;;) {
		const listed: ListedRecord[] = listRecords(env);
		const found = listed.find((item) => item.record.id === id || item.record.id.startsWith(id));
		const record = found?.record;
		if (!record) {
			process.stderr.write(`no worker matches ${id}\n`);
			return 1;
		}
		if (!labelled && env.TMUX_PANE) {
			// The window hosting the watcher becomes the target for `--current` actions, but only
			// if it is free: a watcher must never relabel a window that belongs to another worker.
			labelled = true;
			const windowId = windowIdForPane(env.TMUX_PANE);
			if (windowId) {
				if (claimWindow(windowId, record.id)) {
					renameWindow(windowId, workerWindowName({ id: record.id, profile: record.worker.profile }));
					setWindowOption(windowId, "automatic-rename", "off");
				} else if (!options.quiet) {
					process.stderr.write(`watching ${record.id} in a window owned by another worker (left as is)\n`);
				}
			}
		}
		const text = formatTranscript(readTranscript(record.runDir, { limit: 400, maxBytes: 512 * 1024 }));
		if (text.length > printed) {
			options.onLines?.(text.slice(printed));
			printed = text.length;
			if (!options.follow) return 0;
		}
		const terminal = ["completed", "failed", "stopped", "timeout"].includes(record.state);
		if (terminal && !announcedEnd) {
			announcedEnd = true;
			options.onLines?.([`── worker ${record.id} ${record.state}${record.result?.seconds ? ` in ${record.result.seconds}s` : ""}`]);
			if (!options.follow) return 0;
			if (found && !found.stale) return 0;
		}
		await new Promise((resolve) => setTimeout(resolve, interval));
	}
}

/** tmux window names may not contain control characters or quotes. */
export function sanitiseWindowName(name: string): string {
	const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, "").replace(/["$`\\]/g, "");
	return (cleaned.slice(0, 48) || "worker").trim();
}
