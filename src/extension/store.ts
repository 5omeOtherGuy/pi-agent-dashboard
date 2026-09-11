/**
 * Extension-side view of the shared registry.
 *
 * Polls the workers directory so a dashboard opened in one Pi session shows
 * workers started by any other session, including ones started after it opened.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { controlAlive, sendControl } from "../control.ts";
import { listRecords, socketPath, stateDir, summarise, workerRecordFingerprint, type ListedRecord } from "../registry.ts";
import { readTranscript, type TranscriptItem } from "../transcript.ts";
import type { ControlRequest, ControlResponse, WorkerRecord, WorkerSummary } from "../protocol.ts";
import { readConfig } from "../config.ts";

export interface WorkerView {
	record: WorkerRecord;
	summary: WorkerSummary;
	stale: boolean;
}

export interface RegistryStoreOptions {
	env?: NodeJS.ProcessEnv;
	intervalMs?: number;
	/** Label recorded on control actions, e.g. "session:01a08cc2". */
	requester?: string;
}

export class RegistryStore {
	private readonly env: NodeJS.ProcessEnv;
	private readonly intervalMs: number;
	private requester?: string;
	private views: WorkerView[] = [];
	private listeners = new Set<() => void>();
	private timer?: NodeJS.Timeout;
	private signature = "";

	constructor(options: RegistryStoreOptions = {}) {
		this.env = options.env ?? process.env;
		this.intervalMs = options.intervalMs ?? 900;
		this.requester = options.requester;
		this.refresh();
	}

	/** Pi exports its session id to shell tools, not to its own process, so the extension sets it explicitly. */
	setRequester(requester: string | undefined): void {
		this.requester = requester;
	}

	get directory(): string {
		return stateDir(this.env);
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.refresh(), this.intervalMs);
		this.timer.unref();
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	refresh(): void {
		const now = Date.now();
		const listed: ListedRecord[] = listRecords(this.env, { staleMs: readConfig(this.env).staleMs });
		this.views = listed.map(({ record, stale }) => ({ record, summary: summarise(record, stale, now), stale }));
		const signature = this.views.map((view) => workerRecordFingerprint(view.record)).join("|");
		// Age and idle time change every poll, so a change in the fingerprint only gates
		// structural updates; the dashboard re-renders on its own timer.
		if (signature !== this.signature) {
			this.signature = signature;
			for (const listener of this.listeners) listener();
		}
	}

	list(): WorkerView[] {
		return this.views;
	}

	active(): WorkerView[] {
		return this.views.filter((view) => ["starting", "running", "awaiting-input"].includes(view.summary.state));
	}

	byId(id: string): WorkerView | undefined {
		return this.views.find((view) => view.record.id === id);
	}

	find(idOrPrefix: string): WorkerView | undefined {
		const exact = this.byId(idOrPrefix);
		if (exact) return exact;
		const matches = this.views.filter((view) => view.record.id.startsWith(idOrPrefix));
		return matches.length === 1 ? matches[0] : undefined;
	}

	transcript(view: WorkerView, limit = 80): TranscriptItem[] {
		try {
			const items = readTranscript(view.record.runDir, { limit, maxBytes: 256 * 1024 });
			// A run's events file always opens with the brief, but a truncated tail or an
			// interrupted worker may not have written it yet: keep the brief visible anyway.
			if (!items.some((item) => item.kind === "user") && view.record.brief.excerpt.trim()) {
				return [{ kind: "user" as const, text: view.record.brief.excerpt }, ...items].slice(-limit);
			}
			return items;
		} catch {
			return [];
		}
	}

	async control(view: WorkerView, request: ControlRequest, timeoutMs = 8000): Promise<ControlResponse> {
		const sessionId = this.requester ?? this.env.PI_SESSION_ID ?? "";
		const by = sessionId ? `session:${sessionId.replace(/^session:/, "").slice(0, 8)}` : "dashboard";
		return sendControl(view.record.supervisor.socket || socketPath(view.record.id, this.env), { ...request, by }, { timeoutMs });
	}

	/** Cheap liveness probe used before reporting a missing socket as an error. */
	async alive(view: WorkerView): Promise<boolean> {
		return controlAlive(view.record.supervisor.socket || socketPath(view.record.id, this.env));
	}
}

export function stateBadge(state: WorkerSummary["state"]): string {
	switch (state) {
		case "running":
			return "●";
		case "awaiting-input":
			return "◍";
		case "starting":
			return "◌";
		case "completed":
			return "✓";
		case "failed":
			return "✗";
		case "timeout":
			return "◐";
		case "stopped":
			return "■";
		default:
			return "?";
	}
}

export function stateColor(state: WorkerSummary["state"]): ThemeColor {
	switch (state) {
		case "running":
			return "success";
		case "awaiting-input":
			return "warning";
		case "starting":
			return "muted";
		case "completed":
			return "accent";
		case "failed":
		case "timeout":
			return "error";
		case "stopped":
			return "warning";
		default:
			return "dim";
	}
}
