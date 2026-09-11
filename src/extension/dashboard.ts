/**
 * The `/agents` overlay: workers from every Pi session on this machine, with a
 * detail view showing the brief, live activity and transcript, plus the controls
 * (steer, follow-up, answer, abort, stop) that act over each worker's socket.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { JobRunner } from "./jobs.ts";
import type { RegistryStore, WorkerView } from "./store.ts";
import { stateBadge, stateColor } from "./store.ts";

export interface DashboardOptions {
	store: RegistryStore;
	theme: Theme;
	tui: { requestRender(): void; terminal?: { rows: number; columns: number } };
	onClose: (result: string | null) => void;
	jobs: JobRunner;
	initialSelection?: string;
	initialDetail?: boolean;
	/** Remove a finished record. */
	forget?: (id: string) => void;
	/** Remove stale records, returning a summary line. */
	clean?: () => string;
}

type Mode = "list" | "detail";
type PromptKind = "steer" | "followup" | "answer";

const TRANSCRIPT_LIMIT = 120;

export class DashboardComponent implements Component, Focusable {
	private readonly store: RegistryStore;
	private readonly theme: Theme;
	private readonly tui: { requestRender(): void; terminal?: { rows: number; columns: number } };
	private readonly onClose: (result: string | null) => void;
	private readonly jobs: JobRunner;
	private readonly forgetRecord: ((id: string) => void) | undefined;
	private readonly cleanRecords: (() => string) | undefined;
	private readonly input = new Input({ prompt: "" });

	private mode: Mode = "list";
	private selectedId?: string;
	private promptKind?: PromptKind;
	private notice?: { text: string; level: "info" | "warning" | "error" };
	private scroll = 0;
	private detailTab: "transcript" | "brief" = "transcript";
	private ticker?: NodeJS.Timeout;
	private readonly unsubscribe: () => void;
	private _focused = false;

	constructor(options: DashboardOptions) {
		this.store = options.store;
		this.theme = options.theme;
		this.tui = options.tui;
		this.onClose = options.onClose;
		this.jobs = options.jobs;
		this.forgetRecord = options.forget;
		this.cleanRecords = options.clean;
		this.selectedId = options.initialSelection;
		this.mode = options.initialDetail ? "detail" : "list";
		this.input.onSubmit = (value) => this.submitPrompt(value);
		this.input.onEscape = () => {
			this.promptKind = undefined;
			this.input.setValue("");
			this.tui.requestRender();
		};
		this.store.refresh();
		this.unsubscribe = this.store.subscribe(() => this.tui.requestRender());
		this.ticker = setInterval(() => {
			this.store.refresh();
			this.tui.requestRender();
		}, 1000);
		this.ticker.unref();
	}

	dispose(): void {
		this.unsubscribe();
		if (this.ticker) clearInterval(this.ticker);
		this.ticker = undefined;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	private get views(): WorkerView[] {
		return this.store.list();
	}

	private get selected(): WorkerView | undefined {
		if (this.selectedId) {
			const found = this.store.find(this.selectedId);
			if (found) return found;
		}
		// Default to the most interesting worker: something still running, else the newest.
		const active = this.views.filter((view) => ["starting", "running", "awaiting-input"].includes(view.summary.state));
		if (active.length > 0) return active[active.length - 1];
		return this.views[this.views.length - 1];
	}

	private setNotice(text: string, level: "info" | "warning" | "error" = "info"): void {
		this.notice = { text, level };
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.promptKind) {
			this.input.handleInput(data);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.escape) || data === "q") {
			if (this.mode === "detail") {
				this.mode = "list";
				this.scroll = 0;
				this.tui.requestRender();
				return;
			}
			this.dispose();
			this.onClose(null);
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") return this.move(-1);
		if (matchesKey(data, Key.down) || data === "j") return this.move(1);
		if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) return this.scrollBy(5);
		if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) return this.scrollBy(-5);
		if (matchesKey(data, Key.home)) {
			this.scroll = 10_000;
			return this.tui.requestRender();
		}
		if (matchesKey(data, Key.end)) {
			this.scroll = 0;
			return this.tui.requestRender();
		}
		if (matchesKey(data, Key.return) || matchesKey(data, Key.right)) {
			if (this.mode === "list" && this.selected) {
				this.mode = "detail";
				this.selectedId = this.selected.record.id;
				this.scroll = 0;
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.left)) {
			this.mode = "list";
			this.tui.requestRender();
			return;
		}
		if (data === "r") {
			this.store.refresh();
			this.setNotice("refreshed");
			return;
		}
		if (data === "c") {
			const summary = this.cleanRecords?.();
			this.store.refresh();
			this.setNotice(summary ?? "no cleanup available here");
			return;
		}
		if (data === "t") {
			this.detailTab = this.detailTab === "transcript" ? "brief" : "transcript";
			this.scroll = 0;
			this.tui.requestRender();
			return;
		}
		if (data === "s") return this.openPrompt("steer");
		if (data === "f") return this.openPrompt("followup");
		if (data === "y") return this.openPrompt("answer");
		if (data === "a") {
			void this.act("abort", this.selected);
			return;
		}
		if (data === "x") {
			void this.act("stop", this.selected);
			return;
		}
		if (data === "o") {
			void this.openSession(this.selected);
			return;
		}
		if (data === "g") {
			this.focusWindow(this.selected);
			return;
		}
		if (data === "w") {
			void this.watchWorker(this.selected);
			return;
		}
		if (data === "d") {
			const view = this.selected;
			if (!view) return;
			if (!["completed", "failed", "stopped", "timeout", "stale"].includes(view.summary.state)) {
				this.setNotice("worker is still active; stop it before forgetting", "warning");
				return;
			}
			this.forgetRecord?.(view.record.id);
			this.store.refresh();
			this.setNotice(`forgot ${view.record.id}`);
		}
	}

	private move(delta: number): void {
		const views = this.views;
		if (views.length === 0) return;
		const currentId = this.selected?.record.id;
		const current = currentId ? views.findIndex((view) => view.record.id === currentId) : 0;
		const next = Math.max(0, Math.min(views.length - 1, (current < 0 ? 0 : current) + delta));
		this.selectedId = views[next]?.record.id;
		if (this.mode === "detail") this.scroll = 0;
		this.notice = undefined;
		this.tui.requestRender();
	}

	private scrollBy(delta: number): void {
		this.scroll = Math.max(0, this.scroll + delta);
		this.tui.requestRender();
	}

	private openPrompt(kind: PromptKind): void {
		const view = this.selected;
		if (!view) {
			this.setNotice("no worker selected", "warning");
			return;
		}
		if (kind === "answer" && !view.record.pendingInput) {
			this.setNotice("this worker is not waiting for input", "warning");
			return;
		}
		if (kind !== "answer" && view.stale) {
			this.setNotice("the worker's supervisor is gone; steering is unavailable", "error");
			return;
		}
		this.promptKind = kind;
		this.input.setValue(kind === "answer" ? (view.record.pendingInput?.options?.[0] ?? "") : "");
		this.notice = undefined;
		this.tui.requestRender();
	}

	private submitPrompt(value: string): void {
		const kind = this.promptKind;
		const view = this.selected;
		this.promptKind = undefined;
		this.input.setValue("");
		if (!kind || !view) return;
		const text = value.trim();
		if (!text && kind !== "answer") {
			this.setNotice("nothing sent: empty message", "warning");
			return;
		}
		void this.sendControl(view, kind, text);
	}

	private async sendControl(view: WorkerView, kind: PromptKind, text: string): Promise<void> {
		const request =
			kind === "steer"
				? ({ cmd: "steer", message: text } as const)
				: kind === "followup"
					? ({ cmd: "follow_up", message: text } as const)
					: ({ cmd: "answer", value: text, cancelled: text === "!cancel" } as const);
		const result = await this.jobs.run(`control:${view.record.id}`, () => this.store.control(view, request));
		if (!result || this.jobs.lastError) {
			this.setNotice(this.jobs.lastError ?? "control failed", "error");
			return;
		}
		if (!result.ok) {
			this.setNotice(result.error ?? "control failed", "error");
			return;
		}
		this.setNotice(
			kind === "steer"
				? `steer queued for ${view.record.id}`
				: kind === "followup"
					? `follow-up queued for ${view.record.id}`
					: "answer delivered",
		);
	}

	private async act(action: "abort" | "stop", view: WorkerView | undefined): Promise<void> {
		if (!view) {
			this.setNotice("no worker selected", "warning");
			return;
		}
		if (view.stale) {
			this.setNotice("the worker's supervisor is gone; nothing to signal", "error");
			return;
		}
		const result = await this.jobs.run(`${action}:${view.record.id}`, () => this.store.control(view, { cmd: action }));
		if (!result || this.jobs.lastError) {
			this.setNotice(this.jobs.lastError ?? `${action} failed`, "error");
			return;
		}
		if (!result.ok) {
			this.setNotice(result.error ?? `${action} failed`, "error");
			return;
		}
		this.setNotice(`${action} requested for ${view.record.id}`);
	}

	private focusWindow(view: WorkerView | undefined): void {
		if (!view) return;
		if (this.jobs.focusWorker(view.record)) this.setNotice(`focused ${view.record.id}'s tmux window`);
		else this.setNotice("no tmux window for this worker (window mode may be off)", "warning");
	}

	private async watchWorker(view: WorkerView | undefined): Promise<void> {
		if (!view) return;
		const pane = await this.jobs.run(`watch:${view.record.id}`, async () => this.jobs.watchWorker(view.record));
		if (!pane && this.jobs.lastError) this.setNotice(this.jobs.lastError, "error");
		else if (!pane) this.setNotice("watching needs tmux; use `pi-orch watch <id> --follow` anywhere", "warning");
		else this.setNotice(`watch pane opened for ${view.record.id}`);
	}

	private async openSession(view: WorkerView | undefined): Promise<void> {
		if (!view) return;
		if (!["completed", "failed", "stopped", "timeout", "stale"].includes(view.summary.state)) {
			this.setNotice("worker is still using its session; steer it instead (s)", "warning");
			return;
		}
		const ran = await this.jobs.run("open-session", () => this.jobs.openSession(view.record.worker.sessionFile, view.record.id));
		if (ran === undefined && this.jobs.lastError) this.setNotice(this.jobs.lastError, "error");
		else this.setNotice(`opened ${view.record.id} in a new tmux window`);
	}

	render(width: number): string[] {
		const t = this.theme;
		const lines = this.mode === "list" ? this.renderList(width) : this.renderDetail(width);
		// Two constraints come from how Pi composes an overlay over the main screen:
		//  - every line must be padded to the full width and given a background, or the
		//    transcript behind the panel shows through the gaps;
		//  - the panel height must not depend on the selection or on transient state, because
		//    the main-screen renderer does not clear rows vacated while an overlay is active.
		//    A shrinking panel would leave ghost copies of the previous frame on screen.
		const height = this.panelHeight();
		while (lines.length < height) lines.push("");
		return lines.map((line) => {
			const clipped = truncateToWidth(line, width);
			return t.bg("customMessageBg", clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped))));
		});
	}

	/** Panel height for this terminal. Constant per session, so navigating never resizes it. */
	private panelHeight(): number {
		const rows = this.tui.terminal?.rows ?? 40;
		return Math.max(15, Math.min(rows - 8, 28));
	}

	/** Worker rows on screen. Fixed for the session, blank-padded when fewer workers exist. */
	private get rowWindow(): number {
		return Math.max(3, Math.min(this.panelHeight() - 8, 20));
	}

	/** True on short terminals, where the detail head drops its least important field lines. */
	private get compact(): boolean {
		return this.panelHeight() < 22;
	}

	private get headLines(): number {
		return this.compact ? 9 : 13;
	}

	/** Transcript/brief lines on screen. Fixed for the session, blank-padded when shorter. */
	private get bodyWindow(): number {
		return Math.max(1, Math.min(this.panelHeight() - this.headLines - 5, 20));
	}

	invalidate(): void {
		this.input.invalidate();
	}

	/* -------------------------------------------------------------------- list */

	private renderList(width: number): string[] {
		const t = this.theme;
		const views = this.views;
		const active = views.filter((view) => ["starting", "running", "awaiting-input"].includes(view.summary.state));
		const waiting = views.filter((view) => view.summary.needsInput);
		const lines: string[] = [];
		lines.push(
			t.fg("toolTitle", t.bold("Agents")) +
				t.fg("muted", `  ${active.length} active`) +
				(waiting.length > 0 ? t.fg("warning", ` · ${waiting.length} needs input`) : "") +
				t.fg("dim", ` · ${views.length} tracked · ${this.store.directory}`),
		);
		lines.push(t.fg("dim", "─".repeat(Math.max(0, width - 2))));
		const rows = this.rowWindow;
		if (views.length === 0) {
			lines.push(t.fg("muted", "No workers yet. The lead spawns them with the orchestration skill (pi_orch run …)."));
			for (let index = 1; index < rows; index++) lines.push("");
		} else {
			const selectedIndex = Math.max(
				0,
				views.findIndex((view) => view.record.id === this.selected?.record.id),
			);
			const windowSize = Math.min(rows, views.length);
			const start = Math.max(0, Math.min(selectedIndex - Math.floor(windowSize / 2), views.length - windowSize));
			for (let offset = 0; offset < rows; offset++) {
				const view = views[start + offset];
				lines.push(view ? this.renderRow(view, start + offset === selectedIndex, width) : "");
			}
		}
		lines.push(
			views.length > rows ? t.fg("dim", `  … ${views.length - rows} more (↑/↓ scrolls the list)`) : "",
		);
		lines.push("");
		const view = this.selected;
		const activity = view ? (view.summary.toolDetail ?? view.summary.tool ?? view.summary.text?.slice(-110) ?? view.record.error ?? "") : "";
		lines.push(
			view
				? t.fg("muted", "  ") +
					t.fg(stateColor(view.summary.state), `${stateBadge(view.summary.state)} ${view.record.id}`) +
					t.fg("dim", "  ") +
					activity
				: "",
		);
		lines.push(
			view?.record.pendingInput
				? t.fg("warning", `  waiting: ${view.record.pendingInput.title ?? view.record.pendingInput.message ?? view.record.pendingInput.method}`)
				: "",
		);
		lines.push(this.notice ? this.renderNotice() : "");
		lines.push(
			this.footer([
				"↑/↓ select",
				"enter detail",
				"s steer",
				"f follow-up",
				"y answer",
				"a abort",
				"x stop",
				"o open session",
				"g window",
				"w watch",
				"c clean",
				"r refresh",
				"q close",
			]),
		);
		return lines;
	}

	private renderRow(view: WorkerView, isSelected: boolean, width: number): string {
		const t = this.theme;
		const s = view.summary;
		const marker = isSelected ? t.fg("accent", "▸") : " ";
		const badge = t.fg(stateColor(s.state), stateBadge(s.state));
		const line =
			` ${marker}${badge} ` +
			`${s.id.padEnd(16)}${s.profile.slice(0, 16).padEnd(18)}${s.thinking.slice(0, 5).padEnd(7)}` +
			`${s.state.padEnd(15)}${formatDuration(s.ageSeconds).padEnd(7)}${truncateToWidth(s.hostLabel, 22)}`;
		return isSelected ? t.bg("selectedBg", truncateToWidth(line, width)) : line;
	}

	/* ------------------------------------------------------------------ detail */

	private renderDetail(width: number): string[] {
		const t = this.theme;
		const view = this.selected;
		if (!view) {
			this.mode = "list";
			return this.renderList(width);
		}
		const record = view.record;
		const s = view.summary;
		const lines: string[] = [];
		const deadlineLeft = Math.round((Date.parse(record.deadline.expiresAt) - Date.now()) / 1000);
		lines.push(
			t.fg("toolTitle", t.bold("Agent ")) +
				t.fg(stateColor(s.state), `${stateBadge(s.state)} ${record.id}`) +
				t.fg("muted", `  ${s.state}`) +
				t.fg("dim", ` · phase ${s.phase} · age ${formatDuration(s.ageSeconds)}`) +
				(Number.isFinite(deadlineLeft)
					? t.fg(
							deadlineLeft < 0 ? "warning" : "dim",
							` · ${deadlineLeft >= 0 ? `${formatDuration(deadlineLeft)} left` : `${formatDuration(-deadlineLeft)} over deadline`}`,
						)
					: ""),
		);
		lines.push(t.fg("dim", "─".repeat(Math.max(0, width - 2))));
		lines.push(
			this.field(
				"agent",
				`${record.worker.profile} · ${record.worker.provider}/${record.worker.model} · thinking ${record.worker.thinking} · tools ${record.worker.tools}`,
			),
		);
		lines.push(
			this.field(
				"host",
				`${record.host.label}${record.host.sessionId ? ` (${record.host.sessionId})` : ""}`,
			),
		);
		lines.push(this.field("cwd", record.worker.cwd));
		lines.push(this.field("run", record.runDir));
		// Dropped on short terminals only: whether these lines exist must not depend on the
		// selected worker, or the panel would resize while navigating.
		if (!this.compact) lines.push(this.field("session", record.worker.sessionFile));
		if (!this.compact) lines.push(record.brief.outcome ? this.field("outcome", record.brief.outcome) : "");
		lines.push(
			this.field(
				"usage",
				`turns ${s.turns} · tools ${s.toolCalls} · $${s.cost.toFixed(4)} · ctx ${formatTokens(s.contextTokens)} · steers ${record.controls.steers}${record.controls.lastSteerBy ? ` (last by ${record.controls.lastSteerBy})` : ""}`,
			),
		);
		const pending = record.pendingInput;
		lines.push(
			pending
				? t.fg("warning", `  waiting for input  ${pending.method}: ${pending.title ?? pending.message ?? ""}`) +
						(pending.options?.length ? t.fg("dim", ` [${pending.options.join(" | ")}]`) : "") +
						t.fg("muted", "   y to answer")
				: "",
		);
		const now = record.activity.toolDetail ?? (record.activity.tool ? `running ${record.activity.tool}` : undefined);
		if (!this.compact) lines.push(now ? this.field("now", t.fg(stateColor(s.state), now)) : "");
		if (!this.compact) lines.push(record.activity.text ? this.field("says", t.fg("muted", `…${record.activity.text.replace(/\s+/g, " ").slice(-180)}`)) : "");
		lines.push(t.fg("dim", "─".repeat(Math.max(0, width - 2))));
		const body = this.detailTab === "transcript" ? this.transcriptBody(view, width) : this.briefBody(view);
		const windowSize = Math.min(this.bodyWindow, Math.max(1, body.length));
		const start = Math.max(0, Math.min(body.length - windowSize, body.length - windowSize - this.scroll));
		for (let index = 0; index < this.bodyWindow; index++) lines.push(body[start + index] ?? "");
		lines.push(
			body.length > this.bodyWindow
				? t.fg("dim", `  ${this.detailTab} ${start + windowSize}/${body.length} · ${this.scroll > 0 ? "↑ scrolls toward newer" : "live tail"}`)
				: "",
		);
		lines.push(t.fg("dim", "─".repeat(Math.max(0, width - 2))));
		if (record.result) {
			lines.push(
				this.field(
					"result",
					`${record.result.status}${record.result.seconds ? ` in ${record.result.seconds}s` : ""} · engineering log ${record.result.checks.log}${record.result.error ? ` · ${record.result.error}` : ""}`,
				),
			);
		} else if (record.error) {
			lines.push(this.field("error", t.fg("error", record.error)));
		} else {
			lines.push("");
		}
		lines.push(this.notice ? this.renderNotice() : "");
		lines.push(
			this.footer([
				this.detailTab === "transcript" ? "t brief" : "t transcript",
				"↑/↓ scroll",
				"s steer",
				"f follow-up",
				record.pendingInput ? "y answer" : "",
				"a abort",
				"x stop",
				"o open session",
				"g window",
				"w watch",
				"d forget",
				"esc back",
			]),
		);
		return lines;
	}

	private transcriptBody(view: WorkerView, width: number): string[] {
		const t = this.theme;
		const items = this.store.transcript(view, TRANSCRIPT_LIMIT);
		if (items.length === 0) return [t.fg("muted", "  (no transcript yet — the worker has not written session events)")];
		const lines: string[] = [];
		for (const item of items) {
			const prefix =
				item.kind === "user"
					? t.fg("accent", "▌brief ")
					: item.kind === "assistant"
						? t.fg("dim", "│ ")
						: item.kind === "tool"
							? t.fg("muted", "→ ")
							: item.kind === "error"
								? t.fg("error", "✗ ")
								: t.fg("muted", "• ");
			const wrapped = wrapTextWithAnsi(item.text.trim(), Math.max(20, width - 6));
			const limited = wrapped.slice(0, item.kind === "assistant" ? 14 : 6);
			limited.forEach((line, index) => {
				lines.push(`  ${index === 0 ? prefix : "  "}${line}`);
			});
		}
		return lines;
	}

	private briefBody(view: WorkerView): string[] {
		const t = this.theme;
		const record = view.record;
		const lines: string[] = [];
		lines.push(
			t.fg("muted", "  brief ") +
				record.brief.path +
				t.fg("dim", `  ${record.brief.bytes} bytes · sha256 ${record.brief.sha256.slice(0, 12)}`),
		);
		if (record.brief.definitionOfDone.length === 0) lines.push(t.fg("warning", "  no definition-of-done rows were found in this brief"));
		for (const row of record.brief.definitionOfDone) lines.push(`  ${t.fg("accent", "•")} ${row}`);
		if (record.brief.logPath) {
			lines.push(`  ${t.fg("muted", "log ")}${record.brief.logPath} ${t.fg("dim", `(${record.result?.checks.log ?? "unchecked"})`)}`);
		}
		lines.push("");
		lines.push(t.fg("muted", "  excerpt"));
		for (const line of record.brief.excerpt.split("\n").slice(0, 16)) lines.push(`  ${t.fg("dim", line)}`);
		return lines;
	}

	private field(label: string, value: string): string {
		return `${this.theme.fg("muted", `  ${label.padEnd(8)}`)}${value}`;
	}

	private renderNotice(): string {
		const notice = this.notice;
		if (!notice) return "";
		const color = notice.level === "error" ? "error" : notice.level === "warning" ? "warning" : "accent";
		return this.theme.fg(color, `  ${notice.text}`);
	}

	private footer(keys: string[]): string {
		const t = this.theme;
		if (this.promptKind) {
			const label = this.promptKind === "steer" ? "steer" : this.promptKind === "followup" ? "follow-up" : "answer";
			return t.fg("muted", `  ${label}> `) + (this.input.render(400)[0] ?? "") + t.fg("dim", "   enter send · esc cancel");
		}
		return t.fg("dim", `  ${keys.filter(Boolean).join(" · ")}`);
	}
}

export function formatDuration(seconds: number): string {
	if (!Number.isFinite(seconds)) return "?";
	const value = Math.max(0, Math.round(seconds));
	if (value < 60) return `${value}s`;
	if (value < 3600) return `${Math.floor(value / 60)}m${String(value % 60).padStart(2, "0")}`;
	return `${Math.floor(value / 3600)}h${String(Math.floor((value % 3600) / 60)).padStart(2, "0")}`;
}

export function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}
