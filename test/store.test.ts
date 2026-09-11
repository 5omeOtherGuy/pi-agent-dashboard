/**
 * Extension-side behaviour: the registry view, the model-facing text reports, and
 * the dashboard renderer. The renderer is exercised directly (no terminal) so width
 * and layout regressions are caught by tests instead of by eye.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatDuration, DashboardComponent } from "../src/extension/dashboard.ts";
import { JobRunner } from "../src/extension/jobs.ts";
import { RegistryStore, stateBadge } from "../src/extension/store.ts";
import { acceptanceReport, profileReport, recordSummaryLine, statusReport } from "../src/extension/tools.ts";
import { readRecord as readRecordFrom } from "../src/registry.ts";
import { readRecord, visibleWidthSafe } from "./extension-helpers.ts";
import { PROFILES } from "./helpers.ts";
import { startWorker } from "./helpers.ts";

const WRITER_BRIEF_LOCAL = [
	"Outcome: hold the workspace while the acceptance packet is produced.",
	"",
	"| Observable criterion | Verification method | Owner | Result |",
	"|---|---|---|---|",
	"| the parser rejects empty keys | unit test | worker | pass |",
	"| existing behavior preserved | existing suite | lead | |",
	"",
].join("\n");

const cleanup: string[] = [];
after(() => {
	for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

/** The dashboard only calls fg/bg/bold, so a pass-through double is enough here. */
const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
} as unknown as Theme;

test("the registry view exposes a live worker's identity, activity and transcript", async () => {
	const session = startWorker({ scenario: "steer", id: "w_store1", label: "buyer" });
	cleanup.push(session.base);
	try {
		await session.waitFor((record) => record.state === "running");
		const store = new RegistryStore({ env: session.env, intervalMs: 100 });
		store.refresh();
		const views = store.list();
		assert.equal(views.length, 1);
		const view = views[0]!;
		assert.equal(view.record.id, "w_store1");
		assert.equal(view.summary.state, "running");
		assert.equal(view.summary.profile, "muse-free");
		assert.equal(view.summary.hostLabel, "buyer");
		assert.equal(store.active().length, 1);
		assert.equal(store.find("w_sto")?.record.id, "w_store1");
		assert.equal(store.find("w_nope"), undefined);

		await session.controlAs({ cmd: "steer", message: "focus on the parser" }, "dashboard-session");
		await session.waitFor((record) => record.controls.steers === 1);
		store.refresh();
		assert.equal(store.list()[0]?.record.controls.lastSteerBy, "dashboard-session");

		// The dashboard's own session id must be attributable in the audit trail; Pi exports
		// its session id to shell tools, not to its own process, so the store carries it.
		const attributed = new RegistryStore({ env: session.env, requester: "session:abc12345" });
		attributed.refresh();
		const response = await attributed.control(attributed.list()[0]!, { cmd: "steer", message: "second steer" });
		assert.equal(response.ok, true, response.error);
		await session.waitFor((record) => record.controls.steers === 2);
		assert.equal(session.record()?.controls.lastSteerBy, "session:abc12345");

		const line = recordSummaryLine(store.list()[0]!.record);
		assert.match(line, /w_store1/);
		assert.match(line, /running/);
		const detail = statusReport({ id: "w_store1", view: "detail" }, session.env);
		assert.match(detail, /muse-free/);
		assert.match(detail, /definition of done|outcome/i);

		const transcript = store.transcript(view, 20);
		assert.ok(transcript.length > 0, "the brief must appear in the transcript");

		await session.stop();
		await session.waitExit();
		store.stop();
	} finally {
		if (!session.exited()) await session.stop().catch(() => undefined);
	}
});

test("the dashboard renders a list and a detail view within the terminal width", async () => {
	const session = startWorker({ scenario: "steer", id: "w_render1", label: "render-lead" });
	cleanup.push(session.base);
	try {
		await session.waitFor((record) => record.state === "running");
		const store = new RegistryStore({ env: session.env, intervalMs: 100 });
		store.refresh();
		const jobRunner = new JobRunner({ env: session.env });
		let closed: string | null | undefined;
		const component = new DashboardComponent({
			store,
			theme: plainTheme,
			tui: { requestRender: () => undefined },
			onClose: (result) => {
				closed = result;
			},
			jobs: jobRunner,
			initialSelection: "w_render1",
		});
		for (const width of [60, 100, 160]) {
			const list = component.render(width);
			assert.ok(list.length >= 5, `list view should have content at width ${width}`);
			for (const line of list) {
				assert.ok(visibleWidthSafe(line) <= width, `line exceeds width ${width}: ${JSON.stringify(line)}`);
			}
			assert.ok(
				list.some((line) => line.includes("w_render1")),
				"the worker id must appear in the list",
			);
		}
		component.handleInput("\r");
		const detail = component.render(110);
		assert.ok(detail.some((line) => line.includes("muse-free")), "detail must show the agent identity");
		assert.ok(detail.some((line) => line.includes("w_render1")));
		for (const line of detail) assert.ok(visibleWidthSafe(line) <= 110);

		component.handleInput("t");
		const brief = component.render(110);
		assert.ok(brief.some((line) => line.includes("brief")), "the brief tab must render the brief");
		component.handleInput("t");

		component.handleInput("s");
		const prompt = component.render(110);
		assert.ok(prompt.some((line) => line.includes("steer>")), "steer mode must show an input line");
		// Terminals deliver keystrokes individually; feed them the same way.
		for (const key of "focus on tests") component.handleInput(key);
		component.handleInput("\r");
		await session.waitFor((record) => record.controls.steers === 1);

		component.handleInput("\u001b");
		assert.equal(closed, undefined, "escape from detail returns to the list, it does not close the dashboard");
		component.handleInput("q");
		assert.equal(closed, null, "q closes the dashboard");
		component.dispose();
		store.stop();
	} finally {
		if (!session.exited()) await session.stop().catch(() => undefined);
	}
});

test("the panel height never depends on the selection or transient state", async () => {
	// Regression: Pi's main-screen renderer does not clear rows vacated while an overlay is
	// active, so a panel that shrinks leaves ghost copies of the previous frame on screen.
	const session = startWorker({ scenario: "input_park", id: "w_height1", extraArgs: ["--input", "park"] });
	cleanup.push(session.base);
	try {
		await session.waitFor(() => true);
		const stateDir = session.stateDir;
		const workers = path.join(stateDir, "workers");
		// A finished worker with a result and a failed worker with an error, next to the parked one.
		const parked = JSON.parse(fs.readFileSync(path.join(workers, "w_height1.json"), "utf8")) as Record<string, unknown>;
		for (const [id, extra] of [
			["w_height0", { state: "completed", result: { status: "completed", path: "/tmp/r.json", seconds: 3, checks: { log: "ok" } } }],
			["w_height2", { state: "failed", error: "engineering log unfilled" }],
		] as const) {
			fs.writeFileSync(path.join(workers, `${id}.json`), JSON.stringify({ ...parked, id, ...extra }));
		}
		const store = new RegistryStore({ env: session.env, intervalMs: 60_000 });
		store.refresh();
		assert.equal(store.list().length, 3);
		const heights = new Set<number>();
		for (const rows of [24, 40, 60]) {
			const component = new DashboardComponent({
				store,
				theme: plainTheme,
				tui: { requestRender: () => undefined, terminal: { rows, columns: 120 } },
				onClose: () => undefined,
				jobs: new JobRunner({ env: session.env }),
			});
			for (let index = 0; index < 3; index++) {
				heights.add(component.render(120).length);
				component.handleInput("\r");
				heights.add(component.render(120).length);
				component.handleInput("t");
				heights.add(component.render(120).length);
				component.handleInput("t");
				component.handleInput("\u001b");
				component.handleInput("\u001b");
				component.handleInput("\u001b");
				if (index < 2) component.handleInput("j");
			}
			component.handleInput("s");
			heights.add(component.render(120).length);
			component.dispose();
			assert.equal(heights.size, 1, `panel height must be stable at ${rows} rows, saw ${[...heights].join(", ")}`);
			heights.clear();
		}
		store.stop();
	} finally {
		if (!session.exited()) await session.stop().catch(() => undefined);
	}
});

test("state badges and durations are stable for the list view", () => {
	assert.equal(stateBadge("running"), "●");
	assert.equal(stateBadge("awaiting-input"), "◍");
	assert.equal(formatDuration(0), "0s");
	assert.equal(formatDuration(95), "1m35");
	assert.equal(formatDuration(3700), "1h01");
});

test("the roster and the acceptance packet are reported as data", async () => {
	const session = startWorker({ scenario: "ok", id: "w_accept1", tools: "write", prompt: WRITER_BRIEF_LOCAL });
	cleanup.push(session.base);
	try {
		await session.waitExit();
		const report = profileReport({ ...session.env, PI_ORCH_PROFILES: PROFILES });
		assert.equal(report.error, undefined);
		const names = report.rows.map((row) => row.name);
		assert.ok(names.includes("muse-free"));
		assert.ok(names.includes("gemini-restricted"));
		const gemini = report.rows.find((row) => row.name === "gemini-restricted");
		assert.deepEqual(gemini?.allowed, ["high"]);
		assert.match(gemini?.nodes.join(" ") ?? "", /model_by_thinking/);

		const record = readRecordFrom("w_accept1", session.env);
		assert.ok(record);
		const packet = acceptanceReport(record!);
		assert.match(packet, /acceptance evidence/);
		assert.match(packet, /definition of done/);
		assert.match(packet, /the parser rejects empty keys/);
		assert.match(packet, /engineering log/);
		assert.match(packet, /workspace/);
		assert.match(packet, /final response/);
	} finally {
		if (!session.exited()) await session.stop().catch(() => undefined);
	}
});

test("status views never throw on an empty registry", () => {
	const empty = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "pi-orch-empty-"));
	cleanup.push(empty);
	const env = { ...process.env, PI_ORCH_STATE_DIR: path.join(empty, "state") };
	assert.equal(statusReport({ view: "list" }, env), "no workers tracked");
	assert.match(statusReport({ id: "w_missing" }, env), /no worker matches/);
	assert.equal(readRecord("w_missing", env), undefined);
});
