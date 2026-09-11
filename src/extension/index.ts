/**
 * pi-agent-dashboard — Pi extension.
 *
 * Registers:
 *   /agents [id|clean|text]   cross-session worker dashboard
 *   a configurable shortcut (default ctrl+alt+a)
 *   a one-line status widget while workers are active
 *   orch_spawn / orch_status / orch_steer / orch_result tools for the lead model
 *
 * Everything it displays comes from the shared registry written by `pi-orch`
 * supervisors, so workers started by other Pi sessions appear automatically.
 */

import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cleanRecords, ensureStateDirs, listRecords, removeRecord, stateDir, writeCliPointer } from "../registry.ts";
import { readConfig } from "../config.ts";
import { DashboardComponent } from "./dashboard.ts";
import { JobRunner } from "./jobs.ts";
import { RegistryStore, stateBadge } from "./store.ts";
import { acceptanceReport, awaitWorker, cliEntry, controlWorker, profileReport, renderRecord, spawnSupervisor, statusReport } from "./tools.ts";
import type { ToolSet } from "../protocol.ts";
import { setTmuxSocket } from "../tmux.ts";

const DEFAULT_SHORTCUT = "ctrl+alt+a";

/**
 * Tool results are typed per tool so renderers and the model see stable details.
 * A failing tool throws: Pi turns a thrown error into an error tool result, while an
 * `isError` field on a returned result would be ignored.
 */
interface SpawnDetails {
	id: string;
	state?: string;
	runDir: string;
	log?: string;
	result?: string;
}

interface ReadDetails {
	id: string;
	file?: string;
}
const WIDGET_KEY = "pi-agent-dashboard";
const STALE_AFTER_MS = 60 * 60 * 1000;

export default function registerAgentDashboard(pi: ExtensionAPI): void {
	const store = new RegistryStore({ env: process.env });
	// An extension that talks to tmux must use the same server the CLI does.
	if (process.env.PI_ORCH_TMUX_SOCKET) setTmuxSocket(process.env.PI_ORCH_TMUX_SOCKET);
	let widgetTicker: NodeJS.Timeout | undefined;
	let lastWidget: string | undefined;

	const dashboard = async (ctx: ExtensionContext, options: { selection?: string; detail?: boolean } = {}): Promise<void> => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify(statusReport({ view: "list" }, process.env), "info");
			return;
		}
		store.refresh();
		const jobs = new JobRunner({ env: process.env, onResult: (message, level) => ctx.ui.notify(message, level) });
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) =>
				new DashboardComponent({
					store,
					theme,
					tui,
					jobs,
					initialSelection: options.selection,
					initialDetail: options.detail ?? Boolean(options.selection),
					onClose: () => done(undefined),
					forget: (id) => removeRecord(id, process.env),
					clean: () => {
						const result = cleanRecords(STALE_AFTER_MS, process.env);
						return `removed ${result.removed.length} stale record(s); kept ${result.kept.length}`;
					},
				}),
			{ overlay: true, overlayOptions: { anchor: "center", width: "96%", maxHeight: "85%", margin: 1 } },
		);
	};

	const widgetLine = (): string | undefined => {
		store.refresh();
		const active = store.active();
		if (active.length === 0) return undefined;
		const waiting = active.filter((view) => view.summary.needsInput);
		const lead = waiting[0] ?? active[0]!;
		const activity = lead.summary.toolDetail ?? lead.summary.tool ?? lead.summary.text?.slice(-60) ?? "";
		return (
			`${stateBadge(lead.summary.state)} ${active.length} worker${active.length === 1 ? "" : "s"}` +
			(waiting.length > 0 ? ` · ${waiting.length} needs input` : "") +
			` · ${lead.summary.id} ${lead.summary.profile} ${activity}`
		);
	};

	const refreshWidget = (ctx: ExtensionContext): void => {
		const line = widgetLine();
		if (line === lastWidget) return;
		lastWidget = line;
		try {
			ctx.ui.setWidget(WIDGET_KEY, line ? [line] : undefined);
		} catch {
			// Widget rendering is cosmetic; never let it break a session.
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (sessionId) store.setRequester(`session:${sessionId.slice(0, 8)}`);
		ensureStateDirs();
		try {
			writeCliPointer(cliEntry());
		} catch {
			// The pointer only helps shell helpers find the CLI; the dashboard reads the registry directly.
		}
		if (!ctx.hasUI) return;
		store.start();
		refreshWidget(ctx);
		if (!widgetTicker) {
			widgetTicker = setInterval(() => {
				try {
					refreshWidget(ctx);
				} catch {
					// Best-effort cosmetic refresh.
				}
			}, 2500);
			widgetTicker.unref();
		}
	});

	pi.on("session_shutdown", () => {
		if (widgetTicker) clearInterval(widgetTicker);
		widgetTicker = undefined;
		store.stop();
	});

	const shortcut = readConfig().shortcut ?? DEFAULT_SHORTCUT;
	try {
		pi.registerShortcut(shortcut as Parameters<ExtensionAPI["registerShortcut"]>[0], {
			description: "Open the cross-session agent dashboard",
			handler: async (ctx) => {
				await dashboard(ctx);
			},
		});
	} catch {
		// A conflicting shortcut must not stop the extension from loading; /agents still works.
	}

	pi.registerCommand("agents", {
		description: "Cross-session worker dashboard (address, transcript, steer, stop)",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "text") {
				ctx.ui.notify(statusReport({ view: "list" }, process.env), "info");
				return;
			}
			if (trimmed === "clean") {
				const result = cleanRecords(STALE_AFTER_MS, process.env);
				ctx.ui.notify(`removed ${result.removed.length} stale record(s); kept ${result.kept.length}`, "info");
				return;
			}
			await dashboard(ctx, { selection: trimmed || undefined, detail: Boolean(trimmed) });
		},
	});

	/* ------------------------------------------------------------------- tools */

	pi.registerTool({
		name: "orch_spawn",
		label: "Spawn worker",
		description: [
			"Start one supervised Pi worker through the orchestration spine (pi-orch) and return its record.",
			"The spine enforces what the orchestration skill otherwise hopes for: the profile and thinking level",
			"are verified against profiles.json before inference and again after settling, the wall-clock deadline",
			"is enforced (including during prompt transport), one writer per workspace is refused, a writer brief",
			"without a definition-of-done table is rejected, and an assigned engineering log is scaffolded and",
			"checked at handoff. The worker is published to every session's /agents dashboard and can be steered,",
			"answered, aborted or stopped by id from any of them.",
		].join(" "),
		promptSnippet: "Start a supervised worker (profile, cwd, brief); wait for it or detach",
		promptGuidelines: [
			"Use orch_spawn, not a shell call to pi-orch, when delegating from a Pi session: it returns the worker record, the definition-of-done rows and the engineering-log verdict.",
			"Give orch_spawn a brief with an Outcome line and, for writer tasks, a markdown definition-of-done table (criterion, verification method, owner, result) — a writer brief without one is rejected before launch.",
			"Pass log with the worker's assigned engineering-log path; the spawned worker's report tells you whether it was filled (ok, empty, unfilled, missing).",
			"Set detach true for work that should proceed while you keep working, then watch it with orch_status and correct it with orch_steer.",
			"Resume a stopped or finished worker with session set to its exact session file plus an updated brief and a new run_dir; never reuse the previous run directory.",
			"Unrun checks are not passes: read orch_result view=acceptance and verify each criterion yourself before integrating.",
		],
		parameters: Type.Object({
			profile: Type.String({ description: "Profile from the orchestration skill's profiles.json (muse-free, opus-medium, glm-high, …)" }),
			cwd: Type.String({ description: "Workspace directory; the worker runs here" }),
			brief: Type.Optional(Type.String({ description: "The full worker brief as text" })),
			brief_file: Type.Optional(Type.String({ description: "Path to an existing brief file (instead of brief)" })),
			tools: Type.Optional(Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("none")], { description: "Tool set; default read" })),
			thinking: Type.Optional(Type.String({ description: "Thinking level override; must be allowed by the profile" })),
			timeout_seconds: Type.Optional(Type.Number({ description: "Wall-clock deadline in seconds (default 900)" })),
			log: Type.Optional(Type.String({ description: "Engineering log path to scaffold and check at handoff" })),
			run_dir: Type.Optional(Type.String({ description: "Run artifact directory (default: <state>/runs/<id>)" })),
			session: Type.Optional(Type.String({ description: "Exact idle session file to continue (resume); the supervisor refuses a session another worker still owns" })),
			trust: Type.Optional(Type.Union([Type.Literal("saved"), Type.Literal("project"), Type.Literal("ignore")], { description: "Pi project trust mode; default saved" })),
			label: Type.Optional(Type.String({ description: "Host label shown in the dashboard" })),
			max_parallel: Type.Optional(Type.Number({ description: "Refuse to start when this many workers are already active" })),
			allow_shared_cwd: Type.Optional(Type.Boolean({ description: "Allow a second writer in the same workspace" })),
			detach: Type.Optional(Type.Boolean({ description: "Return immediately instead of waiting for the worker" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx: ExtensionContext): Promise<AgentToolResult<SpawnDetails>> {
			const tools = (params.tools ?? "read") as ToolSet;
			let handle: Awaited<ReturnType<typeof spawnSupervisor>>;
			try {
				handle = await spawnSupervisor({
					profile: params.profile,
					cwd: params.cwd || ctx.cwd,
					briefText: params.brief,
					briefFile: params.brief_file,
					tools,
					thinking: params.thinking,
					timeoutSeconds: params.timeout_seconds,
					log: params.log,
					runDir: params.run_dir,
					trust: params.trust,
					label: params.label ?? `${ctx.cwd.split("/").pop() ?? "session"}:lead`,
					maxParallel: params.max_parallel,
					allowSharedCwd: params.allow_shared_cwd,
				});
			} catch (error) {
				throw new Error(`orch_spawn failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			const header = `worker ${handle.id} started (${params.profile}/${tools}) · artifacts ${handle.runDir}`;
			if (params.detach) {
				return {
					content: [
						{
							type: "text" as const,
							text: `${header}\nIt keeps running independently of this session. Inspect with orch_status, steer with orch_steer, or open /agents.`,
						},
					],
					details: { id: handle.id, runDir: handle.runDir, log: handle.logFile },
				};
			}

			let lastLine = "";
			onUpdate?.({ content: [{ type: "text" as const, text: `${header}\nworking…` }], details: { id: handle.id, runDir: handle.runDir } });
			const { record, aborted } = await awaitWorker({
				id: handle.id,
				signal,
				onProgress: (line) => {
					lastLine = line;
					onUpdate?.({ content: [{ type: "text" as const, text: `${header}\n${line}` }], details: { id: handle.id, runDir: handle.runDir } });
				},
			});
			if (aborted) {
				const stopped = await controlWorker({ id: handle.id, action: "stop" });
				throw new Error(
					`${header}\nThe tool call was aborted, so the worker was asked to stop (${stopped.ok ? "acknowledged" : stopped.message}). Artifacts remain in ${handle.runDir}.`,
				);
			}
			const lines = [header, lastLine, ""];
			if (record) {
				lines.push(renderRecord(record));
				lines.push("");
				lines.push(
					record.state === "completed"
						? "The worker's turn finished. Acceptance is still yours: check the definition of done against the evidence above before integrating."
						: "The worker did not finish normally; see the record above.",
				);
			}
			if (!record || record.state !== "completed") throw new Error(lines.join("\n"));
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { id: handle.id, state: record.state, runDir: handle.runDir, result: record.result?.path },
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("orch_spawn ")) +
					theme.fg("accent", String(args.profile ?? "?")) +
					theme.fg("muted", ` ${String(args.tools ?? "read")}`) +
					theme.fg("dim", ` ${String(args.cwd ?? "")}`),
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details;
			const first = result.content[0];
			const body = first?.type === "text" ? first.text : "";
			const head = details?.id ? `${theme.fg("toolTitle", "worker ")}${theme.fg("accent", details.id)}` : theme.fg("toolTitle", "worker");
			if (expanded) return new Text(`${head}\n${body}`, 0, 0);
			const status = body
				.split("\n")
				.find((line) => /·\s*(starting|running|completed|failed|timeout|stopped|awaiting-input)/.test(line));
			return new Text(`${head}\n${theme.fg("dim", (status ?? body.split("\n")[1] ?? "").slice(0, 200))}`, 0, 0);
		},
	});

	pi.registerTool({
		name: "orch_status",
		label: "Worker status",
		description: [
			"List supervised workers from every Pi session, or show one worker's record, transcript,",
			"acceptance evidence, or the steering audit trail.",
			"view=acceptance returns the definition-of-done rows (with whatever the worker recorded),",
			"the engineering-log verdict, the git revision and diffstat, usage, steering history and the",
			"final response — the evidence a lead needs, without parsing run directories.",
		].join(" "),
		promptSnippet: "List workers or read one worker's record, acceptance evidence, transcript, or audit trail",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Worker id or unique prefix" })),
			view: Type.Optional(
				Type.Union(
					[Type.Literal("list"), Type.Literal("detail"), Type.Literal("transcript"), Type.Literal("audit"), Type.Literal("acceptance")],
					{ description: "What to show; default list (or detail when id is given)" },
				),
			),
			include_finished: Type.Optional(Type.Boolean({ description: "Include finished workers in the list" })),
			lines: Type.Optional(Type.Number({ description: "Transcript or audit lines (default 40)" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ids: string[] }>> {
			const view = params.view ?? (params.id ? "detail" : "list");
			let text: string;
			if (view === "acceptance") {
				if (!params.id) throw new Error("view=acceptance needs a worker id");
				const found = listRecords(process.env).find(({ record }) => record.id === params.id || record.id.startsWith(params.id!));
				if (!found) throw new Error(`no worker matches ${params.id}`);
				text = acceptanceReport(found.record);
			} else {
				text = statusReport({ id: params.id, view, includeFinished: params.include_finished, limit: params.lines }, process.env);
			}
			return { content: [{ type: "text" as const, text }], details: { ids: listRecords(process.env).map(({ record }) => record.id) } };
		},
	});

	pi.registerTool({
		name: "orch_steer",
		label: "Steer worker",
		description: "Send a steering message, follow-up, abort, stop, or answer to a supervised worker through its supervisor socket.",
		promptSnippet: "Steer, stop, or answer a supervised worker by id",
		parameters: Type.Object({
			id: Type.String({ description: "Worker id or unique prefix" }),
			action: Type.Union(
				[Type.Literal("steer"), Type.Literal("follow_up"), Type.Literal("abort"), Type.Literal("stop"), Type.Literal("answer")],
				{
					description:
						"steer is delivered after the current turn's tool calls; follow_up after the agent finishes; abort stops the current run; stop terminates the worker; answer replies to a waiting question",
				},
			),
			message: Type.Optional(Type.String({ description: "Message for steer or follow_up" })),
			value: Type.Optional(Type.String({ description: "Answer value for action=answer" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ id: string }>> {
			const result = await controlWorker({ id: params.id, action: params.action, message: params.message, value: params.value });
			if (!result.ok) throw new Error(result.message);
			return { content: [{ type: "text" as const, text: result.message }], details: { id: params.id } };
		},
	});

	pi.registerTool({
		name: "orch_result",
		label: "Worker result",
		description: [
			"Read a worker's record, final response, transcript, engineering log, or acceptance evidence.",
			"view=acceptance is the packet to use before integrating: definition-of-done rows with whatever the",
			"worker recorded against each, the engineering-log verdict, workspace revision and diffstat, usage,",
			"steering history and the final response.",
		].join(" "),
		promptSnippet: "Read a worker's result, acceptance evidence, transcript, or engineering log",
		parameters: Type.Object({
			id: Type.String({ description: "Worker id or unique prefix" }),
			view: Type.Optional(
				Type.Union([Type.Literal("result"), Type.Literal("acceptance"), Type.Literal("transcript"), Type.Literal("log")], {
					description: "What to read; default result",
				}),
			),
			lines: Type.Optional(Type.Number({ description: "Lines for the transcript or log view" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<ReadDetails>> {
			const found = listRecords(process.env).find(({ record }) => record.id === params.id || record.id.startsWith(params.id));
			if (!found) throw new Error(`no worker matches ${params.id}`);
			const { record } = found;
			const view = params.view ?? "result";
			if (view === "result") return { content: [{ type: "text" as const, text: renderRecord(record) }], details: { id: record.id } };
			if (view === "acceptance") return { content: [{ type: "text" as const, text: acceptanceReport(record) }], details: { id: record.id } };
			const file = view === "transcript" ? `${record.runDir}/events.jsonl` : record.brief.logPath;
			if (!file) throw new Error("this worker has no engineering log path");
			try {
				const { formatTranscript, readTail, readTranscript } = await import("../transcript.ts");
				const text =
					view === "transcript"
						? formatTranscript(readTranscript(record.runDir, { limit: params.lines ?? 60 })).join("\n")
						: readTail(file, 256 * 1024).slice(-40_000);
				return { content: [{ type: "text" as const, text: text || "(empty)" }], details: { id: record.id, file } };
			} catch (error) {
				throw new Error(`could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});

	pi.registerTool({
		name: "orch_profiles",
		label: "Worker profiles",
		description: [
			"The roster the spine enforces: exact profile names, provider/model, default and allowed thinking",
			"levels, and the card that explains when to route work to that profile. Read a card before assigning",
			"work; pass the profile name and (optionally) a thinking level to orch_spawn.",
		].join(" "),
		promptSnippet: "List the orchestration roster (exact profile names, models, allowed effort, card paths)",
		promptGuidelines: ["Use orch_profiles before choosing a profile so the name and thinking level match what the spine will accept."],
		parameters: Type.Object({}),
		async execute(): Promise<AgentToolResult<{ count: number }>> {
			const report = profileReport(process.env);
			if (report.error) throw new Error(report.error);
			const lines = [`profiles: ${report.rows.length} from ${report.file ?? "(unknown)"}`, ""];
			for (const row of report.rows) {
				lines.push(`${row.name.padEnd(20)} ${row.provider}/${row.model} · default ${row.thinking} · allowed ${row.allowed.join("|")}`);
				if (row.card) lines.push(`${" ".repeat(20)} card: ${row.card}`);
				for (const node of row.nodes) lines.push(`${" ".repeat(20)} ${node}`);
			}
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { count: report.rows.length } };
		},
	});

	void stateDir;
}
