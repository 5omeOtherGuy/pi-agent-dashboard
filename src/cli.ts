/**
 * `pi-orch` — the orchestration skill's deterministic worker launcher.
 *
 * Commands keep the previous helper's contract (`run PROFILE --cwd … --run-dir …
 * --prompt-file …`) so existing skill instructions keep working, and add the
 * registry/control surfaces the dashboard and the lead model use.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { sendControl } from "./control.ts";
import { formatTranscript, readTail, readTranscript } from "./transcript.ts";
import { killWindow, renderBoard } from "./tmux.ts";
import { loadProfiles, profileNames, profilesCandidates, resolveProfilesPath, selectProfile } from "./profiles.ts";
import {
	cleanRecords,
	ensureStateDirs,
	listRecords,
	newWorkerId,
	readCliPointer,
	readRecord,
	recordPath,
	removeRecord,
	stateDir,
	summarise,
	writeCliPointer,
} from "./registry.ts";
import type { ControlRequest, ToolSet, WorkerRecord } from "./protocol.ts";
import { activeWorkers, preflight, runWorker, type HostInfo, type RunOptions } from "./supervisor.ts";
import {
	capturePane,
	findWorkerWindow,
	getWindowOption,
	focusWindow,
	listWindows,
	openWindow,
	setTmuxSocket,
	setWindowOption,
	splitPane,
	statusline,
	supportsEnvFlag,
	tmuxReady,
	tmuxVersion,
	watchWorker,
	windowIdForPane,
	windowName,
	workerWindowName,
	WORKER_WINDOW_OPTION,
} from "./tmux.ts";
import { readConfig } from "./config.ts";

const DEFAULT_TIMEOUT_SECONDS = 900;
const DEFAULT_CLEAN_OLDER_THAN_SECONDS = 3600;

const USAGE = `pi-orch — deterministic Pi worker supervisor

  pi-orch run <profile> --cwd DIR --run-dir DIR (--prompt-file FILE | --prompt TEXT) [options]
  pi-orch check <profile> --cwd DIR --run-dir DIR [options]
  pi-orch list [--json] [--all]
  pi-orch status [<id>] [--json]
  pi-orch steer <id> <message…>
  pi-orch follow-up <id> <message…>
  pi-orch stop <id>
  pi-orch answer <id> <value> | pi-orch answer <id> --cancel
  pi-orch tail <id> [--lines N]        human-readable transcript
  pi-orch logs <id> [--lines N]        raw event lines
  pi-orch rm <id>                      forget a finished worker record
  pi-orch clean [--older-than SECONDS] [--all-terminal]
                                       prune finished worker records; deletes only the
                                       registry entry and control socket (run dirs, logs
                                       and session files are kept)
  pi-orch watch <id> [--follow]        live transcript; safe while the worker runs
  pi-orch dash [--watch] [--once]      standalone board (any pane or tmux popup)
  pi-orch statusline                   one line for tmux status-left/status-right
  pi-orch windows [--json]             tmux windows owned by workers
  pi-orch focus <id>                   jump to the worker's tmux window
  pi-orch pane <id> [--new-window]     open a live watch pane/window for a worker
  pi-orch tmux-setup                   print the recommended tmux configuration
  pi-orch profiles [--json]
  pi-orch doctor

Run options:
  --thinking LEVEL        override the profile's default thinking level
  --tools read|write|none default read
  --close                  with stop/abort: also close the worker's tmux window
  --trust saved|project|ignore  default saved
  --timeout SECONDS       wall-clock deadline (default ${DEFAULT_TIMEOUT_SECONDS})
  --input fail|park       what to do when the worker asks for input (default fail)
  --log PATH              engineering log to scaffold and check at handoff
  --no-log-check          do not check the engineering log
  --max-parallel N        refuse to start when N workers are already active
  --allow-shared-cwd      allow a second writer in the same workspace
  --require-dod / --no-require-dod  require a definition-of-done table (default: writers only)
  --session FILE          resume an existing session file
  --id ID                 use a specific worker id
  --label TEXT            host label shown in the dashboard
  --detach                return immediately; the supervisor keeps running
  --window auto|always|never  run the worker in a named tmux window (default: config, else never)
  --json                  print the full report
  --profiles FILE         profiles.json to use
  --pi PATH               pi executable (default: pi)
`;

const CLEAN_USAGE = `pi-orch clean [--older-than SECONDS] [--all-terminal]

Remove finished worker records from the registry so it cannot grow forever.

A record is removed when:
  - its state is terminal (completed, failed, stopped, timeout, stale), and
  - its updatedAt is older than --older-than (default ${DEFAULT_CLEAN_OLDER_THAN_SECONDS} seconds), or
    --all-terminal is given (no age check).

A record is always kept when:
  - its supervisor pid is still alive, whatever its state;
  - it is running or awaiting input and not abandoned (a live supervisor pid,
    or a heartbeat newer than the staleness threshold).

Deletion scope: only the registry entry (workers/<id>.json) and the worker's
control socket (workers/<id>.ctl.sock) are deleted. Run directories, logs and
session files are never touched. Use 'rm' to forget a single record.

Finished records disappear from 'pi-orch list' after ~15 minutes idle;
'pi-orch list --all' shows them until 'clean' removes them.

Options:
  --older-than SECONDS   age gate for finished records (default ${DEFAULT_CLEAN_OLDER_THAN_SECONDS})
  --all-terminal         remove every finished record regardless of age
  -h, --help             show this help
`;

function fail(message: string, code = 2): never {
	process.stderr.write(`${message}\n`);
	process.exit(code);
}

function hostInfo(env: NodeJS.ProcessEnv, cwd: string, label?: string): HostInfo {
	const sessionId = env.PI_SESSION_ID;
	const host: HostInfo = {
		cwd,
		label: label ?? (sessionId ? `${path.basename(cwd)}:${sessionId.slice(0, 8)}` : path.basename(cwd)),
	};
	if (sessionId) host.sessionId = sessionId;
	if (env.PI_SESSION_FILE) host.sessionFile = env.PI_SESSION_FILE;
	return host;
}

/** The worker whose window this process runs in, from the tmux window option. */
function currentWorkerId(env: NodeJS.ProcessEnv): string | undefined {
	if (!env.TMUX_PANE) return undefined;
	const windowId = windowIdForPane(env.TMUX_PANE);
	if (!windowId) return undefined;
	const id = getWindowOption(windowId, WORKER_WINDOW_OPTION);
	// Window options are writable by any process in the session (including a worker with bash),
	// so an id that is not shaped like an id is refused rather than passed to a shell binding.
	return id && /^[A-Za-z0-9_.-]{1,64}$/.test(id) ? id : undefined;
}

function targetId(idOrPrefix: string | undefined, useCurrent: boolean, env: NodeJS.ProcessEnv, what: string): string {
	if (useCurrent) {
		const current = currentWorkerId(env);
		if (!current) fail(`${what} --current needs to run in a worker window (no @pi_worker_id on this one)`);
		return current;
	}
	if (!idOrPrefix) fail(`${what} requires <id> or --current`);
	return idOrPrefix;
}

function resolveRecord(idOrPrefix: string, env: NodeJS.ProcessEnv): WorkerRecord {
	const direct = readRecord(idOrPrefix, env);
	if (direct) return direct;
	const matches = listRecords(env).filter(({ record }) => record.id.startsWith(idOrPrefix));
	if (matches.length === 1) return matches[0]!.record;
	if (matches.length > 1) throw new Error(`ambiguous id prefix "${idOrPrefix}": ${matches.map((item) => item.record.id).join(", ")}`);
	throw new Error(`no worker record matches "${idOrPrefix}"`);
}

async function control(idOrPrefix: string, request: ControlRequest, env: NodeJS.ProcessEnv): Promise<unknown> {
	const record = resolveRecord(idOrPrefix, env);
	const by = `cli:${env.PI_SESSION_ID?.slice(0, 8) ?? "shell"}`;
	let response;
	try {
		response = await sendControl(record.supervisor.socket, { ...request, by });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`worker ${record.id} is not running: its supervisor socket is gone (it may have finished — check 'pi-orch status ${record.id}')`);
		}
		throw error;
	}
	if (!response.ok) throw new Error(response.error ?? "control command failed");
	return response.data;
}

function buildRunOptions(values: Record<string, unknown>, profile: string, env: NodeJS.ProcessEnv, command: "run" | "check"): RunOptions {
	const cwd = values.cwd as string | undefined;
	const runDir = values["run-dir"] as string | undefined;
	if (!cwd || !runDir) fail("--cwd and --run-dir are required");
	const promptFile = values["prompt-file"] as string | undefined;
	const promptText = values.prompt as string | undefined;
	if (command === "run" && !promptFile && !promptText) fail("--prompt-file or --prompt is required");

	const profilesFile = resolveProfilesPath(values.profiles as string | undefined, env);
	if (!profilesFile) {
		fail(`No profiles.json found. Tried:\n  ${profilesCandidates(env).join("\n  ")}\nPass --profiles FILE or set PI_ORCH_PROFILES.`);
	}
	const selection = selectProfile(loadProfiles(profilesFile), profile, values.thinking as string | undefined);

	const tools = ((values.tools as string | undefined) ?? "read") as ToolSet;
	if (!["read", "write", "none"].includes(tools)) fail(`invalid --tools value: ${tools}`);
	const trust = ((values.trust as string | undefined) ?? "saved") as RunOptions["trust"];
	if (!["saved", "project", "ignore"].includes(trust)) fail(`invalid --trust value: ${trust}`);
	const inputPolicy = ((values.input as string | undefined) ?? "fail") as RunOptions["inputPolicy"];
	if (!["fail", "park"].includes(inputPolicy)) fail(`invalid --input value: ${inputPolicy}`);
	const timeoutSeconds = values.timeout === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(values.timeout);
	if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) fail("--timeout must be a positive number of seconds");

	const options: RunOptions = {
		command,
		profile,
		selection,
		cwd: path.resolve(cwd),
		runDir: path.resolve(runDir),
		tools,
		trust,
		timeoutMs: timeoutSeconds * 1000,
		pi: (values.pi as string | undefined) ?? "pi",
		inputPolicy,
		host: hostInfo(env, path.resolve(cwd), values.label as string | undefined),
		env,
	};
	if (command === "check") {
		options.promptText = "(runtime check: selection verified, no inference)";
		options.requireDod = false;
		options.minBriefChars = 0;
	} else if (promptFile) options.promptFile = path.resolve(promptFile);
	else if (promptText) options.promptText = promptText;
	if (typeof values.session === "string") options.session = path.resolve(values.session);
	if (typeof values.log === "string") options.logPath = path.resolve(values.log);
	if (values["max-parallel"] !== undefined) options.maxParallel = Number(values["max-parallel"]);
	if (values["allow-shared-cwd"] === true) options.allowSharedCwd = true;
	if (typeof values.id === "string") options.id = values.id;
	if (values["no-log-check"] === true) options.logPath = undefined;
	const requireDod = values["require-dod"] === true ? true : values["no-require-dod"] === true ? false : undefined;
	if (requireDod !== undefined) options.requireDod = requireDod;
	if (command === "check") options.requireDod = false;
	// Started by a tmux window: own that window only if it is verifiably ours. A worker that
	// spawns `pi-orch run` from its shell inherits PI_ORCH_WINDOW and TMUX_PANE, and without
	// this check the nested run would rename and relabel the window of its parent.
	if (env.PI_ORCH_WINDOW === "1" && env.TMUX_PANE) {
		const windowId = windowIdForPane(env.TMUX_PANE);
		if (windowId && ownsWindow(windowId, options.id, options.profile)) options.window = { windowId, paneId: env.TMUX_PANE };
	}
	return options;
}

/**
 * Is this window the one created for this worker? Verified against the worker id in its
 * metadata, or - before that metadata is written - against the deterministic window name.
 */
function ownsWindow(windowId: string, id: string | undefined, profile: string | undefined): boolean {
	if (!id) return false;
	const owner = getWindowOption(windowId, WORKER_WINDOW_OPTION);
	if (owner) return owner === id;
	return windowName(windowId) === workerWindowName({ id, profile });
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Start a run in a detached supervisor and wait until its record is published. */
async function detachedRun(rawArgs: string[], options: RunOptions): Promise<number> {
	ensureStateDirs(options.env);
	const id = options.id ?? newWorkerId();
	const logDir = path.join(stateDir(options.env), "logs");
	fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
	const logFile = path.join(logDir, `${id}.log`);
	const fd = fs.openSync(logFile, "a", 0o600);
	const args: string[] = [];
	for (let index = 0; index < rawArgs.length; index++) {
		const item = rawArgs[index]!;
		if (item === "--detach") continue;
		if (item === "--id") {
			index++;
			continue;
		}
		if (item.startsWith("--id=")) continue;
		args.push(item);
	}
	args.push("--id", id);
	const child = spawn(process.execPath, [process.argv[1] ?? "", ...args], {
		detached: true,
		stdio: ["ignore", fd, fd],
		cwd: process.cwd(),
		env: options.env,
	});
	// Asynchronous spawn failures (missing execPath, EACCES, EMFILE) must be a message, not a crash.
	let spawnError: Error | undefined;
	child.on("error", (error) => {
		spawnError = error;
	});
	fs.closeSync(fd);
	const file = recordPath(id, options.env);
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		if (fs.existsSync(file)) {
			child.unref();
			process.stdout.write(`${JSON.stringify({ status: "started", id, record: file, log: logFile })}\n`);
			return 0;
		}
		if (spawnError || child.exitCode !== null) break;
		await sleep(120);
	}
	child.unref();
	let detail = "";
	try {
		detail = readTail(logFile, 4000).trim();
	} catch {
		detail = "(no supervisor log)";
	}
	process.stderr.write(`detached supervisor failed to start${spawnError ? `: ${spawnError.message}` : detail ? `:\n${detail}` : ""}\n`);
	return 1;
}

/**
 * Host the worker in a named tmux window. The window's process is the supervisor
 * itself, so the operator can watch it; the caller returns as soon as the record is
 * published, exactly like a detached launch.
 */
async function windowRun(rawArgs: string[], options: RunOptions, mode: "auto" | "always" | "never"): Promise<number | undefined> {
	if (!tmuxReady()) {
		if (mode === "always") {
			const started = tmuxReady() ? true : false;
			if (!started) {
				process.stderr.write("--window always needs a reachable tmux server (or use --detach)\n");
				return 1;
			}
		}
		return undefined;
	}
	if (!supportsEnvFlag()) {
		process.stderr.write(`tmux ${tmuxVersion() ?? "?"} cannot pass environment to a new window (needs 3.2+); running the worker without a window\n`);
		return undefined;
	}
	const id = options.id ?? newWorkerId();
	const name = workerWindowName({ id, profile: options.profile });
	const args = stripRunFlags(rawArgs, ["--window", "--detach", "--id"]);
	args.push("--id", id);
	const cli = readCliPointer(options.env) ?? process.argv[1] ?? "pi-orch";
	// The child learns its window from tmux itself (TMUX_PANE), so the ids never have to
	// be threaded through the command line.
	const pane = openWindow({
		name,
		command: [process.execPath, cli, ...args],
		cwd: options.env.PWD ?? process.cwd(),
		// Keep the pane after the worker ends so the final output stays readable.
		remainOnExit: true,
		env: windowEnv(options.env),
	});
	if (!pane) {
		process.stderr.write("could not open a tmux window for the worker\n");
		return undefined;
	}
	setWindowOption(pane.windowId, WORKER_WINDOW_OPTION, id);
	// The child may still fail (reused run dir, brief rejection, a bad --pi). Poll for its record
	// the way a detached launch does, so a failed window launch exits non-zero instead of
	// reporting "started" for a run that never began.
	const record = recordPath(id, options.env);
	const deadline = Date.now() + Number(options.env.PI_ORCH_WINDOW_START_TIMEOUT_MS ?? 20_000);
	while (Date.now() < deadline) {
		if (fs.existsSync(record)) {
			process.stdout.write(`${JSON.stringify({ status: "started", id, record, window: pane.windowId, pane: pane.paneId })}\n`);
			return 0;
		}
		await sleep(120);
	}
	const tail = capturePane(pane.paneId, 12);
	process.stderr.write(`windowed supervisor failed to start${tail ? `:\n${tail}` : ""}\n`);
	return 1;
}

function terminal(state: string): boolean {
	return ["completed", "failed", "stopped", "timeout"].includes(state);
}

function printList(env: NodeJS.ProcessEnv, json: boolean, all: boolean): void {
	const now = Date.now();
	const items = listRecords(env, { staleMs: readConfig(env).staleMs })
		.map(({ record, stale }) => summarise(record, stale, now))
		.filter((summary) => all || !terminal(summary.state) || summary.idleSeconds < 900)
		.sort((a, b) => b.ageSeconds - a.ageSeconds);
	if (json) {
		process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
		return;
	}
	if (items.length === 0) {
		process.stdout.write("no workers\n");
		return;
	}
	for (const summary of items) {
		const activity = summary.tool ?? summary.toolDetail ?? summary.text?.slice(-60) ?? summary.outcome ?? "";
		process.stdout.write(
			`${summary.id}  ${summary.state.padEnd(14)} ${summary.profile.padEnd(18)} ${summary.thinking.padEnd(6)} ${String(summary.ageSeconds).padStart(5)}s  ${summary.hostLabel.padEnd(20)} ${activity}\n`,
		);
	}
}

function printStatus(record: WorkerRecord, json: boolean): void {
	if (json) {
		process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
		return;
	}
	const lines = [
		`${record.id}  ${record.state} (${record.phase})`,
		`profile   ${record.worker.profile} · ${record.worker.provider}/${record.worker.model} · thinking ${record.worker.thinking} · tools ${record.worker.tools}`,
		`host      ${record.host.label}${record.host.sessionId ? ` (${record.host.sessionId})` : ""}`,
		`cwd       ${record.worker.cwd}`,
		`session   ${record.worker.sessionFile}`,
		`run       ${record.runDir}`,
		`deadline  ${record.deadline.seconds}s (expires ${record.deadline.expiresAt})`,
		`activity  ${record.phase}${record.activity.tool ? ` · ${record.activity.tool}` : ""}${record.activity.toolDetail ? ` · ${record.activity.toolDetail}` : ""}`,
		`usage     turns ${record.activity.turns} · tools ${record.activity.toolCalls} (${record.activity.toolErrors} errors) · $${record.activity.cost.toFixed(4)}`,
		`controls  ${record.controls.steers} steers${record.controls.lastSteerBy ? ` (last by ${record.controls.lastSteerBy})` : ""}`,
	];
	if (record.brief.outcome) lines.push(`outcome   ${record.brief.outcome}`);
	if (record.pendingInput) lines.push(`WAITING   ${record.pendingInput.method}: ${record.pendingInput.title ?? record.pendingInput.message ?? ""}`);
	if (record.error) lines.push(`error     ${record.error}`);
	if (record.result) lines.push(`result    ${record.result.status} · ${record.result.path}`);
	process.stdout.write(`${lines.join("\n")}\n`);
}

/** Environment a worker window needs, since a tmux server does not inherit ours. */
function windowEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const passthrough = [
		"PATH", "HOME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "USER", "TERM", "PI_CODING_AGENT_DIR",
		// A windowed worker must reach the same network and trust the same certificates as a
		// foreground one; without these a proxied/TLS-intercepted machine breaks only in a window.
		"HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
		"NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
	];
	const out: Record<string, string> = {};
	for (const key of passthrough) {
		const value = env[key];
		if (value !== undefined) out[key] = value;
	}
	// Every PI_* name is forwarded because that is where this tool and Pi keep their own
	// settings and credentials; they end up in the tmux window's environment (readable by any
	// process in that pane, and in `ps` for the duration of the call).
	for (const [key, value] of Object.entries(env)) {
		if (key.startsWith("PI_") && value !== undefined) out[key] = value;
	}
	// Anything else must be named explicitly rather than dumping the whole environment.
	for (const key of (env.PI_ORCH_WINDOW_ENV ?? "").split(",").map((item) => item.trim()).filter(Boolean)) {
		const value = env[key];
		if (value !== undefined) out[key] = value;
	}
	// Marks the child supervisor as already hosted, so it never opens a second window.
	out.PI_ORCH_WINDOW = "1";
	return out;
}

function stripRunFlags(argv: string[], names: string[]): string[] {
	const out: string[] = [];
	for (let index = 0; index < argv.length; index++) {
		const item = argv[index]!;
		if (names.some((name) => item === name)) {
			if (item === "--id" || item === "--window") index++;
			continue;
		}
		if (names.some((name) => item.startsWith(`${name}=`))) continue;
		out.push(item);
	}
	return out;
}

/**
 * Window mode changes the process model: the worker runs in a tmux window and the caller
 * returns as soon as the record exists. It is therefore opt-in - `--window`, config
 * `tmux.windows`, or the extension's spawn (which passes "auto" for a human operator) -
 * and never inferred from the mere presence of a tmux server.
 */
function resolveWindowMode(requested: string | undefined, env: NodeJS.ProcessEnv): "auto" | "always" | "never" {
	if (env.PI_ORCH_WINDOW) return "never";
	const configured = readConfig(env).tmux?.windows ?? "never";
	const mode = (requested as "auto" | "always" | "never" | undefined) ?? configured;
	return mode === "always" || mode === "never" || mode === "auto" ? mode : "never";
}

async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	const command = argv[0];
	if (!command || command === "--help" || command === "-h" || command === "help") {
		process.stdout.write(USAGE);
		return command ? 0 : 2;
	}
	if (process.env.PI_ORCH_TMUX_SOCKET) setTmuxSocket(process.env.PI_ORCH_TMUX_SOCKET);
	const env = process.env;
	writeCliPointer(process.argv[1] ?? "pi-orch", env);

	if (command === "run" || command === "check") {
		const { values, positionals } = parseArgs({
			args: argv.slice(1),
			allowPositionals: true,
			options: {
				cwd: { type: "string" },
				"run-dir": { type: "string" },
				"prompt-file": { type: "string" },
				prompt: { type: "string" },
				session: { type: "string" },
				thinking: { type: "string" },
				tools: { type: "string" },
				trust: { type: "string" },
				timeout: { type: "string" },
				pi: { type: "string" },
				input: { type: "string" },
				log: { type: "string" },
				"no-log-check": { type: "boolean" },
				"max-parallel": { type: "string" },
				"allow-shared-cwd": { type: "boolean" },
				"require-dod": { type: "boolean" },
				"no-require-dod": { type: "boolean" },
				detach: { type: "boolean" },
				window: { type: "string" },
				id: { type: "string" },
				label: { type: "string" },
				profiles: { type: "string" },
				json: { type: "boolean" },
			},
		});
		const profile = positionals[0];
		if (!profile) fail(`${command} requires a profile`);
		const options = buildRunOptions(values as Record<string, unknown>, profile, env, command);
		// A fresh workspace is a normal thing to name, so `run` creates it; `check` stays
		// side-effect free, and both entry points (CLI and extension) behave the same. The
		// supervisor creates the run dir itself (non-recursive, to catch reuse), so its parent
		// has to exist too.
		if (command === "run") {
			fs.mkdirSync(path.resolve(options.cwd), { recursive: true, mode: 0o700 });
			fs.mkdirSync(path.dirname(path.resolve(options.runDir)), { recursive: true, mode: 0o700 });
		}
		const mode = resolveWindowMode(values.window as string | undefined, env);
		if (options.window) {
			// This process *is* the worker window's supervisor.
		}
		if (mode !== "never" && command === "run") {
			try {
				preflight(options);
			} catch (error) {
				process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
				return 1;
			}
			const started = await windowRun(argv, options, mode);
			if (started !== undefined) return started;
			if (mode === "always") return 1;
			// "auto" and tmux cannot host the window here: run normally instead.
		}
		if (values.detach === true) {
			// Fail fast in the caller: a detached supervisor's first error is not visible here.
			try {
				preflight(options);
			} catch (error) {
				process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
				return 1;
			}
			return detachedRun(argv, options);
		}
		const { report, exitCode } = await runWorker(options);
		if (values.json === true) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		else {
			process.stdout.write(
				`${JSON.stringify({ status: report.status, result: report.resultFile, record: report.recordFile, error: report.error })}\n`,
			);
		}
		// A failing worker must be visible to a shell caller, not only in the JSON line.
		if (report.error && report.status !== "completed" && report.status !== "ready") process.stderr.write(`${report.error}\n`);
		return exitCode;
	}

	if (command === "list") {
		const { values } = parseArgs({ args: argv.slice(1), options: { json: { type: "boolean" }, all: { type: "boolean" } } });
		printList(env, values.json === true, values.all === true);
		return 0;
	}

	if (command === "status") {
		const { values, positionals } = parseArgs({
			args: argv.slice(1),
			allowPositionals: true,
			options: { json: { type: "boolean" } },
		});
		const id = positionals[0];
		if (!id) {
			printList(env, values.json === true, false);
			return 0;
		}
		printStatus(resolveRecord(id, env), values.json === true);
		return 0;
	}

	if (command === "steer" || command === "follow-up") {
		const { values, positionals } = parseArgs({
			args: argv.slice(1),
			allowPositionals: true,
			options: { current: { type: "boolean" } },
		});
		const id = targetId(positionals[0], values.current === true, env, command);
		const message = positionals.slice(values.current === true || !positionals[0] ? 0 : 1).join(" ");
		if (!message) fail(`${command} requires a message`);
		const data = await control(id, { cmd: command === "steer" ? "steer" : "follow_up", message }, env);
		process.stdout.write(`${JSON.stringify({ ok: true, id, data })}\n`);
		return 0;
	}

	if (command === "stop" || command === "abort") {
		const { values, positionals } = parseArgs({
			args: argv.slice(1),
			allowPositionals: true,
			options: { current: { type: "boolean" }, close: { type: "boolean" } },
		});
		const id = targetId(positionals[0], values.current === true, env, command);
		const data = await control(id, { cmd: command === "stop" ? "stop" : "abort" }, env);
		// Worker windows are never reaped by the spine, so give the operator a way to close one.
		const windowId = values.close === true ? resolveRecord(id, env).tmux?.windowId : undefined;
		const closed = windowId ? killWindow(windowId) : false;
		process.stdout.write(`${JSON.stringify({ ok: true, id, data, ...(closed ? { closedWindow: windowId } : {}) })}\n`);
		return 0;
	}

	if (command === "answer") {
		const { values, positionals } = parseArgs({
			args: argv.slice(1),
			allowPositionals: true,
			options: { cancel: { type: "boolean" }, current: { type: "boolean" } },
		});
		const id = targetId(positionals[0], values.current === true, env, "answer");
		const valueFrom = values.current === true ? 0 : 1;
		const request: ControlRequest =
			values.cancel === true ? { cmd: "answer", cancelled: true } : { cmd: "answer", value: positionals.slice(valueFrom).join(" ") };
		const data = await control(id, request, env);
		process.stdout.write(`${JSON.stringify({ ok: true, id, data })}\n`);
		return 0;
	}

	if (command === "tail" || command === "logs") {
		const { values, positionals } = parseArgs({
			args: argv.slice(1),
			allowPositionals: true,
			options: { lines: { type: "string" } },
		});
		const id = positionals[0];
		if (!id) fail(`${command} requires <id>`);
		const record = resolveRecord(id, env);
		const lines = values.lines ? Number(values.lines) : 40;
		if (command === "tail") {
			process.stdout.write(`${formatTranscript(readTranscript(record.runDir, { limit: lines })).join("\n")}\n`);
		} else {
			const text = readTail(`${record.runDir}/events.jsonl`, 256 * 1024).split("\n").filter(Boolean).slice(-lines);
			process.stdout.write(`${text.join("\n")}\n`);
		}
		return 0;
	}

	if (command === "rm") {
		const { positionals } = parseArgs({ args: argv.slice(1), allowPositionals: true, options: {} });
		const id = positionals[0];
		if (!id) fail("rm requires <id>");
		const record = resolveRecord(id, env);
		if (activeWorkers(env).some((item) => item.id === record.id)) fail(`worker ${record.id} is still active; stop it first`);
		removeRecord(record.id, env);
		process.stdout.write(`${JSON.stringify({ removed: record.id })}\n`);
		return 0;
	}

	if (command === "clean") {
		const { values } = parseArgs({
			args: argv.slice(1),
			options: {
				"older-than": { type: "string" },
				"all-terminal": { type: "boolean" },
				help: { type: "boolean", short: "h" },
			},
		});
		if (values.help === true) {
			process.stdout.write(CLEAN_USAGE);
			return 0;
		}
		const ageSeconds =
			values["older-than"] === undefined ? DEFAULT_CLEAN_OLDER_THAN_SECONDS : Number(values["older-than"]);
		if (!Number.isFinite(ageSeconds) || ageSeconds < 0) fail("--older-than must be a non-negative number of seconds");
		const result = cleanRecords(ageSeconds * 1000, env, { allTerminal: values["all-terminal"] === true });
		process.stdout.write(`${JSON.stringify(result)}\n`);
		return 0;
	}

	if (command === "profiles") {
		const { values } = parseArgs({
			args: argv.slice(1),
			options: { json: { type: "boolean" }, profiles: { type: "string" } },
		});
		const file = resolveProfilesPath(values.profiles as string | undefined, env);
		if (!file) fail("no profiles.json found");
		const profiles = loadProfiles(file);
		if (values.json === true) {
			process.stdout.write(`${JSON.stringify({ file, profiles }, null, 2)}\n`);
			return 0;
		}
		process.stdout.write(`${file}\n`);
		for (const name of profileNames(profiles)) {
			const entry = profiles.profiles[name]!;
			process.stdout.write(
				`${name.padEnd(20)} ${entry.provider}/${entry.model ?? "(mapped)"} thinking=${entry.thinking} allowed=${entry.allowed_thinking.join("|")}\n`,
			);
		}
		return 0;
	}

	if (command === "watch") {
		const { values, positionals } = parseArgs({
			args: argv.slice(1),
			allowPositionals: true,
			options: { follow: { type: "boolean" } },
		});
		const id = positionals[0];
		if (!id) fail("watch requires <id>");
		return await watchWorker(id, {
			follow: values.follow === true,
			env,
			onLines: (lines) => process.stdout.write(`${lines.join("\n")}\n`),
		});
	}

	if (command === "dash") {
		const { values } = parseArgs({
			args: argv.slice(1),
			options: {
				watch: { type: "boolean" },
				once: { type: "boolean" },
				interval: { type: "string" },
				"no-color": { type: "boolean" },
			},
		});
		const interval = Math.max(1, Number(values.interval ?? 2)) * 1000;
		const color = values["no-color"] !== true && Boolean(process.stdout.isTTY);
		const width = process.stdout.columns ?? 110;
		const draw = (): void => {
			const lines = renderBoard(env, width, { color });
			if (values.once === true) {
				process.stdout.write(`${lines.join("\n")}\n`);
				return;
			}
			process.stdout.write(`\x1b[2J\x1b[H${lines.join("\n")}\n`);
		};
		draw();
		if (values.once === true || values.watch !== true) return 0;
		return await new Promise<number>((resolve) => {
			const timer = setInterval(draw, interval);
			const stop = (): void => {
				clearInterval(timer);
				process.stdout.write("\n");
				resolve(0);
			};
			process.on("SIGINT", stop);
			process.on("SIGTERM", stop);
		});
	}

	if (command === "statusline") {
		process.stdout.write(`${statusline(env)}\n`);
		return 0;
	}

	if (command === "windows") {
		const { values } = parseArgs({ args: argv.slice(1), options: { json: { type: "boolean" } } });
		const windows = listWindows().filter((window) => window.workerId);
		if (values.json === true) {
			process.stdout.write(`${JSON.stringify(windows, null, 2)}\n`);
			return 0;
		}
		if (windows.length === 0) {
			process.stdout.write("no worker windows\n");
			return 0;
		}
		for (const window of windows) {
			process.stdout.write(`${window.workerId}  ${window.id}  ${window.paneId}  ${window.active ? "active" : "      "}  ${window.name}\n`);
		}
		return 0;
	}

	if (command === "focus") {
		const { values, positionals } = parseArgs({
			args: argv.slice(1),
			allowPositionals: true,
			options: { current: { type: "boolean" } },
		});
		const id = targetId(positionals[0], values.current === true, env, "focus");
		const record = resolveRecord(id, env);
		const target = findWorkerWindow(record.id)?.id ?? record.tmux?.windowId;
		if (!target) fail(`worker ${record.id} has no tmux window`);
		if (!focusWindow(target)) fail(`could not focus ${target}`);
		process.stdout.write(`${JSON.stringify({ ok: true, id: record.id, window: target })}\n`);
		return 0;
	}

	if (command === "pane") {
		const { values, positionals } = parseArgs({
			args: argv.slice(1),
			allowPositionals: true,
			options: { "new-window": { type: "boolean" }, size: { type: "string" }, horizontal: { type: "boolean" }, current: { type: "boolean" } },
		});
		const id = targetId(positionals[0], values.current === true, env, "pane");
		const record = resolveRecord(id, env);
		const cli = readCliPointer(env) ?? process.argv[1] ?? "pi-orch";
		const watchArgs = [readCliPointer(env) ? process.execPath : "", cli, "watch", record.id, "--follow"].filter(Boolean);
		if (values["new-window"] === true) {
			const pane = openWindow({ name: `watch ${record.id.slice(2, 8)}`, command: watchArgs, cwd: process.cwd(), env: windowEnv(env) });
			if (!pane) fail("could not open a watch window");
			process.stdout.write(`${JSON.stringify({ ok: true, id: record.id, window: pane.windowId, pane: pane.paneId })}\n`);
			return 0;
		}
		const pane = splitPane({ command: watchArgs, cwd: process.cwd(), horizontal: values.horizontal === true, size: values.size as string | undefined, env: windowEnv(env) });
		if (!pane) fail("could not open a watch pane (is this running inside tmux?)");
		process.stdout.write(`${JSON.stringify({ ok: true, id: record.id, pane })}\n`);
		return 0;
	}

	if (command === "tmux-setup") {
		const cli = readCliPointer(env) ?? process.argv[1] ?? "pi-orch";
		// Backslashes are literal inside tmux single quotes, so quote only when a path needs it.
		const plain = (value: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : shellQuote(value));
		const prefix = env.PI_ORCH_STATE_DIR ? `PI_ORCH_STATE_DIR=${plain(env.PI_ORCH_STATE_DIR)} ` : "";
		const call = (args: string): string => `${prefix}${plain(cli)} ${args}`;
		process.stdout.write(
			[
				"# pi-orch tmux configuration — append to ~/.tmux.conf, then: tmux source-file ~/.tmux.conf",
				"",
				"# 1. Live worker count and activity in the status bar",
				"set -g status-interval 3",
				`set -g status-right '#(${call("statusline")})  %H:%M '`,
				"",
				"# 2. The dashboard as a popup, with no Pi session running",
				`bind-key a display-popup -E -w 90% -h 70% -T ' pi-orch ' '${call("dash --watch")}'`,
				"",
				"# 3. Jump to a worker window by id (prefix + j)",
				`bind-key j command-prompt -p 'worker id:' "run-shell \\"${call("focus '%1'")}\\""`,
				"",
				"# 4. Live watch pane for the worker this window belongs to (prefix + w)",
				`bind-key w "run-shell \\"${call(`pane '#{@pi_worker_id}'`)}\\""`,
				"",
				"# 5. Steer this window's worker (prefix + s; queues after its current tool calls)",
				`bind-key s command-prompt -p 'steer:' "run-shell \\"${call(`steer '#{@pi_worker_id}' '%1'`)}\\""`,
				"",
				"# 6. Answer this window's worker when it asks a question (prefix + y)",
				`bind-key y command-prompt -p 'answer:' "run-shell \\"${call(`answer '#{@pi_worker_id}' '%1'`)}\\""`,
				"",
				"# 7. Worker windows are named by the spine; stop tmux renaming them",
				"set -g allow-rename off",
				"",
				"# Notes: bindings expand #{@pi_worker_id} from the current window (run-shell has no TMUX_PANE),",
				"# a watch pane labels its window so these bindings act on the worker you are watching, and",
				"# worker windows are opt-in (config tmux.windows or --window). A pane running a watcher has no",
				"# shell, so use the bindings rather than typing into it.",
			].join("\n") + "\n",
		);
		return 0;
	}

	function shellQuote(value: string): string {
		return `'${value.replace(/'/g, `'\\''`)}'`;
	}

	if (command === "doctor") {
		const file = resolveProfilesPath(undefined, env);
		const checks: string[] = [
			`node            ${process.version}`,
			`state dir       ${stateDir(env)} (${fs.existsSync(stateDir(env)) ? "exists" : "missing"})`,
			`cli pointer     ${readCliPointer(env) ?? "(unset)"}`,
			`profiles        ${file ?? "(not found)"}`,
			`home            ${os.homedir()}`,
		];
		if (file) {
			try {
				checks.push(`profiles count  ${profileNames(loadProfiles(file)).length}`);
			} catch (error) {
				checks.push(`profiles ERROR  ${(error as Error).message}`);
			}
		}
		const workers = activeWorkers(env);
		checks.push(`active workers  ${workers.length}${workers.length ? ` (${workers.map((item) => item.id).join(", ")})` : ""}`);
		const tmuxState = tmuxReady() ? `ready (${tmuxVersion()})` : "not available";
		checks.push(`tmux            ${tmuxState}${tmuxReady() ? ` · ${listWindows().filter((window) => window.workerId).length} worker window(s)` : ""}`);
		process.stdout.write(`${checks.join("\n")}\n`);
		return 0;
	}

	fail(`unknown command: ${command}\n\n${USAGE}`);
}

main()
	.then((code) => process.exit(code))
	.catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
