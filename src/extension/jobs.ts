/**
 * Small job runner for dashboard actions: one instance per dashboard, serialising
 * work per key, keeping the last error, and implementing "open this worker's
 * session" in a new tmux window.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { findWorkerWindow, focusWindow, splitPane } from "../tmux.ts";
import { readCliPointer } from "../registry.ts";
import type { WorkerRecord } from "../protocol.ts";

export interface JobRunnerOptions {
	env?: NodeJS.ProcessEnv;
	piCommand?: string;
	onResult?: (message: string, level: "info" | "warning" | "error") => void;
}

export class JobRunner {
	lastError?: string;
	private readonly running = new Set<string>();
	private readonly env: NodeJS.ProcessEnv;
	private readonly piCommand: string;
	private readonly onResult: ((message: string, level: "info" | "warning" | "error") => void) | undefined;

	constructor(options: JobRunnerOptions = {}) {
		this.env = options.env ?? process.env;
		this.piCommand = options.piCommand ?? options.env?.PI_ORCH_PI ?? "pi";
		this.onResult = options.onResult;
	}

	/** Run `fn` unless a job with the same key is already in flight. Errors are captured, never thrown into the TUI. */
	async run<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
		if (this.running.has(key)) return undefined;
		this.running.add(key);
		try {
			const result = await fn();
			this.lastError = undefined;
			return result;
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
			this.onResult?.(this.lastError, "error");
			return undefined;
		} finally {
			this.running.delete(key);
		}
	}

	/**
	 * Continue a finished worker's session in a new tmux window. Opening it while the
	 * worker still owns the session would be a second writer, so callers must check state.
	 */
	async openSession(sessionFile: string, workerId: string): Promise<void> {
		if (!this.env.TMUX) {
			throw new Error(`not inside tmux; run: ${this.piCommand} --session ${sessionFile}`);
		}
		if (!fs.existsSync(sessionFile)) throw new Error(`session file missing: ${sessionFile}`);
		const windowName = `agent-${workerId}`.slice(0, 32);
		await new Promise<void>((resolve, reject) => {
			// The spine may be pinned to an isolated server; a raw spawn must follow it.
			const server = this.env.PI_ORCH_TMUX_SOCKET ? ["-L", this.env.PI_ORCH_TMUX_SOCKET] : [];
			const child = spawn("tmux", [...server, "new-window", "-n", windowName, "--", this.piCommand, "--session", sessionFile], {
				stdio: ["ignore", "ignore", "pipe"],
				env: this.env,
			});
			let stderr = "";
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			child.on("error", (error) => reject(new Error(`tmux not available: ${error.message}`)));
			child.on("close", (code) => {
				if (code === 0) resolve();
				else reject(new Error(`tmux new-window failed (${code}): ${stderr.trim()}`));
			});
		});
	}

	/** Jump to the tmux window hosting a worker, when one exists. */
	focusWorker(record: WorkerRecord): boolean {
		const target = findWorkerWindow(record.id)?.id ?? record.tmux?.windowId;
		if (!target) return false;
		return focusWindow(target);
	}

	/** Open a read-only watch pane for a worker; safe while it is still running. */
	watchWorker(record: WorkerRecord): string | undefined {
		if (!this.env.TMUX) return undefined;
		const cli = readCliPointer(this.env);
		const command = cli ? [process.execPath, cli, "watch", record.id, "--follow"] : [this.piCommand, "--session", record.worker.sessionFile];
		return splitPane({ command, cwd: record.worker.cwd, size: "40%", env: this.env });
	}

	/** Path shown in notices so the user can act on it even without tmux. */
	sessionCommand(sessionFile: string): string {
		return `${this.piCommand} --session ${path.resolve(sessionFile)}`;
	}
}
